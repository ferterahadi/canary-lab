import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { PaneBroker } from './logic/pane-broker'
import { createRegistry, RunStore, type OrchestratorRegistry } from './logic/run-store'
import { buildRunPaths, runDirFor } from './logic/runtime/run-paths'
import type { RunManifest } from './logic/runtime/manifest'
import { MODE_COPY } from './logic/runtime/auto-heal'
import { buildRunScheduling } from './run-scheduling'
import { buildRunsRouteDeps, type RunsRouteDepsParts } from './runs-route-deps'
import type { ServerContext } from '../../server-context'
import type { BackupRecord } from './logic/runtime/env-switcher/types'
import type { PtyFactory } from './logic/runtime/pty-spawner'

/**
 * The two mocked edges, and why they are the only two.
 *
 * `RunOrchestrator` is this module's process-spawning boundary: constructing one
 * is bookkeeping, but `runFullCycle`/`bootOnly`/`restartTerminalRun` boot every
 * service, launch Playwright and spawn a heal-agent PTY. Its own behaviour is
 * covered by the `orchestrator.*.test.ts` suites beside it, so here it is a fake
 * — which is also the only way to reach the construction-failure arms, since the
 * real constructor has no input that makes it throw. `importOriginal` is spread
 * back in because `buildServiceSpecs` / `buildQueuedServiceEntries` /
 * `collectPortSlots` come off this same module id and must stay real: they are
 * what turns a feature config into the run's cost estimate and queued manifest.
 */
const orchHarness = vi.hoisted(() => ({
  constructFails: null as string | null,
  stopFails: null as string | null,
  options: [] as Record<string, unknown>[],
  instances: [] as { runId: string }[],
  stops: [] as (string | undefined)[],
  // Held by default: `registry.set` runs on the line AFTER the driving promise
  // is handed to `settleOrchestratorRun`, so a promise that settles eagerly
  // would delete the registry entry before a test could observe it.
  boot: (): Promise<void> => new Promise(() => { /* held */ }),
  cycle: (): Promise<string> => new Promise(() => { /* held */ }),
  restart: (): Promise<string> => new Promise(() => { /* held */ }),
}))

vi.mock('./logic/runtime/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logic/runtime/orchestrator')>()
  class FakeRunOrchestrator {
    readonly runId: string

    constructor(readonly opts: Record<string, unknown>) {
      if (orchHarness.constructFails) throw new Error(orchHarness.constructFails)
      this.runId = opts.runId as string
      orchHarness.options.push(opts)
      orchHarness.instances.push(this)
    }

    bootOnly(): Promise<void> { return orchHarness.boot() }
    runFullCycle(): Promise<string> { return orchHarness.cycle() }
    restartTerminalRun(): Promise<string> { return orchHarness.restart() }
    stop(status?: string): Promise<void> {
      orchHarness.stops.push(status)
      return orchHarness.stopFails
        ? Promise.reject(new Error(orchHarness.stopFails))
        : Promise.resolve()
    }
  }
  return { ...actual, RunOrchestrator: FakeRunOrchestrator }
})

/**
 * Agent-CLI discovery is the second edge: `pickAvailableHealAgent` and
 * `resolveAgentBinary` probe the HOST machine's PATH and well-known install
 * dirs, so leaving them real would make every heal-mode assertion depend on
 * whether the developer happens to have `claude` installed.
 *
 * `buildOrchestratorHealPrompt` stays real — it renders the shipped
 * `heal-agent.md` template, which is exactly what this module is responsible
 * for wiring — but gains a fault switch. Its throw arm is real and reachable
 * (it loads the packaged template eagerly so a broken install surfaces at
 * config time rather than mid-heal), yet a test cannot delete an asset out of
 * the installed package.
 */
const agentProbe = vi.hoisted(() => ({
  answer: 'claude' as 'claude' | 'codex' | null,
  asked: [] as (string | undefined)[],
  // Which agent each `resolveAgentBinary` call named, and whether a path was
  // found for it. Answering PER AGENT rather than with one fixed string is
  // load-bearing: `buildAgentSpawnCommand` uses `binaryPath` verbatim as the
  // command head, so a resolver hard-coded to one agent would otherwise spawn
  // the wrong CLI with no test able to see it.
  resolved: [] as string[],
  binaryFound: true,
  promptFails: null as string | null,
}))

vi.mock('./logic/runtime/auto-heal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logic/runtime/auto-heal')>()
  return {
    ...actual,
    pickAvailableHealAgent: (requested?: string) => {
      agentProbe.asked.push(requested)
      return agentProbe.answer
    },
    resolveAgentBinary: (agent: Parameters<typeof actual.resolveAgentBinary>[0]) => {
      agentProbe.resolved.push(agent)
      return agentProbe.binaryFound ? `/opt/canary/bin/${agent}` : null
    },
    buildOrchestratorHealPrompt: (opts: Parameters<typeof actual.buildOrchestratorHealPrompt>[0]) => {
      if (agentProbe.promptFails) throw new Error(agentProbe.promptFails)
      return actual.buildOrchestratorHealPrompt(opts)
    },
  }
})

let tmpDir: string
let projectRoot: string
let featuresDir: string
let logsDir: string
let repoDir: string
let savedMaxRuns: string | undefined
const madeTmpPaths: string[] = []

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-routedeps-')))
  projectRoot = path.join(tmpDir, 'project')
  featuresDir = path.join(projectRoot, 'features')
  logsDir = path.join(projectRoot, 'logs')
  repoDir = path.join(tmpDir, 'app')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  savedMaxRuns = process.env.CANARY_MAX_CONCURRENT_RUNS
  delete process.env.CANARY_MAX_CONCURRENT_RUNS
  orchHarness.constructFails = null
  orchHarness.stopFails = null
  orchHarness.options = []
  orchHarness.instances = []
  orchHarness.stops = []
  orchHarness.boot = () => new Promise(() => { /* held */ })
  orchHarness.cycle = () => new Promise(() => { /* held */ })
  orchHarness.restart = () => new Promise(() => { /* held */ })
  agentProbe.answer = 'claude'
  agentProbe.asked = []
  agentProbe.resolved = []
  agentProbe.binaryFound = true
  agentProbe.promptFails = null
})

