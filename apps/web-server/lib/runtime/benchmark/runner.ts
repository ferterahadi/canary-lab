import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import type { FeatureConfig, RepoPrerequisite } from '../../../../../shared/launcher/types'
import { runGit } from '../../git-repo'
import { encodeClaudeProjectDir } from '../../agent-session-log'
import { addWorktree, removeWorktree, type WorktreeHandle } from '../repo-worktree'
import { RunOrchestrator, defaultPlaywrightSpawner, buildServiceSpecs } from '../orchestrator'
import { estimateRunCost } from '../admission'
import { buildAgentSpawnCommand, buildOrchestratorHealPrompt, type HealAgent } from '../auto-heal'
import { generateRunId } from '../run-id'
import { runDirFor, buildRunPaths } from '../run-paths'
import { RunnerLog } from '../runner-log'
import { readManifest } from '../manifest'
import type { PtyFactory } from '../pty-spawner'
import { buildBenchmarkPaths, benchmarkDir } from './paths'
import { BenchmarkRunStore } from './store'
import { BenchmarkOrchestrator } from './orchestrator'
import { BenchmarkRace } from './race'
import { runSabotage } from './sabotage'
import { buildBaselineHealPrompt, baselinePlaywrightSpawner } from './arm-config'
import { loadBundledSabotageSkills } from './skills'
import type { ArmIterationResult } from './report'
import type { ArmMode, BenchmarkManifest, StartBenchmarkInput, StartBenchmarkResult } from './types'

// Wires the real I/O behind the (tested) BenchmarkOrchestrator: git worktrees,
// the sabotage agent, and per-arm RunOrchestrators. Built as a factory taking
// createServer's primitives so the server.ts edit stays tiny.

export interface BenchmarkRunnerDeps {
  projectRoot: string
  logsDir: string
  store: BenchmarkRunStore
  ptyFactory: PtyFactory
  /** The shared run-state sink so each arm (a real run) streams to /ws/runs. */
  runStore: unknown
  registry: { set(runId: string, orch: unknown): void; delete(runId: string): void }
  /** Resource admission — used to decide whether two arm runs can run at once
   *  or must be serialized on a busy box. */
  scheduler: { fits(candidate: { repoPaths: string[]; cost: number }): { ok: boolean } }
  attachRunStreams: (orch: RunOrchestrator, log: RunnerLog, feature: string, backups: null) => void
  allocateRunPorts: (feature: FeatureConfig, env: string | undefined) => Promise<Map<string, number> | undefined>
  applyFeatureEnvset: (featureDir: string, setName: string, portMap?: Map<string, number>) => unknown
  loadFeatures: () => FeatureConfig[]
  /** Resolve the heal/sabotage agent from project config (claude|codex). */
  pickAgent: () => HealAgent | null
  now: () => string
}

const ARM_MODE: Record<'A' | 'B', ArmMode> = { A: 'harness', B: 'baseline' }

