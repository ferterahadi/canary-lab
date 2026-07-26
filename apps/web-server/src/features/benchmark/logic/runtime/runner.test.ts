import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyFactory, PtyHandle } from '../../../runs/logic/runtime/pty-spawner'
import type { FeatureConfig, RepoPrerequisite } from '../../../../../../../shared/launcher/types'
import { runGit } from '../../../../shared/git-repo'
import * as gitRepoMod from '../../../../shared/git-repo'
import * as repoWorktreeMod from '../../../runs/logic/runtime/repo-worktree'
import { createBenchmarkRunner, type BenchmarkRunnerDeps } from './runner'
import { BenchmarkRunStore } from './store'
import type { StartBenchmarkInput } from './types'

// This runner wires the REAL (tested-elsewhere) BenchmarkOrchestrator/BenchmarkRace/
// runSabotage control-flow modules to real git plumbing (worktrees, commits) against
// disposable tmp repos — the same "real git, mocked agent" pattern the sibling
// portify/logic/runtime/runner.test.ts established. Only the two genuinely
// un-unit-testable I/O edges are mocked: the agent CLI subprocess (runAgentProcess)
// and the per-arm RunOrchestrator (a real one needs a PTY + Playwright + a live
// heal loop — entirely out of scope here and already covered by its own tests).

// --- mocked agent-process (the sabotage agent's subprocess) -----------------
const amock = vi.hoisted(() => ({
  editMode: 'default' as 'default' | 'none' | 'spec',
  pending: false,
  killThrows: false,
  calls: 0,
}))

vi.mock('../../../agent-sessions/logic/agent-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../agent-sessions/logic/agent-process')>()
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runAgentProcess: vi.fn((opts: any) => {
      amock.calls += 1
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const f = require('fs') as typeof import('fs')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const p = require('path') as typeof import('path')
      try {
        if (amock.editMode === 'default') {
          f.appendFileSync(p.join(opts.cwd, 'server.js'), '\n// sabotaged by fake agent\n')
        } else if (amock.editMode === 'spec') {
          f.mkdirSync(p.join(opts.cwd, 'e2e'), { recursive: true })
          f.appendFileSync(p.join(opts.cwd, 'e2e', 'api.spec.js'), '\n// agent touched a test\n')
        }
        // 'none' → the agent makes no edits at all.
      } catch { /* best-effort, matches the real agent's failure tolerance */ }
      opts.onChunk?.('mock agent output\n', 'stdout')
      const child = { kill: amock.killThrows ? () => { throw new Error('ESRCH') } : vi.fn() }
      const done = amock.pending
        ? new Promise(() => { /* never resolves — simulates a stuck/aborted agent */ })
        : Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' })
      return { child, done, stop: vi.fn() }
    }),
  }
})

// --- mocked RunOrchestrator (each arm's run) ---------------------------------
// A real RunOrchestrator drives a PTY + Playwright + heal loop — not
// unit-coverable here. This fake exercises every closure the benchmark runner
// hands it (buildSpawnCommand) and lets each test script the terminal status
// per arm/iteration via a FIFO queue, or pause indefinitely to exercise the
// mid-race abort path (the orchRefs.stop() loop in runner.ts).
const rmock = vi.hoisted(() => ({
  statusQueue: [] as string[],
  pauseNext: false,
  throwNext: false,
  pendingResolvers: [] as Array<(s: string) => void>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instances: [] as any[],
}))