afterEach(() => {
  if (savedMaxRuns === undefined) delete process.env.CANARY_MAX_CONCURRENT_RUNS
  else process.env.CANARY_MAX_CONCURRENT_RUNS = savedMaxRuns
  for (const p of madeTmpPaths.splice(0)) fs.rmSync(p, { recursive: true, force: true })
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── fixtures ────────────────────────────────────────────────────────────────

interface RepoSpec { name: string; localPath: string; branch?: string }
interface FeatureSpec { envs?: string[]; repos?: RepoSpec[] }

/** Real on-disk feature config — `loadFeatures` requires and re-reads it. */
function writeFeature(name: string, spec: FeatureSpec = {}): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { ...${JSON.stringify({ name, description: 'd', ...spec })}, featureDir: __dirname } }`,
  )
  return dir
}

function writeProjectConfig(healAgent: string): void {
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'canary-lab.config.json'), JSON.stringify({ healAgent }))
}

/**
 * A saved port overlay, which is the ONLY thing `portifyOverlayExists` reads —
 * a non-empty `repos` array in `portify/meta.json`. The patch files themselves
 * are applied by the orchestrator at boot, not by this module, so the metadata
 * alone is the whole input to the portified/collision-free decision.
 */
function writeOverlay(featureDir: string, repoNames: string[]): void {
  fs.mkdirSync(path.join(featureDir, 'portify'), { recursive: true })
  fs.writeFileSync(
    path.join(featureDir, 'portify', 'meta.json'),
    JSON.stringify({
      version: 1,
      repos: repoNames.map((name) => ({ name, baseSha: 'abc123', patch: `${name}.patch`, touchedFiles: [] })),
    }),
  )
}

/**
 * A non-null `backups` needs the complete real envset shape: a config naming a
 * slot, a target file that already exists (nothing to back up otherwise), and a
 * set directory to copy from. Anything less and `applyFeatureEnvset` returns
 * null, which is a different branch of the code under test. Returns the target
 * path so a test can prove a rejected start put the original file back.
 */
function writeEnvset(featureDir: string, setName: string, rawConfig?: string): string {
  const envsetsDir = path.join(featureDir, 'envsets')
  const target = path.join(tmpDir, 'envtarget', '.env')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'ORIGINAL=1\n')
  fs.mkdirSync(path.join(envsetsDir, setName), { recursive: true })
  fs.writeFileSync(path.join(envsetsDir, setName, '.env'), 'APPLIED=1\n')
  fs.writeFileSync(
    path.join(envsetsDir, 'envsets.config.json'),
    rawConfig ?? JSON.stringify({
      appRoots: {},
      slots: { '.env': { description: 'app env', target } },
      feature: { slots: ['.env'], testCommand: 'true', testCwd: tmpDir },
    }),
  )
  return target
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** A real git repo, because `addWorktree` / `hydrateWorkingTreeDiff` shell out
 *  to real git and a fake would only prove the fake was called. */
function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.ts'), 'export const port = 3000\n')
  // Committed, not incidental: `node_modules` must be IGNORED for the worktree
  // paths to behave like a real repo. Untracked, git would list it as WIP and
  // copy it into the fresh worktree, which both inflates the untracked count
  // and pre-creates the directory `linkNodeModules` refuses to overwrite.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n')
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

function seedRun(store: RunStore, runId: string, patch: Partial<RunManifest> = {}): void {
  store.bootstrap({
    runId,
    feature: 'demo',
    startedAt: '2026-08-21T00:00:00.000Z',
    status: 'failed',
    healCycles: 0,
    services: [],
    // Non-empty repoPaths is load-bearing for any manifest a heal prompt is
    // built from: `detectHealMode` reads it and a run with no editable repos
    // gets the `test` mode, whose copy deliberately differs from `service`.
    repoPaths: [repoDir],
    ...patch,
  })
}

// ─── harness ─────────────────────────────────────────────────────────────────

interface AttachCall {
  orch: { runId: string }
  runnerLogPath: string
  featureName: string
  backups: BackupRecord[] | null
}

interface Harness {
  deps: ReturnType<typeof buildRunsRouteDeps>
  registry: OrchestratorRegistry
  runStore: RunStore
  scheduling: RunsRouteDepsParts['scheduling']
  brokers: Map<string, PaneBroker>
  benchmarks: Map<string, { status: string }>
  attached: AttachCall[]
  claims: { runId: string; input: Record<string, unknown> }[]
  ptyFactory: PtyFactory
  dirtySpecStore: unknown
  workspaceEvents: unknown
  gettingStarted: unknown
  restartLocalHeal: RunsRouteDepsParts['restartLocalHeal']
}

/**
 * The scheduling half is the REAL `buildRunScheduling`: admission, the FIFO
 * queue and the queued-manifest writer are what decide whether `startRun`
 * returns `queued`, so stubbing them would leave the interesting outcome
 * asserted against a stub's return value instead of against run state.
 */
function harness(): Harness {
  const registry = createRegistry()
  const runStore = new RunStore(logsDir, registry)
  const brokers = new Map<string, PaneBroker>()
  const benchmarks = new Map<string, { status: string }>()
  const attached: AttachCall[] = []
  const claims: { runId: string; input: Record<string, unknown> }[] = []
  // Not a stub returning a fake handle: this module only forwards the factory
  // to the orchestrator, so a CALL here means something tried to launch a real
  // agent REPL. Throwing is the assertion.
  const ptyFactory = (() => {
    throw new Error('no test may spawn a pty')
  }) as unknown as PtyFactory
  const dirtySpecStore = { marker: 'dirty-specs' }
  const workspaceEvents = { publish: () => { /* nothing here reads the bus */ } }
  const gettingStarted = { marker: 'getting-started' }
  const ctx = {
    projectRoot,
    featuresDir,
    logsDir,
    registry,
    runStore,
    benchmarkStore: { get: (id: string) => benchmarks.get(id) ?? null },
    dirtySpecStore,
    workspaceEvents,
    gettingStarted,
    // A recording stand-in: the observable consequence here is that the broker
    // was handed exactly this client identity. What it then does with it is
    // `external-heal-broker.test.ts`'s subject.
    externalHealBroker: {
      claim: (runId: string, input: Record<string, unknown>) => { claims.push({ runId, input }) },
    },
    brokers,
    activeEnvsets: new Map<string, BackupRecord[]>(),
    ptyFactory,
  } as unknown as ServerContext
  const attachRunStreams = ((
    orch: { runId: string },
    runnerLog: { logPath: string },
    featureName: string,
    backups: BackupRecord[] | null,
  ) => {
    attached.push({ orch, runnerLogPath: runnerLog.logPath, featureName, backups })
    // Creating the broker when absent is load-bearing, not fixture padding: the
    // real attachRunStreams does exactly this, and it is the invariant behind
    // the non-null `brokers.get(runId)!` on the following line.
    brokers.set(orch.runId, brokers.get(orch.runId) ?? new PaneBroker())
  }) as unknown as RunsRouteDepsParts['attachRunStreams']
  const scheduling = buildRunScheduling(ctx)
  const restartLocalHeal = (async () => ({ ok: true as const })) as RunsRouteDepsParts['restartLocalHeal']
  const deps = buildRunsRouteDeps(ctx, {
    attachRunStreams,
    restartExternalRun: (() => {
      throw new Error('the runs route deps never call restartExternalRun')
    }) as unknown as RunsRouteDepsParts['restartExternalRun'],
    scheduling,
    restartLocalHeal,
  })
  return {
    deps, registry, runStore, scheduling, brokers, benchmarks, attached, claims,
    ptyFactory, dirtySpecStore, workspaceEvents, gettingStarted, restartLocalHeal,
  }
}

function runnerLogText(runId: string): string {
  return fs.readFileSync(buildRunPaths(runDirFor(logsDir, runId)).runnerLogPath, 'utf-8')
}

function lastOpts(): Record<string, unknown> {
  return orchHarness.options[orchHarness.options.length - 1]
}

/**
 * The shape this module hands the orchestrator as `autoHeal`. The two builders
 * are called back here rather than inspected, because what matters is the text
 * they produce for the agent.
 */
interface AutoHealWiring {
  agent: string
  buildSpawnCommand: (a: { mcpOutputDir: string }) => string
  buildCyclePrompt: (a: { cycle: number; outputDir: string }) => string
}

/** Start a run that is expected to launch, and hand back its run id. */
async function startOk(h: Harness, ...args: Parameters<Harness['deps']['startRun']>): Promise<string> {
  const outcome = await h.deps.startRun(...args)
  if (outcome.kind !== 'started') throw new Error(`expected a started run, got ${outcome.kind}`)
  return outcome.orch.runId
}

// ─── the plumbed-through members ─────────────────────────────────────────────

describe('buildRunsRouteDeps — pass-through wiring', () => {
  it('hands the routes the resolved paths, the run store and the injected collaborators', () => {
    const h = harness()

    expect(h.deps.featuresDir).toBe(featuresDir)
    expect(h.deps.projectRoot).toBe(projectRoot)
    expect(h.deps.store).toBe(h.runStore)
    expect(h.deps.workspaceEvents).toBe(h.workspaceEvents)
    expect(h.deps.gettingStarted).toBe(h.gettingStarted)
    expect(h.deps.cancelQueuedRun).toBe(h.scheduling.cancelQueuedRun)
    expect(h.deps.restartHeal).toBe(h.restartLocalHeal)
  })
})

// ─── isWorktreeOwnerActive ───────────────────────────────────────────────────

describe('isWorktreeOwnerActive', () => {
  it('reports a run active only while its manifest status is non-terminal', () => {
    const h = harness()
    seedRun(h.runStore, 'live', { status: 'healing' })
    seedRun(h.runStore, 'done', { status: 'passed' })

    expect(h.deps.isWorktreeOwnerActive!('run', 'live')).toBe(true)
    expect(h.deps.isWorktreeOwnerActive!('run', 'done')).toBe(false)
    // A worktree whose owning run has been deleted is safe to remove.
    expect(h.deps.isWorktreeOwnerActive!('run', 'ghost')).toBe(false)
  })

  it('treats a benchmark as active while it is running, sabotaging or ready', () => {
    const h = harness()
    h.benchmarks.set('b-run', { status: 'running' })
    h.benchmarks.set('b-sab', { status: 'sabotaging' })
    h.benchmarks.set('b-ready', { status: 'ready' })
    h.benchmarks.set('b-done', { status: 'completed' })

    expect(h.deps.isWorktreeOwnerActive!('benchmark', 'b-run')).toBe(true)
    expect(h.deps.isWorktreeOwnerActive!('benchmark', 'b-sab')).toBe(true)
    // 'ready' means the sabotaged tree is still on disk waiting to be measured.
    expect(h.deps.isWorktreeOwnerActive!('benchmark', 'b-ready')).toBe(true)
    expect(h.deps.isWorktreeOwnerActive!('benchmark', 'b-done')).toBe(false)
    expect(h.deps.isWorktreeOwnerActive!('benchmark', 'gone')).toBe(false)
  })
})

// ─── startRun: refusals before any launch ────────────────────────────────────

describe('startRun — refusals', () => {
  it('throws when the workspace has no such feature', async () => {
    const h = harness()

    await expect(h.deps.startRun('ghost')).rejects.toThrow('feature not found: ghost')
    expect(orchHarness.options).toEqual([])
  })

  it('refuses before allocating anything when a repo is off its pinned branch', async () => {
    writeFeature('demo', { repos: [{ name: 'app', localPath: path.join(tmpDir, 'missing'), branch: 'main' }] })
    const h = harness()

    await expect(h.deps.startRun('demo')).rejects.toThrow('Repo branch check failed')
    // The branch gate runs before the run directory exists, so nothing has to
    // be unwound: no manifest, no orchestrator.
    expect(h.runStore.list()).toEqual([])
    expect(orchHarness.options).toEqual([])
  })
})

// ─── startRun: collision + queueing ──────────────────────────────────────────

describe('startRun — same-repo collision', () => {
  it('reports the conflicting run instead of guessing an isolation strategy', async () => {
    initRepo(repoDir)
    writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    const h = harness()
    seedRun(h.runStore, 'active-1', { status: 'running', feature: 'other' })

    const outcome = await h.deps.startRun('demo')

    expect(outcome).toEqual({
      kind: 'collision',
      conflictingRunId: 'active-1',
      conflictingFeature: 'other',
      repoPaths: [repoDir],
    })
    expect(orchHarness.options).toEqual([])
  })

  it('parks a declined-isolation run and promotes it once the repo frees', async () => {
    initRepo(repoDir)
    writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    const h = harness()
    seedRun(h.runStore, 'active-1', { status: 'running', feature: 'other' })

    const outcome = await h.deps.startRun('demo', undefined, undefined, 'queue')

    expect(outcome.kind).toBe('queued')
    const runId = outcome.kind === 'queued' ? outcome.runId : ''
    expect(outcome).toEqual({ kind: 'queued', runId, reason: 'repo-collision' })
    // The placeholder manifest is what makes a queued run visible in the UI
    // before any process exists.
    const queued = h.runStore.get(runId)!.manifest
    expect(queued.status).toBe('queued')
    expect(queued.queueReason).toBe('repo-collision')
    expect(h.scheduling.scheduler.isQueued(runId)).toBe(true)
    expect(orchHarness.options).toEqual([])

    h.runStore.finalize('active-1', 'passed', new Date().toISOString(), 0)

    await vi.waitFor(() => {
      expect(orchHarness.options).toHaveLength(1)
    })
    expect(lastOpts().runId).toBe(runId)
    expect(h.registry.get(runId)).toBe(orchHarness.instances[0])
  })

  it('honours an explicit worktree choice for a session that is not auto-isolated', async () => {
    initRepo(repoDir)
    // Uncommitted, so "not hydrated" below is a real observation rather than a
    // clean repo having nothing to hydrate.
    fs.writeFileSync(path.join(repoDir, 'scratch.ts'), 'export const wip = true\n')
    writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    const h = harness()
    seedRun(h.runStore, 'active-1', { status: 'running', feature: 'other' })

    // A boot session is the one execution type that is NOT always-worktree, so
    // it is the only place the user's isolation answer still decides.
    const outcome = await h.deps.startRun('demo', undefined, undefined, 'worktree', 'boot')

    expect(outcome).toEqual({
      kind: 'queued',
      runId: outcome.kind === 'queued' ? outcome.runId : '',
      reason: 'repo-collision',
    })
    const runId = outcome.kind === 'queued' ? outcome.runId : ''
    expect(h.runStore.get(runId)!.manifest.executionType).toBe('boot')

    // The queued outcome is NOT evidence that the answer was honoured: a
    // collision parks the run either way (the scheduler re-detects it), so the
    // isolation decision only becomes observable in the deferred launch. Free
    // the repo and let the promotion run it.
    h.runStore.finalize('active-1', 'passed', new Date().toISOString(), 0)

    await vi.waitFor(() => {
      expect(orchHarness.options).toHaveLength(1)
    })
    const worktrees = lastOpts().worktrees as { repoName: string; worktreeRoot: string }[]
    expect(worktrees).toHaveLength(1)
    expect(worktrees[0].repoName).toBe('app')
    expect(worktrees[0].worktreeRoot).toBe(path.join(runDirFor(logsDir, runId), 'worktrees', 'app'))
    // Isolated but NOT hydrated: a boot session never heals, so there are no
    // agent edits to capture and the uncommitted file stays out of the tree.
    expect(fs.existsSync(path.join(worktrees[0].worktreeRoot, 'scratch.ts'))).toBe(false)
    expect(runnerLogText(runId)).not.toContain('Hydrated uncommitted changes')
  })

  it('still queues an accepted worktree isolation, because the fixed ports collide too', async () => {
    initRepo(repoDir)
    writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    const h = harness()
    seedRun(h.runStore, 'active-1', { status: 'running', feature: 'other' })

    const outcome = await h.deps.startRun('demo', undefined, undefined, 'worktree')

    expect(outcome).toEqual({
      kind: 'queued',
      runId: outcome.kind === 'queued' ? outcome.runId : '',
      reason: 'repo-collision',
    })
  })
})

describe('startRun — resource admission', () => {
  it('parks a run that exceeds the concurrency ceiling and launches it on promotion', async () => {
    process.env.CANARY_MAX_CONCURRENT_RUNS = '1'
    initRepo(repoDir)
    // A DIFFERENT repo, so the queue reason is the resource budget rather than
    // a collision — the two reasons take different branches.
    const otherRepo = initRepo(path.join(tmpDir, 'other-app'))
    writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    const h = harness()
    seedRun(h.runStore, 'active-1', { status: 'running', feature: 'other', repoPaths: [otherRepo] })

    const outcome = await h.deps.startRun('demo')

    expect(outcome.kind).toBe('queued')
    const runId = outcome.kind === 'queued' ? outcome.runId : ''
    expect(outcome).toEqual({ kind: 'queued', runId, reason: 'resources' })
    expect(h.runStore.get(runId)!.manifest.queueReason).toBe('resources')

    h.runStore.finalize('active-1', 'passed', new Date().toISOString(), 0)

    await vi.waitFor(() => {
      expect(orchHarness.options).toHaveLength(1)
    })
    expect(lastOpts().runId).toBe(runId)
  })
})

// ─── startRun: worktree isolation ────────────────────────────────────────────

describe('startRun — worktree isolation', () => {
  it('isolates every repo, links its deps in and reproduces the uncommitted working tree', async () => {
    initRepo(repoDir)
    fs.writeFileSync(path.join(repoDir, 'server.ts'), 'export const port = 4000\n')
    fs.writeFileSync(path.join(repoDir, 'scratch.ts'), 'export const wip = true\n')
    // Gitignored deps a `git worktree add` cannot carry over. Without the
    // symlink the service boot command can't resolve its bins and dies with
    // exit 127, which then reads as a health-check timeout.
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, 'node_modules', '.bin', 'concurrently'), '#!/bin/sh\n')
    writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    const h = harness()

    const runId = await startOk(h, 'demo')

    const worktrees = lastOpts().worktrees as { repoName: string; worktreeRoot: string; localPath: string }[]
    expect(worktrees).toHaveLength(1)
    expect(worktrees[0].repoName).toBe('app')
    expect(worktrees[0].worktreeRoot).toBe(path.join(runDirFor(logsDir, runId), 'worktrees', 'app'))
    // The point of always-worktree: the run tests the user's WIP, and the
    // product repo is never the thing the heal agent edits.
    expect(fs.readFileSync(path.join(worktrees[0].localPath, 'server.ts'), 'utf-8'))
      .toBe('export const port = 4000\n')
    expect(fs.readFileSync(path.join(worktrees[0].localPath, 'scratch.ts'), 'utf-8'))
      .toBe('export const wip = true\n')
    // A symlink, not a copy: the run must resolve the SOURCE repo's installed
    // deps, and a per-run copy of node_modules would be unusable on disk.
    const linkedDeps = path.join(worktrees[0].worktreeRoot, 'node_modules')
    expect(fs.lstatSync(linkedDeps).isSymbolicLink()).toBe(true)
    expect(fs.realpathSync(linkedDeps)).toBe(fs.realpathSync(path.join(repoDir, 'node_modules')))
    expect(fs.existsSync(path.join(linkedDeps, '.bin', 'concurrently'))).toBe(true)
    const log = runnerLogText(runId)
    expect(log).toContain('Hydrated uncommitted changes into "app" worktree (1 untracked file(s)).')
    expect(log).toContain('Isolated repo "app" in a per-run worktree.')
  })

  it('records the degraded mode when the WIP patch cannot be staged', async () => {
    initRepo(repoDir)
    fs.writeFileSync(path.join(repoDir, 'server.ts'), 'export const port = 4000\n')
    writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    // hydrateWorkingTreeDiff writes the tracked-changes patch to a fixed path
    // derived from the worktree dir name and this process's pid. A DIRECTORY
    // squatting that exact path makes the real write fail with EISDIR — the
    // honest way to reach the "testing committed state" arm without faking git.
    const squat = path.join(os.tmpdir(), `canary-wip-app-${process.pid}.patch`)
    fs.mkdirSync(squat, { recursive: true })
    madeTmpPaths.push(squat)
    const h = harness()

    const runId = await startOk(h, 'demo')

    const log = runnerLogText(runId)
    expect(log).toContain('Worktree WIP hydration for "app" had issues (testing committed state)')
    // Degraded, not aborted: the worktree still exists and the run still starts.
    expect(log).toContain('Isolated repo "app" in a per-run worktree.')
    expect((lastOpts().worktrees as unknown[])).toHaveLength(1)
  })

  it('says nothing about hydration when the source repo is clean', async () => {
    initRepo(repoDir)
    writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    const h = harness()

    const runId = await startOk(h, 'demo')

    expect(runnerLogText(runId)).not.toContain('Hydrated uncommitted changes')
    expect(runnerLogText(runId)).not.toContain('had issues')
  })

  it('falls back to running in place when a repo is not a git working tree', async () => {
    const plain = path.join(tmpDir, 'plain')
    fs.mkdirSync(plain, { recursive: true })
    writeFeature('demo', { repos: [{ name: 'app', localPath: plain }] })
    const h = harness()

    const runId = await startOk(h, 'demo')

    expect(lastOpts().worktrees).toEqual([])
    expect(runnerLogText(runId)).toContain('Worktree isolation failed for "app"; running in place')
  })

  it('runs a repo-less feature with no worktrees at all', async () => {
    writeFeature('demo')
    const h = harness()

    const runId = await startOk(h, 'demo')

    expect(lastOpts().worktrees).toEqual([])
    expect(h.runStore.get(runId)).toBeNull()
  })
})

// ─── startRun: portified runs ────────────────────────────────────────────────

describe('startRun — portified feature', () => {
  it('never raises the collision prompt, because its injected ports are disjoint', async () => {
    initRepo(repoDir)
    const featureDir = writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    writeOverlay(featureDir, ['app'])
    const h = harness()
    // An active run on the SAME repo forces the prompt for a plain feature.
    seedRun(h.runStore, 'active-1', { status: 'running', feature: 'other' })

    const outcome = await h.deps.startRun('demo')

    // Deliberately not an equality assertion: with another run active, whether
    // this one starts now or waits for a resource slot depends on the host's
    // free memory. What is invariant is that the user is never asked.
    expect(outcome.kind).not.toBe('collision')
  })

  it('isolates every repo and skips WIP hydration, since the overlay is the tree state', async () => {
    initRepo(repoDir)
    fs.writeFileSync(path.join(repoDir, 'scratch.ts'), 'export const wip = true\n')
    const featureDir = writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    writeOverlay(featureDir, ['app'])
    const h = harness()

    const runId = await startOk(h, 'demo')

    const worktrees = lastOpts().worktrees as { localPath: string }[]
    expect(worktrees).toHaveLength(1)
    // The overlay IS the intended tree state, so uncommitted files stay out.
    expect(fs.existsSync(path.join(worktrees[0].localPath, 'scratch.ts'))).toBe(false)
    expect(runnerLogText(runId)).not.toContain('Hydrated uncommitted changes')
  })

  it('fails loud rather than booting un-portified when a worktree cannot be made', async () => {
    const plain = path.join(tmpDir, 'plain')
    fs.mkdirSync(plain, { recursive: true })
    const featureDir = writeFeature('demo', { repos: [{ name: 'app', localPath: plain }] })
    writeOverlay(featureDir, ['app'])
    const h = harness()

    await expect(h.deps.startRun('demo')).rejects
      .toThrow(/worktree isolation failed for portified repo "app"/)
    expect(orchHarness.options).toEqual([])
  })

  it('reverts the applied envset when a portified worktree cannot be made', async () => {
    const plain = path.join(tmpDir, 'plain')
    fs.mkdirSync(plain, { recursive: true })
    const featureDir = writeFeature('demo', {
      envs: ['local'],
      repos: [{ name: 'app', localPath: plain }],
    })
    const target = writeEnvset(featureDir, 'local')
    writeOverlay(featureDir, ['app'])
    const h = harness()

    await expect(h.deps.startRun('demo', 'local')).rejects.toThrow('worktree isolation failed')
    // A refused start must leave the workspace exactly as it found it, or the
    // next run inherits this run's env files.
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL=1\n')
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.includes('.bak.'))).toEqual([])
  })
})

// ─── startRun: envsets ───────────────────────────────────────────────────────

describe('startRun — envset application', () => {
  it('applies the named envset and hands the backups to the stream wiring', async () => {
    const featureDir = writeFeature('demo', { envs: ['local'] })
    const target = writeEnvset(featureDir, 'local')
    const h = harness()

    const runId = await startOk(h, 'demo', 'local')

    expect(fs.readFileSync(target, 'utf-8')).toBe('APPLIED=1\n')
    expect(runnerLogText(runId)).toContain('Applied envset "local" for demo')
    // The backups travel to attachRunStreams, which owns reverting them on
    // run-complete — a start that swallowed them would leak the envset.
    expect(h.attached[0].backups).toEqual([
      { originalPath: target, backupPath: expect.stringContaining(`${target}.bak.`) },
    ])
  })

  it('leaves backups null when the named env has no envsets config', async () => {
    writeFeature('demo', { envs: ['local'] })
    const h = harness()

    const runId = await startOk(h, 'demo', 'local')

    expect(h.attached[0].backups).toBeNull()
    expect(runnerLogText(runId)).not.toContain('Applied envset')
  })

  it('aborts the launch and records the reason when the envset cannot be applied', async () => {
    const featureDir = writeFeature('demo', { envs: ['local'] })
    writeEnvset(featureDir, 'local', '{ not json')
    const h = harness()

    let runId = ''
    await expect(h.deps.startRun('demo', 'local').catch((err: Error) => {
      runId = fs.readdirSync(path.join(logsDir, 'runs'))[0]
      throw err
    })).rejects.toThrow()
    expect(runnerLogText(runId)).toContain('envset apply failed')
    expect(orchHarness.options).toEqual([])
  })
})

// ─── startRun: heal-mode selection ───────────────────────────────────────────

describe('startRun — heal mode', () => {
  it('configures a local auto-heal agent with a run-scoped spawn command', async () => {
    writeProjectConfig('claude')
    writeFeature('demo')
    const h = harness()

    const runId = await startOk(h, 'demo')

    const runDir = runDirFor(logsDir, runId)
    const opts = lastOpts()
    expect(opts.manualHeal).toBe(false)
    expect(opts.externalHeal).toBe(false)
    const autoHeal = opts.autoHeal as AutoHealWiring
    expect(autoHeal.agent).toBe('claude')
    expect(agentProbe.asked).toEqual(['claude'])
    const paths = buildRunPaths(runDir)
    const spawn = autoHeal.buildSpawnCommand({ mcpOutputDir: paths.failedDir })
    // The absolute binary is what lets the agent spawn under a restricted PATH
    // (a Desktop-launched server), and the per-run MCP config is what scopes
    // its Canary tools to this run. The binary must be resolved for the CHOSEN
    // agent — the spawn command uses the path verbatim as its command head.
    expect(agentProbe.resolved).toEqual(['claude'])
    expect(spawn).toContain('/opt/canary/bin/claude')
    expect(spawn).toContain(path.join(runDir, 'mcp-config.json'))
  })

  it('tells the agent to fix the app, not the test, when the run has editable repos', async () => {
    writeProjectConfig('claude')
    initRepo(repoDir)
    writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    const h = harness()

    const runId = await startOk(h, 'demo')
    // The prompt re-reads the run's manifest on every cycle, and the REAL
    // orchestrator writes it before the first heal cycle — the fake here never
    // does. Seeding it is what makes `service` mode a decision about evidence:
    // without a manifest the mode comes from detectHealMode's missing-file
    // fallback, which is also `service`, so the assertion below would hold even
    // with the repoPaths gate deleted.
    seedRun(h.runStore, runId, { status: 'healing', repoPaths: [repoDir] })

    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const prompt = (lastOpts().autoHeal as AutoHealWiring)
      .buildCyclePrompt({ cycle: 0, outputDir: paths.failedDir })

    // The repair rule is the product's core guarantee: this run has an editable
    // repo, so the agent must be told to fix the app, not the test.
    expect(prompt).toContain(MODE_COPY.service.healingDirective)
    expect(prompt).not.toContain(MODE_COPY.test.healingDirective)
    // Scoped to THIS run: the agent reads its evidence and writes its signals
    // through these paths, so a prompt built against another run's directory
    // would send a correct repair to a directory nothing is watching.
    expect(prompt).toContain(paths.healIndexPath)
    expect(prompt).toContain(paths.rerunSignal)
    expect(fs.existsSync(path.join(runDirFor(logsDir, runId), 'heal-prompt.md'))).toBe(true)
  })

  it('points the agent at the specs only when the run has no editable repos', async () => {
    writeProjectConfig('claude')
    writeFeature('demo')
    const h = harness()

    const runId = await startOk(h, 'demo')
    // The deliberate exception to the repair rule: zero editable repoPaths
    // means the spec is the only fixable code. The mode is read from the
    // manifest and nothing else, so this arm and the one above are separated by
    // repo EVIDENCE rather than by a file that happens to be missing.
    seedRun(h.runStore, runId, { status: 'healing', repoPaths: [] })

    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const prompt = (lastOpts().autoHeal as AutoHealWiring)
      .buildCyclePrompt({ cycle: 0, outputDir: paths.failedDir })

    expect(prompt).toContain(MODE_COPY.test.healingDirective)
    expect(prompt).not.toContain(MODE_COPY.service.healingDirective)
  })

  it('spawns the agent by bare name when its binary is not on a known path', async () => {
    writeProjectConfig('codex')
    writeFeature('demo')
    agentProbe.answer = 'codex'
    agentProbe.binaryFound = false
    const h = harness()

    await startOk(h, 'demo')

    const autoHeal = lastOpts().autoHeal as AutoHealWiring
    expect(autoHeal.agent).toBe('codex')
    // Resolution was attempted for CODEX: a lookup hard-coded to claude would
    // hand codex claude's path and spawn the wrong CLI.
    expect(agentProbe.resolved).toEqual(['codex'])
    expect(autoHeal.buildSpawnCommand({ mcpOutputDir: logsDir })).toMatch(/^codex/)
  })

  it('runs without a self-fixing cycle when no agent CLI is installed', async () => {
    writeProjectConfig('auto')
    writeFeature('demo')
    agentProbe.answer = null
    const h = harness()

    const runId = await startOk(h, 'demo')

    expect(lastOpts().autoHeal).toBeUndefined()
    expect(runnerLogText(runId)).toContain('Auto-heal disabled: no `claude` or `codex` CLI on PATH')
  })

  it('runs without auto-heal when the heal prompt cannot be built', async () => {
    writeProjectConfig('claude')
    writeFeature('demo')
    agentProbe.promptFails = 'heal-agent.md missing from the package'
    const h = harness()

    const runId = await startOk(h, 'demo')

    expect(lastOpts().autoHeal).toBeUndefined()
    expect(runnerLogText(runId)).toContain('Auto-heal disabled: heal-agent.md missing from the package')
  })

  it('pauses for hand-driven fixes when the project is set to manual', async () => {
    writeProjectConfig('manual')
    writeFeature('demo')
    const h = harness()

    const runId = await startOk(h, 'demo')

    expect(lastOpts().manualHeal).toBe(true)
    expect(lastOpts().autoHeal).toBeUndefined()
    // Probing PATH would be wrong, not merely wasteful: a manual project has
    // decided the repair is the user's job.
    expect(agentProbe.asked).toEqual([])
    expect(runnerLogText(runId)).toContain('project config is set to "manual"')
  })

  it('waits for a client to claim heal when the project is set to external', async () => {
    writeProjectConfig('external')
    writeFeature('demo')
    const h = harness()

    const runId = await startOk(h, 'demo')

    expect(lastOpts().externalHeal).toBe(true)
    expect(lastOpts().manualHeal).toBe(false)
    expect(agentProbe.asked).toEqual([])
    expect(runnerLogText(runId)).toContain('project config is set to "external"')
  })
})

describe('startRun — external heal origin', () => {
  it('registers a claimable client with the broker and skips project auto-heal', async () => {
    // A project configured for local auto-heal: the TRIGGER SOURCE, not the
    // setting, is what decides the mode.
    writeProjectConfig('claude')
    writeFeature('demo')
    const h = harness()

    const runId = await startOk(h, 'demo', undefined, {
      kind: 'external',
      sessionId: 'session-abcdef123456',
      clientKind: 'claude',
      clientVersion: '1.2.3',
      conversationName: 'fixing checkout',
    })

    const opts = lastOpts()
    expect(opts.externalHeal).toBe(true)
    expect(opts.autoHeal).toBeUndefined()
    expect(agentProbe.asked).toEqual([])
    expect(opts.externalHealSession).toMatchObject({
      sessionId: 'session-abcdef123456',
      clientKind: 'claude',
      clientVersion: '1.2.3',
      conversationName: 'fixing checkout',
      status: 'connected',
      cycleCount: 0,
    })
    // The claim is registered separately from the manifest so heartbeats and
    // signals from this session id are recognised in memory too.
    expect(h.claims).toEqual([{
      runId,
      input: {
        sessionId: 'session-abcdef123456',
        clientKind: 'claude',
        clientVersion: '1.2.3',
        conversationName: 'fixing checkout',
      },
    }])
    expect(runnerLogText(runId)).toContain('claimed and will drive the heal loop')
  })

  it('omits the optional client fields the request did not supply', async () => {
    writeFeature('demo')
    const h = harness()

    const runId = await startOk(h, 'demo', undefined, {
      kind: 'external',
      sessionId: 'session-0000000000',
      clientKind: 'other',
    })

    const session = lastOpts().externalHealSession as Record<string, unknown>
    expect('clientVersion' in session).toBe(false)
    expect('conversationName' in session).toBe(false)
    expect(h.claims[0].input).toEqual({ sessionId: 'session-0000000000', clientKind: 'other' })
    expect(runId).not.toBe('')
  })

  it('runs in external mode without a claim when the client cannot claim heal', async () => {
    writeProjectConfig('claude')
    writeFeature('demo')
    const h = harness()

    const runId = await startOk(h, 'demo', undefined, {
      kind: 'external',
      sessionId: 'session-cli0000000',
      clientKind: 'other',
      claimable: false,
    })

    const opts = lastOpts()
    expect(opts.externalHeal).toBe(true)
    expect(opts.externalHealSession).toBeUndefined()
    expect(h.claims).toEqual([])
    expect(runnerLogText(runId)).toContain("can't claim heal — waiting in external mode")
  })
})

// ─── startRun: boot-only sessions ────────────────────────────────────────────

describe('startRun — boot-only session', () => {
  it('holds the services up with every heal mode forced off', async () => {
    writeProjectConfig('claude')
    initRepo(repoDir)
    fs.writeFileSync(path.join(repoDir, 'scratch.ts'), 'export const wip = true\n')
    writeFeature('demo', { repos: [{ name: 'app', localPath: repoDir }] })
    const h = harness()

    const runId = await startOk(h, 'demo', undefined, undefined, undefined, 'boot')

    const opts = lastOpts()
    expect(opts.executionType).toBe('boot')
    expect(opts.autoHeal).toBeUndefined()
    expect(opts.manualHeal).toBe(false)
    expect(opts.externalHeal).toBe(false)
    // A boot session doesn't heal, so there is nothing to isolate or preserve.
    expect(opts.worktrees).toEqual([])
    expect(agentProbe.asked).toEqual([])
    expect(runnerLogText(runId)).toContain('Boot-only session: booting services and holding them')
    // Held, not settled: the services stay up until the user stops the run.
    expect(h.registry.get(runId)).toBe(orchHarness.instances[0])
    expect(orchHarness.stops).toEqual([])
  })

  it('tears the session down and reports the cause when the boot fails', async () => {
    writeFeature('demo')
    orchHarness.boot = () => Promise.reject(new Error('health check never answered'))
    const h = harness()

    const runId = await startOk(h, 'demo', undefined, undefined, undefined, 'boot')

    await vi.waitFor(() => {
      expect(orchHarness.stops).toEqual(['aborted'])
    })
    expect(h.brokers.get(runId)!.snapshot('agent')).toContain('[boot error] Error: health check never answered')
    expect(h.registry.get(runId)).toBeUndefined()
  })

  it('drops the run from the registry even when the teardown itself fails', async () => {
    writeFeature('demo')
    orchHarness.boot = () => Promise.reject(new Error('port already bound'))
    // A boot that fails AND cannot be torn down cleanly must still release the
    // registry entry, or the run stays "active" forever and blocks the queue.
    orchHarness.stopFails = 'service already gone'
    const h = harness()

    const runId = await startOk(h, 'demo', undefined, undefined, undefined, 'boot')

    await vi.waitFor(() => {
      expect(h.registry.get(runId)).toBeUndefined()
    })
    expect(orchHarness.stops).toEqual(['aborted'])
  })

  it('does not warn about a missing CLI, since a boot session never heals', async () => {
    writeProjectConfig('auto')
    writeFeature('demo')
    agentProbe.answer = null
    const h = harness()

    const runId = await startOk(h, 'demo', undefined, undefined, undefined, 'boot')

    expect(runnerLogText(runId)).not.toContain('no `claude` or `codex` CLI on PATH')
  })
})

// ─── startRun: the settle path ───────────────────────────────────────────────

describe('startRun — completion', () => {
  it('registers the run while it drives, then settles it on the status it reached', async () => {
    writeFeature('demo')
    let finish: (status: string) => void = () => { /* replaced below */ }
    orchHarness.cycle = () => new Promise((resolve) => { finish = resolve })
    const h = harness()

    const runId = await startOk(h, 'demo')

    expect(h.registry.get(runId)).toBe(orchHarness.instances[0])
    expect(h.attached).toHaveLength(1)
    expect(h.attached[0].featureName).toBe('demo')
    expect(h.attached[0].runnerLogPath).toBe(buildRunPaths(runDirFor(logsDir, runId)).runnerLogPath)
    expect(lastOpts().ptyFactory).toBe(h.ptyFactory)
    expect(lastOpts().runStateSink).toBe(h.runStore)
    expect(lastOpts().dirtySpecHooks).toBe(h.dirtySpecStore)
    expect(lastOpts().projectRoot).toBe(projectRoot)

    finish('failed')

    await vi.waitFor(() => {
      expect(orchHarness.stops).toEqual(['failed'])
      expect(h.registry.get(runId)).toBeUndefined()
    })
  })

  it('propagates an orchestrator construction failure and reverts the envset', async () => {
    const featureDir = writeFeature('demo', { envs: ['local'] })
    const target = writeEnvset(featureDir, 'local')
    orchHarness.constructFails = 'posix_spawnp failed'
    const h = harness()

    await expect(h.deps.startRun('demo', 'local')).rejects.toThrow('posix_spawnp failed')
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL=1\n')
    expect(h.attached).toEqual([])
  })

  it('propagates an orchestrator construction failure when there is no envset to revert', async () => {
    writeFeature('demo')
    orchHarness.constructFails = 'posix_spawnp failed'
    const h = harness()

    await expect(h.deps.startRun('demo')).rejects.toThrow('posix_spawnp failed')
    expect(h.attached).toEqual([])
  })
})

// ─── restartRun ──────────────────────────────────────────────────────────────

describe('restartRun — refusals', () => {
  it('reports run-not-found when no manifest exists on disk', async () => {
    const h = harness()

    expect(await h.deps.restartRun!('ghost')).toEqual({ ok: false, reason: 'run-not-found' })
  })

  it('refuses a verification execution, which is re-run from its own surface', async () => {
    const h = harness()
    writeFeature('demo')
    seedRun(h.runStore, 'v1', { executionType: 'verify' })

    expect(await h.deps.restartRun!('v1')).toEqual({ ok: false, reason: 'not-restartable' })
  })

  it('refuses a run that is still active', async () => {
    const h = harness()
    writeFeature('demo')
    seedRun(h.runStore, 'a1', { status: 'healing' })

    expect(await h.deps.restartRun!('a1')).toEqual({ ok: false, reason: 'already-active' })
  })

  it('refuses a run that already passed', async () => {
    const h = harness()
    writeFeature('demo')
    seedRun(h.runStore, 'p1', { status: 'passed' })

    expect(await h.deps.restartRun!('p1')).toEqual({ ok: false, reason: 'not-restartable' })
  })

  it('refuses when the run names a feature that no longer exists', async () => {
    const h = harness()
    seedRun(h.runStore, 'f1', { feature: 'deleted-feature' })

    expect(await h.deps.restartRun!('f1')).toEqual({ ok: false, reason: 'not-restartable' })
  })

  it('reports spawn-failed when the envset cannot be applied', async () => {
    const featureDir = writeFeature('demo', { envs: ['local'] })
    writeEnvset(featureDir, 'local', '{ not json')
    const h = harness()
    seedRun(h.runStore, 'e1', { env: 'local' })

    expect(await h.deps.restartRun!('e1')).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(runnerLogText('e1')).toContain('envset apply failed')
    expect(orchHarness.options).toEqual([])
  })

  it('refuses, and reverts the envset, when a repo is off its pinned branch', async () => {
    const featureDir = writeFeature('demo', {
      envs: ['local'],
      repos: [{ name: 'app', localPath: path.join(tmpDir, 'missing'), branch: 'main' }],
    })
    const target = writeEnvset(featureDir, 'local')
    const h = harness()
    seedRun(h.runStore, 'b1', { env: 'local' })

    expect(await h.deps.restartRun!('b1')).toEqual({ ok: false, reason: 'not-restartable' })
    expect(runnerLogText('b1')).toContain('Run restart rejected: Repo branch check failed')
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL=1\n')
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.includes('.bak.'))).toEqual([])
  })

  it('refuses with no envset to revert when a repo is off its pinned branch', async () => {
    writeFeature('demo', {
      repos: [{ name: 'app', localPath: path.join(tmpDir, 'missing'), branch: 'main' }],
    })
    const h = harness()
    seedRun(h.runStore, 'b2')

    expect(await h.deps.restartRun!('b2')).toEqual({ ok: false, reason: 'not-restartable' })
    expect(runnerLogText('b2')).toContain('Run restart rejected')
  })

  it('reports spawn-failed and reverts the envset when the orchestrator cannot be built', async () => {
    const featureDir = writeFeature('demo', { envs: ['local'] })
    const target = writeEnvset(featureDir, 'local')
    orchHarness.constructFails = 'posix_spawnp failed'
    const h = harness()
    seedRun(h.runStore, 'o1', { env: 'local' })

    expect(await h.deps.restartRun!('o1')).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(runnerLogText('o1')).toContain('Run restart failed: posix_spawnp failed')
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL=1\n')
    expect(h.attached).toEqual([])
  })

  it('reports spawn-failed with no envset to revert when the orchestrator cannot be built', async () => {
    writeFeature('demo')
    orchHarness.constructFails = 'posix_spawnp failed'
    const h = harness()
    seedRun(h.runStore, 'o2')

    expect(await h.deps.restartRun!('o2')).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(h.registry.get('o2')).toBeUndefined()
  })
})

describe('restartRun — env selection', () => {
  it("defaults a legacy manifest with no persisted env to the feature's first envset", async () => {
    const featureDir = writeFeature('demo', { envs: ['local', 'staging'] })
    const target = writeEnvset(featureDir, 'local')
    const h = harness()
    seedRun(h.runStore, 'n1')

    expect(await h.deps.restartRun!('n1')).toEqual({ ok: true, mode: 'remaining' })
    expect(lastOpts().env).toBe('local')
    expect(fs.readFileSync(target, 'utf-8')).toBe('APPLIED=1\n')
    const log = runnerLogText('n1')
    expect(log).toContain('legacy manifest without persisted env; defaulting to "local"')
    expect(log).toContain('Applied envset "local" for run restart demo')
  })

  it('applies no envset when neither the run nor the feature names one', async () => {
    writeFeature('demo')
    const h = harness()
    seedRun(h.runStore, 'n2')

    expect(await h.deps.restartRun!('n2')).toEqual({ ok: true, mode: 'remaining' })
    expect(lastOpts().env).toBeUndefined()
    expect(h.attached[0].backups).toBeNull()
    expect(runnerLogText('n2')).not.toContain('defaulting to')
  })

  it('leaves backups null when the persisted env has no envsets config', async () => {
    writeFeature('demo', { envs: ['local'] })
    const h = harness()
    seedRun(h.runStore, 'n3', { env: 'local' })

    expect(await h.deps.restartRun!('n3')).toEqual({ ok: true, mode: 'remaining' })
    expect(h.attached[0].backups).toBeNull()
    expect(runnerLogText('n3')).not.toContain('defaulting to')
  })
})

describe('restartRun — heal mode', () => {
  it('retests the remaining failures on a fresh auto-heal agent', async () => {
    writeProjectConfig('claude')
    writeFeature('demo')
    let finish: (status: string) => void = () => { /* replaced below */ }
    orchHarness.restart = () => new Promise((resolve) => { finish = resolve })
    const h = harness()
    seedRun(h.runStore, 's1', { healCycles: 3 })

    expect(await h.deps.restartRun!('s1')).toEqual({ ok: true, mode: 'remaining' })

    const opts = lastOpts()
    expect(opts.runId).toBe('s1')
    expect(opts.ptyFactory).toBe(h.ptyFactory)
    // The retest continues the cycle count, so the cap that stops a runaway
    // heal loop still applies.
    expect(opts.initialHealCycles).toBe(3)
    expect(opts.runStateSink).toBe(h.runStore)
    expect(opts.dirtySpecHooks).toBe(h.dirtySpecStore)
    expect(opts.projectRoot).toBe(projectRoot)
    expect(opts.manualHeal).toBe(false)
    expect(opts.externalHeal).toBe(false)
    expect(opts.externalHealSession).toBeUndefined()
    const autoHeal = opts.autoHeal as AutoHealWiring
    expect(autoHeal.agent).toBe('claude')
    expect(agentProbe.resolved).toEqual(['claude'])
    const paths = buildRunPaths(runDirFor(logsDir, 's1'))
    expect(autoHeal.buildSpawnCommand({ mcpOutputDir: paths.failedDir }))
      .toContain(path.join(runDirFor(logsDir, 's1'), 'mcp-config.json'))
    // A restarted run is the easiest place for the repair rule to go missing.
    // The seeded manifest carries editable repoPaths, so `service` mode here is
    // read off the run's own evidence.
    const prompt = autoHeal.buildCyclePrompt({ cycle: 0, outputDir: paths.failedDir })
    expect(prompt).toContain(MODE_COPY.service.healingDirective)
    expect(prompt).not.toContain(MODE_COPY.test.healingDirective)
    // And scoped to the run being restarted, not to some other directory.
    expect(prompt).toContain(paths.healIndexPath)
    expect(prompt).toContain(paths.rerunSignal)
    expect(fs.existsSync(path.join(runDirFor(logsDir, 's1'), 'heal-prompt.md'))).toBe(true)

    expect(h.registry.get('s1')).toBe(orchHarness.instances[0])
    expect(h.brokers.get('s1')!.snapshot('agent'))
      .toContain('[orchestrator] Retesting remaining failed, skipped, and pending tests...')

    finish('passed')
    await vi.waitFor(() => {
      expect(orchHarness.stops).toEqual(['passed'])
      expect(h.registry.get('s1')).toBeUndefined()
    })
  })

  it('keeps an external-heal run waiting for its client instead of spawning an agent', async () => {
    writeProjectConfig('claude')
    writeFeature('demo')
    const session = {
      sessionId: 'session-abcdef123456',
      clientKind: 'claude' as const,
      claimedAt: '2026-08-21T00:00:00.000Z',
      lastHeartbeatAt: '2026-08-21T00:00:00.000Z',
      status: 'connected' as const,
      cycleCount: 1,
    }
    const h = harness()
    seedRun(h.runStore, 'x1', { healMode: 'external', externalHealSession: session })

    expect(await h.deps.restartRun!('x1')).toEqual({ ok: true, mode: 'remaining' })

    const opts = lastOpts()
    expect(opts.externalHeal).toBe(true)
    expect(opts.autoHeal).toBeUndefined()
    expect(opts.externalHealSession).toEqual(session)
    expect(agentProbe.asked).toEqual([])
  })

  it('keeps a manual run hand-driven', async () => {
    writeProjectConfig('claude')
    writeFeature('demo')
    const h = harness()
    seedRun(h.runStore, 'm1', { healMode: 'manual' })

    expect(await h.deps.restartRun!('m1')).toEqual({ ok: true, mode: 'remaining' })
    expect(lastOpts().manualHeal).toBe(true)
    expect(lastOpts().autoHeal).toBeUndefined()
    expect(agentProbe.asked).toEqual([])
  })

  it('retests without a heal cycle when no agent CLI is installed', async () => {
    writeProjectConfig('auto')
    writeFeature('demo')
    agentProbe.answer = null
    const h = harness()
    seedRun(h.runStore, 'c1')

    expect(await h.deps.restartRun!('c1')).toEqual({ ok: true, mode: 'remaining' })
    expect(lastOpts().autoHeal).toBeUndefined()
    expect(runnerLogText('c1'))
      .toContain('Auto-heal disabled for run restart: no `claude` or `codex` CLI on PATH')
  })

  it('retests without a heal cycle when the heal prompt cannot be built', async () => {
    writeProjectConfig('claude')
    writeFeature('demo')
    agentProbe.promptFails = 'heal-agent.md missing from the package'
    const h = harness()
    seedRun(h.runStore, 'c2')

    expect(await h.deps.restartRun!('c2')).toEqual({ ok: true, mode: 'remaining' })
    expect(lastOpts().autoHeal).toBeUndefined()
    expect(runnerLogText('c2'))
      .toContain('Auto-heal disabled for run restart: heal-agent.md missing from the package')
  })

  it('honours the run\'s persisted agent over the project setting', async () => {
    writeProjectConfig('manual')
    writeFeature('demo')
    agentProbe.answer = 'codex'
    const h = harness()
    seedRun(h.runStore, 'c3', { healAgent: 'codex' })

    expect(await h.deps.restartRun!('c3')).toEqual({ ok: true, mode: 'remaining' })
    expect(agentProbe.asked).toEqual(['codex'])
    const autoHeal = lastOpts().autoHeal as AutoHealWiring
    expect(autoHeal.agent).toBe('codex')
    // The binary is resolved for the persisted agent too, and the resolved path
    // becomes the command head verbatim.
    expect(agentProbe.resolved).toEqual(['codex'])
    expect(autoHeal.buildSpawnCommand({ mcpOutputDir: logsDir }))
      .toContain('/opt/canary/bin/codex')
  })

  it('spawns the restarted agent by bare name when its binary is not on a known path', async () => {
    writeProjectConfig('claude')
    writeFeature('demo')
    agentProbe.binaryFound = false
    const h = harness()
    seedRun(h.runStore, 'c4')

    expect(await h.deps.restartRun!('c4')).toEqual({ ok: true, mode: 'remaining' })
    expect(agentProbe.resolved).toEqual(['claude'])
    const autoHeal = lastOpts().autoHeal as AutoHealWiring
    expect(autoHeal.buildSpawnCommand({ mcpOutputDir: logsDir })).toMatch(/^claude/)
  })
})