export function createBenchmarkRunner(deps: BenchmarkRunnerDeps) {
  // benchmarkId → abort handle (kills the sabotage child + stops arm runs).
  const aborts = new Map<string, () => void>()

  async function startBenchmark(input: StartBenchmarkInput): Promise<StartBenchmarkResult> {
    // One benchmark at a time — a live one occupies the abort registry.
    if (aborts.size > 0) {
      throw Object.assign(
        new Error('A benchmark is already running — stop it before starting another.'),
        { statusCode: 409 },
      )
    }
    const found = deps.loadFeatures().find((f) => f.name === input.feature)
    if (!found) throw Object.assign(new Error(`feature not found: ${input.feature}`), { statusCode: 404 })
    const feature: FeatureConfig = found
    const agentChoice = deps.pickAgent()
    if (!agentChoice) throw Object.assign(new Error('No claude/codex CLI available for benchmark'), { statusCode: 409 })
    const agent: HealAgent = agentChoice

    const skills = loadBundledSabotageSkills()
    const skill = skills.find((s) => s.name === input.skill) ?? skills.find((s) => s.level === input.level)
    if (!skill) throw Object.assign(new Error(`sabotage skill not found: ${input.skill}`), { statusCode: 404 })

    const env = feature.envs?.[0]
    const repo0 = (feature.repos ?? [])[0]
    if (!repo0) throw Object.assign(new Error(`feature "${feature.name}" declares no repos to sabotage`), { statusCode: 409 })
    const repo: RepoPrerequisite = repo0

    // Worktrees only see COMMITTED files, so uncommitted edits to the feature's
    // code would silently benchmark a stale snapshot (this is exactly what bit
    // the untracked sample earlier). Scope the check to the feature dir so
    // unrelated repo-root churn (e.g. package.json from installs) doesn't block
    // a legitimate run. Refuse with a clear error before any work is done.
    const repoStatus = await runGit(repo.localPath, ['status', '--porcelain', '--', '.'])
    if (repoStatus.code !== 0) {
      throw Object.assign(
        new Error(`repo "${repo.name}" at ${repo.localPath} is not a git repository (worktrees require git)`),
        { statusCode: 409 },
      )
    }
    if (repoStatus.stdout.trim()) {
      throw Object.assign(
        new Error(
          `feature "${feature.name}" has uncommitted changes — commit or stash them before benchmarking (worktrees only see committed files)`,
        ),
        { statusCode: 409 },
      )
    }

    const benchmarkId = `bench-${generateRunId()}`
    const benchDir = benchmarkDir(deps.logsDir, benchmarkId)
    const paths = buildBenchmarkPaths(benchDir)
    fs.mkdirSync(benchDir, { recursive: true })

    const manifest: BenchmarkManifest = {
      benchmarkId,
      feature: feature.name,
      featureDir: feature.featureDir,
      skill: skill.name,
      level: skill.level,
      iterations: input.iterations,
      agent,
      status: 'sabotaging',
      startedAt: deps.now(),
      currentIteration: 0,
      arms: [
        { arm: 'A', mode: 'harness', runIds: [] },
        { arm: 'B', mode: 'baseline', runIds: [] },
      ],
      results: [],
    }
    deps.store.save(manifest)

    // Abort plumbing: abort() flips the flag (so the race loop stops + the run
    // is marked 'aborted'), kills the in-flight sabotage child, and stops any
    // live arm RunOrchestrators.
    let aborted = false
    const children = new Set<ChildProcess>()
    const orchRefs = new Set<RunOrchestrator>()
    aborts.set(benchmarkId, () => {
      aborted = true
      for (const c of children) { try { c.kill('SIGTERM') } catch { /* already gone */ } }
      for (const o of orchRefs) void o.stop('aborted').catch(() => {})
    })

    // Worktree handles created during setup so cleanup can remove them.
    const armHandles: Partial<Record<'A' | 'B', WorktreeHandle>> = {}
    let stagingHandle: WorktreeHandle | undefined

    const orchestrator = new BenchmarkOrchestrator({
      manifest,
      persist: (m) => deps.store.save(m),
      now: deps.now,
      isAborted: () => aborted,

      sabotage: async () => {
        const result = await runSabotage(skill.recipe, {
          isAborted: () => aborted,
          createStagingWorktree: async () => {
            stagingHandle = await addWorktree({
              repoName: repo.name,
              localPath: repo.localPath,
              worktreesDir: path.join(benchDir, 'worktrees', 'staging'),
            })
            // NOTE: do NOT symlink node_modules into staging — a `node_modules`
            // symlink isn't matched by the `node_modules/` gitignore pattern, so
            // `git add -A` in freeze() would commit it and corrupt the sabotage
            // SHA. The validity gate must instead boot the service via the
            // orchestrator (which handles deps) — see runner TODO.
            return stagingHandle.worktreeRoot
          },
          runSabotageAgent: async (wtRoot, recipe) => {
            const featureSub = path.relative(stagingHandle!.worktreeRoot, stagingHandle!.localPath)
            const cwd = featureSub ? path.join(wtRoot, featureSub) : wtRoot
            // For claude, pin a session id so we can locate the native session
            // JSONL and render it through the shared AgentSessionView (the same
            // timeline the Heal-agent tab + wizard use). Write the ref the
            // benchmark agent-session endpoint/WS resolve from.
            const sessionId = agent === 'claude' ? randomUUID() : undefined
            if (sessionId) writeBenchmarkClaudeRef(benchDir, cwd, sessionId)
            await runAgentHeadless(agent, recipe, cwd, path.join(benchDir, 'sabotage-agent.log'), children, sessionId)
          },
          testsUntouched: async (wtRoot) => {
            const res = await runGit(wtRoot, ['diff', '--name-only', 'HEAD'])
            const changed = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
            return !changed.some((f) => /(^|\/)e2e\//.test(f) || /\.spec\.[tj]s$/.test(f))
          },
          testsFail: async () => {
            // Sound validity gate: boot the services and run the suite ONCE with
            // no auto-heal. A no-op sabotage leaves the tests green (status
            // 'passed') → reject + retry; a real break makes them go red while
            // the app is up. (The old standalone `npx playwright test` booted no
            // services, so every test failed on connection-refused regardless of
            // the sabotage — it could never detect a no-op break.)
            linkNodeModules(stagingHandle!) // boot needs deps; freeze excludes the symlink
            const status = await runNoHealTrial(stagingHandle!)
            return status !== 'passed'
          },
          resetWorktree: async (wtRoot) => {
            await runGit(wtRoot, ['reset', '--hard'])
            await runGit(wtRoot, ['clean', '-fd'])
          },
          freeze: async (wtRoot) => {
            // Stage everything EXCEPT the node_modules symlink (not matched by
            // the `node_modules/` gitignore) and Playwright artifacts the
            // validity-gate trial run leaves behind — so sabotage.diff is just
            // the agent's source edits.
            await runGit(wtRoot, [
              'add', '-A', '--', '.',
              ':(exclude)node_modules',
              ':(exclude)test-results',
              ':(exclude)playwright-report',
              ':(exclude)blob-report',
              ':(exclude).cache',
            ])
            const staged = await runGit(wtRoot, ['diff', '--cached', '--name-only'])
            if (!staged.stdout.trim()) {
              throw new Error('sabotage produced no file changes to freeze (the agent did not edit the code)')
            }
            const commit = await runGit(wtRoot, [
              '-c', 'user.name=canary-lab', '-c', 'user.email=benchmark@canary-lab',
              'commit', '-m', `sabotage: ${skill.name}`, '--no-verify',
            ])
            if (commit.code !== 0) {
              throw new Error(`freeze commit failed: ${(commit.stderr || commit.stdout).trim()}`)
            }
            const rev = await runGit(wtRoot, ['rev-parse', 'HEAD'])
            return rev.stdout.trim()
          },
          captureDiff: async (wtRoot) => {
            const res = await runGit(wtRoot, ['show', '--no-color', 'HEAD'])
            return res.stdout
          },
        })
        return { sabotageSha: result.sabotageSha, diff: result.diff }
      },

      writeDiff: (diff) => {
        fs.writeFileSync(paths.sabotageDiffPath, diff)
        fs.writeFileSync(paths.sabotageRecipePath, skill.recipe)
      },

      setupArms: async (sabotageSha) => {
        for (const arm of ['A', 'B'] as const) {
          const handle = await addWorktree({
            repoName: repo.name,
            localPath: repo.localPath,
            worktreesDir: path.join(benchDir, 'worktrees', `arm-${arm}`),
            branch: sabotageSha,
          })
          linkNodeModules(handle)
          armHandles[arm] = handle
        }
      },

      runRace: async (ctx) => {
        // Admission: can the box host BOTH arm runs at once? If not, degrade to
        // sequential so we don't thrash a busy machine. (Arms run in isolated
        // worktrees → no repo collision; gate on resources only.)
        const perArmCost = estimateRunCost(buildServiceSpecs(feature, benchDir, env).length)
        const parallel = deps.scheduler.fits({ repoPaths: [], cost: perArmCost * 2 }).ok
        return new BenchmarkRace({
          iterations: input.iterations,
          sabotageSha: ctx.sabotageSha,
          parallel,
          onResult: ctx.onResult,
          onIterationComplete: ctx.onIterationComplete,
          onArmStart: ctx.onArmStart,
          isAborted: () => aborted,
          runArm: (arm, mode, iteration, onStart) => runArm(arm, mode, iteration, onStart),
          resetArms: async (sha) => {
            for (const arm of ['A', 'B'] as const) {
              const root = armHandles[arm]?.worktreeRoot
              if (!root) continue
              await runGit(root, ['reset', '--hard', sha])
              await runGit(root, ['clean', '-fd'])
            }
          },
        }).runRace()
      },

      cleanup: async () => {
        aborts.delete(benchmarkId)
        for (const h of [stagingHandle, armHandles.A, armHandles.B]) {
          if (h) await removeWorktree(h).catch(() => {})
        }
      },
    })

    // Validity-gate trial: a no-autoHeal RunOrchestrator that boots the
    // services and runs the suite once on the staging worktree, returning the
    // terminal status ('passed' = nothing broke, 'failed' = tests went red).
    // Not streamed to the UI (no attachRunStreams) — it's an internal check.
    async function runNoHealTrial(handle: WorktreeHandle): Promise<string> {
      const featureDir = handle.localPath
      const trialFeature: FeatureConfig = { ...feature, featureDir, repos: [{ ...repo, localPath: featureDir }] }
      const portMap = await deps.allocateRunPorts(trialFeature, env)
      if (env) {
        try { deps.applyFeatureEnvset(featureDir, env, portMap) } catch { /* best-effort */ }
      }
      const runId = generateRunId()
      const runDir = runDirFor(deps.logsDir, runId)
      const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)
      const orch = new RunOrchestrator({
        feature: trialFeature,
        env,
        runId,
        runDir,
        portMap,
        // NOTE: do NOT pass `worktrees: [handle]` — the orchestrator's stop()
        // removes any worktree it's handed, which would delete the staging
        // worktree before freeze. We point the service cwd at the worktree via
        // the repo's localPath instead; the benchmark owns the worktree's life.
        ptyFactory: deps.ptyFactory,
        runnerLog,
        executionType: 'run',
        runStateSink: deps.runStore as never,
        // No autoHeal → boots services, runs tests once, returns passed/failed.
      })
      orchRefs.add(orch)
      try {
        const status = await orch.runFullCycle()
        await orch.stop(status as never).catch(() => {})
        return status
      } catch {
        return 'failed' // couldn't complete the trial → treat as "did not pass"
      } finally {
        orchRefs.delete(orch)
        deps.registry.delete(runId)
      }
    }

    // One run per arm/iteration: a real RunOrchestrator in the arm's worktree.
    async function runArm(
      arm: 'A' | 'B',
      mode: ArmMode,
      iteration: number,
      onStart: (runId: string) => void,
    ): Promise<ArmIterationResult> {
      const handle = armHandles[arm]!
      const featureDir = handle.localPath
      const armFeature: FeatureConfig = { ...feature, featureDir, repos: [{ ...repo, localPath: featureDir }] }
      const portMap = await deps.allocateRunPorts(armFeature, env)
      if (env) {
        try { deps.applyFeatureEnvset(featureDir, env, portMap) } catch { /* best-effort */ }
      }
      const runId = generateRunId()
      const runDir = runDirFor(deps.logsDir, runId)
      const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)
      const buildCyclePrompt =
        mode === 'harness'
          ? buildOrchestratorHealPrompt({ agent, projectRoot: deps.projectRoot, runDir })
          : buildBaselineHealPrompt({ runDir })
      const orch = new RunOrchestrator({
        feature: armFeature,
        env,
        runId,
        runDir,
        portMap,
        // Service cwd is redirected via the repo's localPath (set above) — we do
        // NOT pass `worktrees` because the orchestrator's stop() removes handed
        // worktrees, which would delete the arm worktree between iterations and
        // break resetArms. The benchmark owns each worktree's lifecycle.
        ptyFactory: deps.ptyFactory,
        runnerLog,
        executionType: 'run',
        runStateSink: deps.runStore as never,
        autoHeal: {
          agent,
          buildSpawnCommand: ({ sessionId, resume, mcpOutputDir, promptFile }) =>
            buildAgentSpawnCommand(agent, {
              sessionId,
              resume,
              mcpOutputDir,
              mcpConfigFile: path.join(runDir, 'mcp-config.json'),
              promptFile,
            }),
          buildCyclePrompt,
        },
        ...(mode === 'baseline'
          ? { playwrightSpawner: baselinePlaywrightSpawner(defaultPlaywrightSpawner) }
          : {}),
      })
      deps.attachRunStreams(orch, runnerLog, armFeature.name, null)
      orchRefs.add(orch)
      // Publish the runId NOW (before the long heal loop) so the benchmark
      // manifest persists it and the UI can attach this arm's live run panel.
      onStart(runId)
      const started = Date.now()
      let status: string
      try {
        status = await orch.runFullCycle()
        await orch.stop(status as never).catch(() => {})
      } catch {
        status = 'aborted'
        await orch.stop('aborted').catch(() => {})
      } finally {
        orchRefs.delete(orch)
        deps.registry.delete(runId)
      }
      const finalManifest = readManifest(buildRunPaths(runDir).manifestPath)
      return {
        arm,
        iteration,
        healed: !aborted && status === 'passed',
        healCycles: finalManifest?.healCycles ?? 0,
        wallClockMs: Date.now() - started,
      }
    }

    // Kick off async — the route returns immediately with the id.
    void orchestrator.run().catch(() => { /* errors are captured into the manifest */ })
    return { benchmarkId }
  }

  /** Stop a running benchmark: kills the sabotage child + arm runs; the run is
   *  marked 'aborted'. No-op if the benchmark already finished. */
  function abort(benchmarkId: string): void {
    // Kill the in-flight sabotage child + stop arm runs (a no-op for an orphan
    // from a previous process — the registry is per-process). Then flip the
    // persisted manifest to 'aborted' immediately so Stop reflects right away,
    // even while the orchestrator unwinds. The orchestrator's abort guards stop
    // it from overwriting this state as the current phase winds down.
    aborts.get(benchmarkId)?.()
    const m = deps.store.get(benchmarkId)
    if (m && m.status !== 'done' && m.status !== 'aborted' && m.status !== 'error') {
      deps.store.save({ ...m, status: 'aborted', endedAt: deps.now() })
    }
  }

  return { startBenchmark, abort }
}