vi.mock('../../../runs/logic/runtime/orchestrator', () => {
  class RunOrchestrator {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: any
    // Rejects (like a real orchestrator's stop() legitimately can, e.g. a PTY
    // already gone) so every `.catch(() => {})` guard around a stop() call in
    // runner.ts gets genuinely exercised, not just the happy resolve path.
    stop = vi.fn(async (_status?: string) => { throw new Error('stop rejected (mock)') })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(opts: any) {
      this.opts = opts
      rmock.instances.push(this)
    }
    async runFullCycle(): Promise<string> {
      // Exercise the injected spawn-command closure for coverage — mirrors
      // what a real orchestrator does before spawning the heal agent.
      this.opts.autoHeal?.buildSpawnCommand?.({
        sessionId: 's1', resume: false, mcpOutputDir: '/tmp/mcp', promptFile: '/tmp/prompt.md',
      })
      if (rmock.throwNext) {
        rmock.throwNext = false
        throw new Error('simulated orchestrator crash')
      }
      if (rmock.pauseNext) {
        rmock.pauseNext = false
        return new Promise<string>((resolve) => { rmock.pendingResolvers.push(resolve) })
      }
      return rmock.statusQueue.shift() ?? 'passed'
    }
  }
  return {
    RunOrchestrator,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    defaultPlaywrightSpawner: (args: any) => ({ command: 'echo noop', args: [], cwd: args?.cwd ?? '.' }),
  }
})

beforeEach(() => {
  amock.editMode = 'default'
  amock.pending = false
  amock.killThrows = false
  amock.calls = 0
  rmock.statusQueue = []
  rmock.pauseNext = false
  rmock.throwNext = false
  rmock.pendingResolvers = []
  rmock.instances = []
})
afterEach(() => { vi.clearAllMocks() })

const fakePtyFactory: PtyFactory = (): PtyHandle => ({
  pid: 9_999_997,
  onData: () => ({ dispose: () => {} }),
  onExit: () => ({ dispose: () => {} }),
  write: () => {},
  resize: () => {},
  kill: () => {},
})

const roots: string[] = []
afterEach(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})

async function gitInit(dir: string): Promise<void> {
  await runGit(dir, ['init', '-q'])
  await runGit(dir, ['config', 'user.email', 't@t'])
  await runGit(dir, ['config', 'user.name', 'test'])
  await runGit(dir, ['add', '-A'])
  await runGit(dir, ['commit', '-q', '-m', 'init', '--no-verify'])
}

async function pollUntil(check: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return check()
}

async function waitForStatus(store: BenchmarkRunStore, id: string, until: string[], timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const m = store.get(id)
    if (m && until.includes(m.status)) return m.status
    await new Promise((r) => setTimeout(r, 20))
  }
  return store.get(id)?.status ?? 'missing'
}

// Self-contained layout: repo.localPath IS the git root (featureSub === '' in
// sabotage's runSabotageAgent — the ": wtRoot" ternary arm).
async function flatFixture(): Promise<{ root: string; appRepo: string; logsDir: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-flat-'))
  roots.push(root)
  const appRepo = path.join(root, 'app')
  const logsDir = path.join(root, 'logs')
  fs.mkdirSync(appRepo, { recursive: true })
  fs.writeFileSync(path.join(appRepo, 'server.js'), 'const PORT = process.env.PORT ?? 3007\n')
  await gitInit(appRepo)
  return { root, appRepo, logsDir }
}

// Nested layout: repo.localPath is a SUBDIRECTORY of the git root (featureSub
// is non-empty — the "path.join(wtRoot, featureSub)" ternary arm), and the git
// root also carries a node_modules dir so linkNodeModules takes its symlink
// branch (fs.existsSync(src) true).
async function nestedFixture(): Promise<{ root: string; gitRoot: string; appDir: string; logsDir: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-nested-'))
  roots.push(root)
  const gitRoot = path.join(root, 'mono')
  const appDir = path.join(gitRoot, 'app')
  const logsDir = path.join(root, 'logs')
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'server.js'), 'const PORT = process.env.PORT ?? 3007\n')
  await gitInit(gitRoot)
  // Created AFTER the commit so it stays untracked (real node_modules is
  // gitignored) — a `git worktree add` checkout of this repo will NOT bring
  // it along, so linkNodeModules's symlink branch actually has work to do.
  fs.mkdirSync(path.join(gitRoot, 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(gitRoot, 'node_modules', 'dep', 'index.js'), 'module.exports = {}\n')
  return { root, gitRoot, appDir, logsDir }
}

