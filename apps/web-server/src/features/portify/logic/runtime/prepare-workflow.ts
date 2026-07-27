// Validating and setting up one port-ification workflow: git prerequisites,
// the scratch worktrees, the manifest, and the orchestrator with its injected
// I/O. Split out of runner.ts, where it was a 280-line closure inside
// `createPortifyRunner`; the factory's shared state now arrives as an explicit
// context instead of being captured.
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { type ChildProcess } from 'child_process'
import type { FeatureConfig, RepoPrerequisite } from '../../../../../../../shared/launcher/types'
import { runGit, resolveRepoPath, snapshotWorkingTree, getGitRoot } from '../../../../shared/git-repo'
import type { HealAgent } from '../../../runs/logic/runtime/auto-heal'
import { generateRunId } from '../../../runs/logic/runtime/run-id'
import { hydrateEnvsetIntoWorktrees } from '../../../runs/logic/runtime/env-switcher/worktree-hydrate'
import { PortifyOrchestrator } from './orchestrator'
import { buildPortifyPaths, portifyDir } from './paths'
import { createBranchAndWorktree, captureDiff, changedFiles, discardWorktree, portifyBranchName, applyOverlay, resetWorktree } from './git-ops'
import { runPortifyAgent, writePortifyClaudeRef } from './agent'
import { buildPortifyPrompt, buildPortifyRetryPrompt, buildPortifyFeedbackPrompt, type RepoEditTarget } from './prompt'
import { verifyDoubleBoot } from './verify'
import type { PortifyManifest, PortifyRepoState, PortifyProducer, PortifyExternalSession } from './types'

// Wires the real I/O behind the (tested) PortifyOrchestrator: a git branch +
// worktree per GIT ROOT, the port-ification agent, the double-boot verifier,
// and the commit/cancel actions the UI drives after run() parks at
// `ready-to-commit`.
//
// Multi-repo: repos are grouped by their git root. A feature can list several
// repos that live in ONE monorepo (different subpaths); git forbids the same
// branch checked out in two worktrees of one repo, so each git root gets ONE
// worktree and every member repo is edited inside it. Distinct roots get
import {
  buildSeededNote,
  buildSiblingOverlayIndex,
  canonicalConfigDiff,
  captureOverlayRepos,
  pickBorrowable,
  readFileOrNull,
  realpathOrSelf,
  restoreConfig,
  safeKey,
  type ActiveWorkflow,
  type GroupMember,
  type RepoGroup,
  type PortifyRunnerDeps,
} from './runner'

export interface PrepareWorkflowContext {
  deps: PortifyRunnerDeps
  active: Map<string, ActiveWorkflow>
  healthDeadlineMs: number
}