// --- helpers ---------------------------------------------------------------

// Sabotage / one-shot agent run, headless (no REPL): run the prompt to
// completion and resolve on exit. Permissions are auto-accepted because there
// is no human in this loop. `claude` gets a pinned `--session-id` so we can
// locate + render its native session log via AgentSessionView. Raw stdout is
// still teed to `sabotage-agent.log` (debug + the codex fallback view).
function runAgentHeadless(
  agent: HealAgent,
  prompt: string,
  cwd: string,
  logPath?: string,
  children?: Set<ChildProcess>,
  sessionId?: string,
): Promise<void> {
  return new Promise((resolve) => {
    const args =
      agent === 'claude'
        ? ['-p', prompt, '--dangerously-skip-permissions', ...(sessionId ? ['--session-id', sessionId] : [])]
        : ['exec', '--full-auto', prompt]
    let out: number | 'ignore' = 'ignore'
    if (logPath) {
      try { out = fs.openSync(logPath, 'a') } catch { out = 'ignore' }
    }
    const child = spawn(agent, args, {
      cwd,
      stdio: typeof out === 'number' ? ['ignore', out, out] : 'ignore',
    })
    children?.add(child)
    const done = () => {
      children?.delete(child)
      if (typeof out === 'number') { try { fs.closeSync(out) } catch { /* noop */ } }
      resolve()
    }
    child.on('close', done)
    child.on('error', done)
  })
}