function feat(over: Partial<FeatureConfig> & { repos?: RepoPrerequisite[] } = {}): FeatureConfig {
  return {
    name: 'bench-feat',
    description: 'd',
    envs: ['local'],
    featureDir: '/f',
    repos: [{ name: 'app', localPath: '/f' }],
    ...over,
  } as FeatureConfig
}

function makeDeps(opts: {
  logsDir: string
  loadFeatures: () => FeatureConfig[]
  pickAgent?: (preferred?: 'claude' | 'codex') => 'claude' | 'codex' | null
  applyFeatureEnvset?: BenchmarkRunnerDeps['applyFeatureEnvset']
}): { store: BenchmarkRunStore; deps: BenchmarkRunnerDeps; registry: { set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }; attachRunStreams: ReturnType<typeof vi.fn>; allocateRunPorts: ReturnType<typeof vi.fn> } {
  const store = new BenchmarkRunStore(opts.logsDir)
  const registry = { set: vi.fn(), delete: vi.fn() }
  const attachRunStreams = vi.fn()
  const allocateRunPorts = vi.fn(async () => undefined)
  const deps: BenchmarkRunnerDeps = {
    projectRoot: opts.logsDir,
    logsDir: opts.logsDir,
    store,
    ptyFactory: fakePtyFactory,
    runStore: {},
    registry,
    scheduler: { fits: () => ({ ok: true }) },
    attachRunStreams,
    allocateRunPorts,
    applyFeatureEnvset: opts.applyFeatureEnvset ?? vi.fn(),
    loadFeatures: opts.loadFeatures,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pickAgent: (opts.pickAgent ?? ((preferred?: 'claude' | 'codex') => preferred ?? 'claude')) as any,
    now: () => '2026-06-07T00:00:00.000Z',
  }
  return { store, deps, registry, attachRunStreams, allocateRunPorts }
}

const OFF_BY_ONE: Pick<StartBenchmarkInput, 'skill' | 'level'> = { skill: 'off-by-one', level: 'min' }