// Validate + set up a workflow (git checks, scratch worktrees, manifest, the
// orchestrator + its injected I/O) and register it in `active`. Shared by the
// local path (which then run()s the agent) and the external path (which parks
// at `editing` for the user's own client to edit the worktree in place). The
// caller resolves the feature + agent; this returns the live orchestrator so
// the caller decides run() vs startExternal().
export async function prepareWorkflow(
  ctx: PrepareWorkflowContext,
  feature: FeatureConfig,
  agent: HealAgent,
  opts: { maxAttempts?: number; producer: PortifyProducer; external?: PortifyExternalSession },
): Promise<{ workflowId: string; state: ActiveWorkflow; orchestrator: PortifyOrchestrator }> {
  const { deps, active, healthDeadlineMs } = ctx
  const repos: RepoPrerequisite[] = feature.repos ?? []
  if (repos.length === 0) throw Object.assign(new Error(`feature "${feature.name}" declares no repos`), { statusCode: 409 })

  // Validate each repo is a clean git working tree and resolve its git root.
  // Worktrees only see committed files, so a dirty tree would benchmark a
  // stale snapshot — refuse with a clear error (mirrors the benchmark guard).
  // Dirty repos are COLLECTED across the whole set before throwing: naming
  // only the first would send the user through a fix→retry→fail-on-the-next
  // loop when several repos are dirty at once.
  const byRoot = new Map<string, GroupMember[]>()
  const dirty: string[] = []
  for (const repo of repos) {
    const repoPath = resolveRepoPath(repo.localPath)
    const status = await runGit(repoPath, ['status', '--porcelain', '--', '.'])
    if (status.code !== 0) {
      throw Object.assign(new Error(`repo "${repo.name}" at ${repo.localPath} is not a git repository`), { statusCode: 409 })
    }
    if (status.stdout.trim()) {
      dirty.push(repo.name)
      continue
    }
    // `git status` above returned 0, so this path IS inside a work tree —
    // rev-parse --show-toplevel resolves the root.
    const sourceRoot = (await getGitRoot(repoPath))!
    const members = byRoot.get(sourceRoot) ?? []
    members.push({ name: repo.name, path: repo.localPath })
    byRoot.set(sourceRoot, members)
  }
  if (dirty.length > 0) {
    const label = dirty.length === 1 ? 'repo' : 'repos'
    throw Object.assign(
      new Error(`${label} ${dirty.map((n) => `"${n}"`).join(', ')} ${dirty.length === 1 ? 'has' : 'have'} uncommitted changes — commit or stash them first (worktrees only see committed files)`),
      { statusCode: 409 },
    )
  }
  // Group repos that share a git root into ONE worktree (git can't check out
  // the same branch in two worktrees of one repo).
  const groups: RepoGroup[] = [...byRoot.entries()].map(([sourceRoot, members], i) => ({
    key: `g${i}-${safeKey(path.basename(sourceRoot))}`,
    sourceRoot,
    snapshotRef: 'HEAD',
    members,
  }))

  const workflowId = `portify-${generateRunId()}`
  const dir = portifyDir(deps.logsDir, workflowId)
  const paths = buildPortifyPaths(dir)
  fs.mkdirSync(paths.verifyLogDir, { recursive: true })
  const branch = portifyBranchName(feature.name)
  const env = feature.envs?.[0]
  const configPath = path.join(feature.featureDir, 'feature.config.cjs')
  const originalConfig = readFileOrNull(configPath)
  // Persist the pre-edit config to disk so a startup reclaim can restore it
  // after a crash (the in-memory copy dies with the process).
  if (originalConfig != null) {
    try { fs.writeFileSync(paths.originalConfigPath, originalConfig) } catch { /* best-effort */ }
  }

  const manifest: PortifyManifest = {
    workflowId,
    feature: feature.name,
    featureDir: feature.featureDir,
    repos: repos.map((r) => ({ name: r.name, path: r.localPath })),
    env,
    agent,
    producer: opts.producer,
    ...(opts.external ? { external: opts.external } : {}),
    branch,
    status: 'planning',
    attempt: 0,
    maxAttempts: opts.maxAttempts && opts.maxAttempts > 0 ? opts.maxAttempts : 3,
    feedbackRounds: 0,
    startedAt: deps.now(),
  }
  deps.store.save(manifest)

  let aborted = false
  const children = new Set<ChildProcess>()
  // External edits happen in the user's own client — no local session to pin.
  const sessionId = opts.producer === 'internal' && agent === 'claude' ? randomUUID() : undefined
  const state: ActiveWorkflow = {
    groups,
    branch,
    feature: feature.name,
    configPath,
    originalConfig,
    configSnapshotRef: 'HEAD',
    seededFrom: [],
    abort: () => {
      aborted = true
      for (const c of children) { try { c.kill('SIGTERM') } catch { /* gone */ } }
    },
  }
  active.set(workflowId, state)

  const allMembers = (): GroupMember[] => state.groups.flatMap((g) => g.members)

  // Run the agent in the first group's worktree with a given prompt. `resume`
  // continues the pinned claude session (no-op for codex, which re-execs).
  const runAgentWithPrompt = async (prompt: string, resume: boolean): Promise<void> => {
    const cwd = state.groups[0].handle!.worktreeRoot
    if (sessionId) writePortifyClaudeRef(dir, cwd, sessionId)
    await runPortifyAgent({ agent, prompt, cwd, logPath: paths.agentLogPath, children, sessionId, resume })
  }

  const orchestrator = new PortifyOrchestrator({
    manifest,
    persist: (m) => deps.store.save(m),
    now: deps.now,
    isAborted: () => aborted,

    setup: async () => {
      const states: PortifyRepoState[] = []
      // Borrow: if another feature already saved a port overlay for the same
      // app (git root), pre-apply it so this workflow starts from the existing
      // rewrite instead of redoing it. Built once; matched per group below.
      const siblingOverlays = await buildSiblingOverlayIndex(deps.loadFeatures(), feature.name)
      for (const group of state.groups) {
        const wt = await createBranchAndWorktree({
          repoName: group.key,
          localPath: group.sourceRoot,
          worktreesDir: path.join(dir, 'worktrees'),
          branch,
        })
        group.handle = wt.handle
        group.snapshotRef = wt.snapshotRef
        for (const member of group.members) {
          // `group.sourceRoot` is symlink-resolved (git rev-parse --show-toplevel),
          // so resolve the member path the same way before diffing — otherwise a
          // symlinked ancestor (e.g. macOS /var → /private/var) makes path.relative
          // emit a bogus `../..` traversal and editPath points outside the worktree.
          const rel = path.relative(group.sourceRoot, realpathOrSelf(resolveRepoPath(member.path)))
          member.editPath = rel ? path.join(wt.handle.worktreeRoot, rel) : wt.handle.worktreeRoot
          states.push({ name: member.name, path: member.path, worktreePath: wt.handle.worktreeRoot, baseSha: wt.baseSha })
        }
        // Apply the borrowed patch AFTER snapshotRef is captured, so the
        // borrowed lines land in this feature's own captured diff/overlay
        // (self-contained). Borrowing is an optimization — never fatal.
        const borrowed = pickBorrowable(siblingOverlays.get(group.sourceRoot), wt.baseSha)
        if (borrowed) {
          const seedPatch = path.join(dir, `seed-${group.key}.patch`)
          try {
            fs.writeFileSync(seedPatch, borrowed.patch)
            const outcome = await applyOverlay(wt.handle.worktreeRoot, seedPatch)
            if (outcome.kind === 'ok') {
              state.seededFrom.push({ feature: borrowed.feature, repos: group.members.map((m) => m.name) })
            } else {
              // A conflict/error means we couldn't cleanly seed (base drift,
              // overlapping edits). `--3way` leaves conflict markers in the
              // files even on failure, so scrub the worktree back to a clean
              // HEAD before the agent edits from scratch — otherwise the
              // markers poison its edits and the captured diff.
              await resetWorktree(wt.handle.worktreeRoot)
            }
          } catch { /* best-effort seed */ }
          finally { try { fs.rmSync(seedPatch, { force: true }) } catch { /* gone */ } }
        }
      }
      // Baseline the canonical config (edited in place) before the agent runs.
      state.configSnapshotRef = (await snapshotWorkingTree(feature.featureDir)) ?? 'HEAD'
      return states
    },

    // Attempt-0 gate: a borrowed sibling overlay may already complete the
    // rewrite — the orchestrator verifies it before spending an agent run.
    seeded: () => state.seededFrom.length > 0,

    runAgent: async (attempt, failureDetail) => {
      // setup() ran (and fully succeeded) before any runAgent, so every
      // member has an editPath and every group a handle.
      const targets: RepoEditTarget[] = allMembers().map((m) => ({ name: m.name, editPath: m.editPath! }))
      const prompt = attempt === 1 || !failureDetail
        ? buildPortifyPrompt(feature, targets, buildSeededNote(state.seededFrom))
        : buildPortifyRetryPrompt(feature, failureDetail)
      await runAgentWithPrompt(prompt, attempt > 1)
    },

    // Revise pass: resume the session (claude) with the human's feedback.
    // Codex has no --resume, so it re-execs against the already-edited
    // worktree — context-light but it still sees and adjusts its prior work.
    runFeedbackAgent: async (feedback) => {
      await runAgentWithPrompt(buildPortifyFeedbackPrompt(feature, feedback), true)
    },

    captureDiff: async () => {
      const blocks: string[] = []
      for (const group of state.groups) {
        const d = await captureDiff(group.handle!.worktreeRoot, group.snapshotRef)
        if (d) blocks.push(`# repo: ${group.members.map((m) => m.name).join(', ')}\n${d}`)
      }
      const configDiff = await canonicalConfigDiff(feature.featureDir, state.configSnapshotRef)
      if (configDiff) blocks.push(`# feature config: ${feature.featureDir}\n${configDiff}`)
      return blocks.join('\n\n')
    },

    verify: async () => {
      // Reload the config so the agent's edits (declared slots, tokenized
      // health checks) are reflected. Source comes from each worktree.
      const fresh = deps.loadFeatures().find((f) => f.name === feature.name) ?? feature
      const overrides: Record<string, string> = {}
      for (const member of allMembers()) overrides[member.name] = member.editPath!
      // Hydrate the captured envset into the worktrees for the boot window:
      // worktrees are cut from committed HEAD, so without this the boots run
      // the CHECKED-IN config (e.g. a docker `db` datasource host) that the
      // real-path envset apply normally overwrites — an unfixable-by-the-
      // agent crash. `${port.*}` tokens stay verbatim (one shared file can't
      // carry two instances' port maps); restore() in `finally` keeps the
      // overlay diff `save()` captures afterwards ports-only.
      const hydrated = env
        ? hydrateEnvsetIntoWorktrees({
            featureDir: feature.featureDir,
            setName: env,
            roots: state.groups.map((g) => ({ sourceRoot: g.sourceRoot, worktreeRoot: g.handle!.worktreeRoot })),
          })
        : null
      try {
        const result = await verifyDoubleBoot(fresh, env, overrides, {
          ptyFactory: deps.ptyFactory,
          healthCheck: deps.healthCheck,
          healthPollIntervalMs: deps.healthPollIntervalMs,
          healthDeadlineMs,
          verifyLogDir: paths.verifyLogDir,
        })
        if (!result.ok && hydrated && hydrated.portTokenSlots.length > 0) {
          const hint =
            `NOTE: envset file(s) ${hydrated.portTokenSlots.join(', ')} carry \`\${port.*}\` tokens that stay ` +
            `UNRESOLVED during the double-boot (one shared file cannot serve two port maps). If a service reads ` +
            `that wiring from the file, move it to per-process injection (CLI arg / env var) — that is what ` +
            `port-ification verifies.`
          // A not-ok verify always carries a failure detail (see verifyDoubleBoot).
          result.failureDetail = `${result.failureDetail}\n\n${hint}`
        }
        return result
      } finally {
        hydrated?.restore()
      }
    },

    checkTestsUntouched: async () => {
      const offending: string[] = []
      for (const group of state.groups) {
        const changed = await changedFiles(group.handle!.worktreeRoot, group.snapshotRef)
        offending.push(...changed.filter((f) => /(^|\/)e2e\//.test(f) || /\.spec\.[tj]s$/.test(f)).map((f) => `${group.key}:${f}`))
      }
      return { ok: offending.length === 0, offending }
    },

    // Restart survival for the parked review: snapshot the verified diff in
    // save()'s exact overlay shape so a post-restart save can still write the
    // overlay after the worktrees are gone (see paths.pendingOverlayPath).
    persistReviewCapture: async () => {
      try {
        const repos = await captureOverlayRepos(state)
        fs.writeFileSync(
          paths.pendingOverlayPath,
          JSON.stringify({ version: 1, capturedAt: deps.now(), repos, originalConfig: state.originalConfig }, null, 2),
        )
      } catch { /* best-effort — the live save path never needs the capture */ }
    },

    cleanup: async () => {
      // Reached only on failed/aborted: discard every worktree + branch and
      // restore the canonical config we edited in place.
      for (const group of state.groups) {
        if (group.handle) await discardWorktree(group.handle, branch)
      }
      restoreConfig(state)
      active.delete(workflowId)
    },
  })

  state.orchestrator = orchestrator
  return { workflowId, state, orchestrator }
}