// Write `<benchDir>/agent-session.json` pointing at the sabotage agent's native
// claude session log (path is fully determined by the real cwd + session id),
// so the benchmark agent-session endpoint/WS can serve it to AgentSessionView.
function writeBenchmarkClaudeRef(benchDir: string, cwd: string, sessionId: string): void {
  try {
    const realCwd = fs.realpathSync(cwd)
    const logPath = path.join(os.homedir(), '.claude', 'projects', encodeClaudeProjectDir(realCwd), `${sessionId}.jsonl`)
    const ref = { activeAgent: 'claude', sessions: { claude: { agent: 'claude', sessionId, logPath } } }
    fs.writeFileSync(path.join(benchDir, 'agent-session.json'), JSON.stringify(ref, null, 2))
  } catch {
    /* best-effort — the setup view falls back to the text log */
  }
}

// Git worktrees don't include gitignored deps, so the arm/staging worktrees have
// no node_modules — services (`npx tsx ...`) and Playwright can't run. Symlink
// the source repo's node_modules into the worktree root so resolution works.
function linkNodeModules(handle: WorktreeHandle): void {
  const src = path.join(handle.sourceRoot, 'node_modules')
  const dst = path.join(handle.worktreeRoot, 'node_modules')
  try {
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst, 'dir')
  } catch {
    /* best-effort — boot will surface a clearer error if deps are truly missing */
  }
}