describe('createBenchmarkRunner', () => {
  describe('start guards', () => {
    it('404s when the feature is unknown', async () => {
      const { deps } = makeDeps({ logsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bench-g-')), loadFeatures: () => [] })
      const { startBenchmark } = createBenchmarkRunner(deps)
      await expect(startBenchmark({ feature: 'nope', iterations: 1, ...OFF_BY_ONE }))
        .rejects.toMatchObject({ statusCode: 404 })
    })

    it('409s when no agent CLI is available, naming the requested agent', async () => {
      const { deps } = makeDeps({
        logsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bench-g-')),
        loadFeatures: () => [feat()],
        pickAgent: () => null,
      })
      const { startBenchmark } = createBenchmarkRunner(deps)
      await expect(startBenchmark({ feature: 'bench-feat', agent: 'codex', iterations: 1, ...OFF_BY_ONE }))
        .rejects.toThrow(/the codex CLI is not available/)
    })

    it('409s when no agent CLI is available, without naming an agent', async () => {
      const { deps } = makeDeps({
        logsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bench-g-')),
        loadFeatures: () => [feat()],
        pickAgent: () => null,
      })
      const { startBenchmark } = createBenchmarkRunner(deps)
      await expect(startBenchmark({ feature: 'bench-feat', iterations: 1, ...OFF_BY_ONE }))
        .rejects.toThrow(/a claude\/codex CLI is not available/)
    })

    it('404s when the sabotage skill is unknown', async () => {
      const { deps } = makeDeps({ logsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bench-g-')), loadFeatures: () => [feat()] })
      const { startBenchmark } = createBenchmarkRunner(deps)
      await expect(startBenchmark({
        feature: 'bench-feat', iterations: 1, skill: 'not-a-real-skill', level: 'zzz' as never,
      })).rejects.toMatchObject({ statusCode: 404 })
    })

    it('409s when the feature declares an empty repos array', async () => {
      const { deps } = makeDeps({ logsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bench-g-')), loadFeatures: () => [feat({ repos: [] })] })
      const { startBenchmark } = createBenchmarkRunner(deps)
      await expect(startBenchmark({ feature: 'bench-feat', iterations: 1, ...OFF_BY_ONE }))
        .rejects.toMatchObject({ statusCode: 409 })
    })

    it('409s when repos is undefined', async () => {
      const { deps } = makeDeps({ logsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bench-g-')), loadFeatures: () => [feat({ repos: undefined })] })
      const { startBenchmark } = createBenchmarkRunner(deps)
      await expect(startBenchmark({ feature: 'bench-feat', iterations: 1, ...OFF_BY_ONE }))
        .rejects.toMatchObject({ statusCode: 409 })
    })

    it('409s when the sabotaged repo is not a git repository', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-nogit-'))
      roots.push(dir)
      const { deps } = makeDeps({
        logsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bench-g-')),
        loadFeatures: () => [feat({ repos: [{ name: 'app', localPath: dir }] })],
      })
      const { startBenchmark } = createBenchmarkRunner(deps)
      await expect(startBenchmark({ feature: 'bench-feat', iterations: 1, ...OFF_BY_ONE }))
        .rejects.toThrow(/not a git repository/)
    })

    it('409s when the sabotaged repo has uncommitted changes', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-dirty-'))
      roots.push(dir)
      fs.writeFileSync(path.join(dir, 'f.txt'), 'a')
      await gitInit(dir)
      fs.writeFileSync(path.join(dir, 'f.txt'), 'changed')
      const { deps } = makeDeps({
        logsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bench-g-')),
        loadFeatures: () => [feat({ repos: [{ name: 'app', localPath: dir }] })],
      })
      const { startBenchmark } = createBenchmarkRunner(deps)
      await expect(startBenchmark({ feature: 'bench-feat', iterations: 1, ...OFF_BY_ONE }))
        .rejects.toThrow(/uncommitted changes/)
    })
  })

  describe('fire-and-forget pipeline', () => {
    it('swallows a rejected orchestrator run so the route still returns an id', async () => {
      // startBenchmark kicks the pipeline off with `void orchestrator.run().catch()`.
      // The orchestrator turns its own phase failures into an 'error' manifest,
      // but its very FIRST persist happens before that try block — so a manifest
      // write that throws rejects run() itself. Without the .catch that is an
      // unhandled rejection, which is why this asserts on the absence of one.
      const { appRepo, logsDir } = await flatFixture()
      const { store, deps } = makeDeps({
        logsDir,
        loadFeatures: () => [feat({ featureDir: appRepo, repos: [{ name: 'app', localPath: appRepo }] })],
      })
      const realSave = store.save.bind(store)
      let saves = 0
      vi.spyOn(store, 'save').mockImplementation((m) => {
        saves += 1
        // Save 1 is startBenchmark's own initial manifest — let it through so
        // the id is readable. Every later one is the orchestrator's persist.
        if (saves > 1) throw new Error('manifest write failed')
        realSave(m)
      })
      const { startBenchmark } = createBenchmarkRunner(deps)

      const { benchmarkId } = await startBenchmark({ feature: 'bench-feat', agent: 'claude', iterations: 1, ...OFF_BY_ONE })
      expect(benchmarkId).toBeTruthy()
      // The caller got its id even though the background pipeline died.
      expect(store.get(benchmarkId)).toBeTruthy()
      // Give the rejected run() a turn to settle.
      await new Promise((resolve) => setImmediate(resolve))
      expect(saves).toBeGreaterThan(1)
    })
  })

  describe('sabotage failures (no arms are ever started)', () => {
    it('errors when the agent makes no edits at all (freeze finds nothing to commit)', async () => {
      const { appRepo, logsDir } = await flatFixture()
      amock.editMode = 'none'
      const { store, deps } = makeDeps({ logsDir, loadFeatures: () => [feat({ featureDir: appRepo, repos: [{ name: 'app', localPath: appRepo }] })] })
      const { startBenchmark } = createBenchmarkRunner(deps)
      const { benchmarkId } = await startBenchmark({ feature: 'bench-feat', agent: 'claude', iterations: 1, ...OFF_BY_ONE })
      expect(await waitForStatus(store, benchmarkId, ['error', 'invalid', 'done', 'aborted'])).toBe('error')
      expect(store.get(benchmarkId)!.error).toMatch(/did not edit the code/)
      // No arm ever ran.
      expect(rmock.instances).toHaveLength(0)
    })

    it('tolerates the sabotage-agent log file failing to open (out stays null; onChunk/cleanup no-op)', async () => {
      // Simulates a real failure mode (e.g. disk full / permission denied)
      // opening `sabotage-agent.log` — runAgentHeadless must still complete
      // the agent run, just without teeing output to disk.
      const openSyncSpy = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw new Error('EACCES (mock)') })
      const { appRepo, logsDir } = await flatFixture()
      amock.editMode = 'none'
      const { store, deps } = makeDeps({ logsDir, loadFeatures: () => [feat({ featureDir: appRepo, repos: [{ name: 'app', localPath: appRepo }] })] })
      const { startBenchmark } = createBenchmarkRunner(deps)
      const { benchmarkId } = await startBenchmark({ feature: 'bench-feat', agent: 'claude', iterations: 1, ...OFF_BY_ONE })
      expect(await waitForStatus(store, benchmarkId, ['error', 'invalid', 'done', 'aborted'])).toBe('error')
      expect(openSyncSpy).toHaveBeenCalled()
      openSyncSpy.mockRestore()
    })

    it('errors when the agent edits a test file (no-cheat violation)', async () => {
      // `testsUntouched` diffs against HEAD, which only shows changes to
      // TRACKED files — so the pre-existing spec file must already be
      // committed for the agent's edit to register as a modification.
      const { appRepo, logsDir } = await flatFixture()
      fs.mkdirSync(path.join(appRepo, 'e2e'), { recursive: true })
      fs.writeFileSync(path.join(appRepo, 'e2e', 'api.spec.js'), '// test\n')
      await runGit(appRepo, ['add', '-A'])
      await runGit(appRepo, ['commit', '-q', '-m', 'add spec', '--no-verify'])
      amock.editMode = 'spec'
      const { store, deps } = makeDeps({ logsDir, loadFeatures: () => [feat({ featureDir: appRepo, repos: [{ name: 'app', localPath: appRepo }] })] })
      const { startBenchmark } = createBenchmarkRunner(deps)
      const { benchmarkId } = await startBenchmark({ feature: 'bench-feat', agent: 'claude', iterations: 1, ...OFF_BY_ONE })
      expect(await waitForStatus(store, benchmarkId, ['error', 'invalid', 'done', 'aborted'])).toBe('error')
      expect(store.get(benchmarkId)!.error).toMatch(/no-cheat violation/)
      expect(rmock.instances).toHaveLength(0)
    })

    it('errors when the freeze commit itself fails (nonzero git exit)', async () => {
      // The agent edits code (staged diff is non-empty, so freeze reaches the
      // commit) but the `git commit` returns nonzero — a real failure mode
      // (e.g. a corrupt index). Every other git call (status pre-flight, add,
      // staged-diff) passes through to real git; only the commit is forced to
      // fail, so we exercise the `if (commit.code !== 0)` throw specifically.
      const { appRepo, logsDir } = await flatFixture()
      const realRunGit = (
        await vi.importActual<typeof import('../../../../shared/git-repo')>('../../../../shared/git-repo')
      ).runGit
      const spy = vi.spyOn(gitRepoMod, 'runGit').mockImplementation(async (dir, args) =>
        args.includes('commit') ? { code: 1, stdout: '', stderr: 'commit blew up' } : realRunGit(dir, args),
      )
      try {
        const { store, deps } = makeDeps({ logsDir, loadFeatures: () => [feat({ featureDir: appRepo, repos: [{ name: 'app', localPath: appRepo }] })] })
        const { startBenchmark } = createBenchmarkRunner(deps)
        const { benchmarkId } = await startBenchmark({ feature: 'bench-feat', agent: 'claude', iterations: 1, ...OFF_BY_ONE })
        expect(await waitForStatus(store, benchmarkId, ['error', 'invalid', 'done', 'aborted'])).toBe('error')
        expect(store.get(benchmarkId)!.error).toMatch(/freeze commit failed/)
        expect(store.get(benchmarkId)!.error).toContain('commit blew up')
        // Freeze failed before any arm was set up.
        expect(rmock.instances).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    })

    it('surfaces the freeze commit stdout when the failure has no stderr', async () => {
      // Same failure path, but the failing commit wrote to stdout with an empty
      // stderr — exercises the `commit.stderr || commit.stdout` fallback arm of
      // the thrown message.
      const { appRepo, logsDir } = await flatFixture()
      const realRunGit = (
        await vi.importActual<typeof import('../../../../shared/git-repo')>('../../../../shared/git-repo')
      ).runGit
      const spy = vi.spyOn(gitRepoMod, 'runGit').mockImplementation(async (dir, args) =>
        args.includes('commit') ? { code: 1, stdout: 'nothing to commit on stdout', stderr: '' } : realRunGit(dir, args),
      )
      try {
        const { store, deps } = makeDeps({ logsDir, loadFeatures: () => [feat({ featureDir: appRepo, repos: [{ name: 'app', localPath: appRepo }] })] })
        const { startBenchmark } = createBenchmarkRunner(deps)
        const { benchmarkId } = await startBenchmark({ feature: 'bench-feat', agent: 'claude', iterations: 1, ...OFF_BY_ONE })
        expect(await waitForStatus(store, benchmarkId, ['error', 'invalid', 'done', 'aborted'])).toBe('error')
        expect(store.get(benchmarkId)!.error).toContain('nothing to commit on stdout')
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('full pipeline', () => {
    it('runs 2 arms x 2 iterations to done, differentiating a healed harness arm from a never-healed baseline arm', async () => {
      const { gitRoot, appDir, logsDir } = await nestedFixture()
      const symlinkSpy = vi.spyOn(fs, 'symlinkSync')
      // A (harness) heals every iteration; B (baseline) never does — proves the
      // report distinguishes them and avoids the iteration-1 "sabotage no-op" guard.
      rmock.statusQueue = ['passed', 'failed', 'passed', 'failed']
      let envsetCalls = 0
      const { store, deps, attachRunStreams, allocateRunPorts } = makeDeps({
        logsDir,
        loadFeatures: () => [feat({ featureDir: appDir, envs: ['local'], repos: [{ name: 'app', localPath: appDir }] })],
        // Deliberately throws — applyFeatureEnvset is best-effort (wrapped in
        // try/catch in runner.ts) so this must not abort the arm.
        applyFeatureEnvset: () => { envsetCalls += 1; throw new Error('no envset here') },
      })
      const { startBenchmark } = createBenchmarkRunner(deps)
      const { benchmarkId } = await startBenchmark({
        feature: 'bench-feat', agent: 'claude', iterations: 2, ...OFF_BY_ONE,
      })

      expect(await waitForStatus(store, benchmarkId, ['done', 'error', 'invalid', 'aborted'], 15000)).toBe('done')
      const m = store.get(benchmarkId)!
      expect(m.sabotageSha).toBeTruthy()
      expect(m.results).toHaveLength(4)
      expect(m.report!.harness.iterationsHealed).toBe(2)
      expect(m.report!.baseline.iterationsHealed).toBe(0)
      expect(m.arms.find((a) => a.arm === 'A')!.worktreePath).toBeTruthy()
      expect(m.arms.find((a) => a.arm === 'B')!.worktreePath).toBeTruthy()
      // Both arms ran both iterations: 4 real (mocked) RunOrchestrator instances.
      expect(rmock.instances).toHaveLength(4)
      expect(attachRunStreams).toHaveBeenCalledTimes(4)
      expect(allocateRunPorts).toHaveBeenCalledTimes(4)
      expect(envsetCalls).toBe(4) // env is truthy → applyFeatureEnvset attempted every arm
      expect(deps.registry.delete).toHaveBeenCalledTimes(4)

      // The frozen sabotage diff was written to disk.
      const diffPath = path.join(logsDir, 'benchmarks', benchmarkId, 'sabotage.diff')
      expect(fs.readFileSync(diffPath, 'utf-8')).toContain('sabotaged by fake agent')

      // node_modules was symlinked into the arm worktrees from the git root.
      // node_modules was symlinked from the git root into BOTH arm worktrees
      // (setupArms runs before the race). Asserted via the symlinkSync call
      // itself, not post-hoc fs.existsSync — `resetArms`'s `git clean -fd`
      // between iterations removes the untracked symlink again, which is a
      // real (separate) behavior of the pipeline, not a test bug.
      expect(symlinkSpy).toHaveBeenCalledTimes(2)
      // realpath'd — git's toplevel resolves symlinks (e.g. macOS /var -> /private/var).
      expect(symlinkSpy.mock.calls[0][0]).toBe(path.join(fs.realpathSync(gitRoot), 'node_modules'))

      // Calling abort() on an already-terminal benchmark is a no-op (doesn't
      // clobber the terminal status or endedAt).
      const before = store.get(benchmarkId)!
      const { abort } = createBenchmarkRunner(deps) // fresh runner instance sharing the same store
      abort(benchmarkId)
      expect(store.get(benchmarkId)).toEqual(before)

      void gitRoot // referenced only for fixture symmetry
    })

    it('records an arm as unhealed (not aborted overall) when its RunOrchestrator throws', async () => {
      // Arm A's runFullCycle throws (simulating a crashed orchestrator); the
      // per-arm try/catch in runArm() converts that into a failed iteration
      // (not a benchmark-level crash) — the benchmark still reaches 'done'.
      const { appDir, logsDir } = await nestedFixture()
      rmock.throwNext = true // consumed by arm A only
      rmock.statusQueue = ['passed'] // arm B
      const { store, deps } = makeDeps({
        logsDir,
        loadFeatures: () => [feat({ featureDir: appDir, repos: [{ name: 'app', localPath: appDir }] })],
      })
      const { startBenchmark } = createBenchmarkRunner(deps)
      const { benchmarkId } = await startBenchmark({ feature: 'bench-feat', agent: 'claude', iterations: 1, ...OFF_BY_ONE })

      expect(await waitForStatus(store, benchmarkId, ['done', 'error', 'invalid', 'aborted'], 15000)).toBe('done')
      const m = store.get(benchmarkId)!
      const armA = m.results.find((r) => r.arm === 'A')!
      expect(armA.healed).toBe(false)
      expect(armA.healCycles).toBe(0)
      // The crashed arm's orchestrator was still told to stop('aborted') from
      // the catch branch (not the normal status-based stop call).
      expect(rmock.instances[0].stop).toHaveBeenCalledWith('aborted')
    })

    it('resetArms skips an arm whose worktree handle has no root', async () => {
      // Force arm-B's worktree handle to report an empty worktreeRoot. Between
      // iterations, resetArms must skip it via `if (!root) continue` rather than
      // shelling `git reset` with an empty cwd — which would reject, bubble out
      // of the race, and finalize the benchmark as 'error'. Reaching 'done' (with
      // both arms still having run both iterations) proves the guard held.
      const { appRepo, logsDir } = await flatFixture()
      const realAddWorktree = (
        await vi.importActual<typeof import('../../../runs/logic/runtime/repo-worktree')>('../../../runs/logic/runtime/repo-worktree')
      ).addWorktree
      const spy = vi.spyOn(repoWorktreeMod, 'addWorktree').mockImplementation(async (opts) => {
        const handle = await realAddWorktree(opts)
        return opts.worktreesDir.includes(`${path.sep}arm-B`) ? { ...handle, worktreeRoot: '' } : handle
      })
      // 2 iterations x 2 arms: iteration 1 has exactly one pass + one fail, so
      // the no-op-sabotage guard (both-arms-passed-unhealed) never trips.
      rmock.statusQueue = ['passed', 'failed', 'passed', 'failed']
      try {
        const { store, deps } = makeDeps({
          logsDir,
          loadFeatures: () => [feat({ featureDir: appRepo, envs: undefined, repos: [{ name: 'app', localPath: appRepo }] })],
        })
        const { startBenchmark } = createBenchmarkRunner(deps)
        const { benchmarkId } = await startBenchmark({ feature: 'bench-feat', agent: 'claude', iterations: 2, ...OFF_BY_ONE })
        expect(await waitForStatus(store, benchmarkId, ['done', 'error', 'invalid', 'aborted'], 15000)).toBe('done')
        // Both arms ran both iterations — the guard skipped only the reset.
        expect(rmock.instances).toHaveLength(4)
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('abort', () => {
    it('is a no-op for an unknown benchmarkId', () => {
      const { deps } = makeDeps({ logsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bench-a-')), loadFeatures: () => [] })
      const { abort } = createBenchmarkRunner(deps)
      expect(() => abort('nope')).not.toThrow()
    })

    it('rejects a concurrent second benchmark, then frees the slot and kills the stuck agent child (kill throws are swallowed)', async () => {
      const { appRepo, logsDir } = await flatFixture()
      amock.pending = true // the sabotage agent subprocess never exits
      amock.killThrows = true // exercises the try/catch around c.kill()
      const { store, deps } = makeDeps({
        logsDir,
        loadFeatures: () => [feat({ featureDir: appRepo, repos: [{ name: 'app', localPath: appRepo }] })],
      })
      const { startBenchmark, abort } = createBenchmarkRunner(deps)

      const { benchmarkId } = await startBenchmark({ feature: 'bench-feat', agent: 'codex', iterations: 1, ...OFF_BY_ONE })
      expect(await pollUntil(() => amock.calls > 0)).toBe(true)

      await expect(startBenchmark({ feature: 'bench-feat', agent: 'codex', iterations: 1, ...OFF_BY_ONE }))
        .rejects.toMatchObject({ statusCode: 409 })

      abort(benchmarkId)
      expect(store.get(benchmarkId)!.status).toBe('aborted')
    })

    it('mid-race abort stops the live arm RunOrchestrator via orchRefs and marks the benchmark aborted', async () => {
      // Uses the flat (no node_modules) fixture — the complement of the
      // full-pipeline test's nested/node_modules-present fixture — so
      // linkNodeModules's "nothing to symlink" branch gets exercised too.
      const { appRepo, logsDir } = await flatFixture()
      rmock.pauseNext = true // arm A's runFullCycle hangs until we resolve it
      const { store, deps } = makeDeps({
        logsDir,
        // No envs declared: exercises the `if (env)` FALSE branch (the
        // complement of the full-pipeline test's TRUE branch).
        loadFeatures: () => [feat({ featureDir: appRepo, envs: undefined, repos: [{ name: 'app', localPath: appRepo }] })],
      })
      const { startBenchmark, abort } = createBenchmarkRunner(deps)

      const { benchmarkId } = await startBenchmark({ feature: 'bench-feat', agent: 'claude', iterations: 1, ...OFF_BY_ONE })
      expect(await pollUntil(() => rmock.instances.length > 0, 15000)).toBe(true)

      abort(benchmarkId)
      expect(rmock.instances[0].stop).toHaveBeenCalledWith('aborted')
      expect(store.get(benchmarkId)!.status).toBe('aborted')

      // Let arm A's paused runFullCycle resolve so the background pipeline
      // (which also runs arm B — race.ts has no isAborted check between arms
      // within one iteration) drains cleanly before the test ends.
      rmock.pendingResolvers[0]?.('aborted')
      await pollUntil(() => rmock.instances.length >= 2, 15000)
    })
  })
})
