import fs from 'fs'

import os from 'os'

import path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBenchmarkRunner } from './runner'

import { OFF_BY_ONE, feat, flatFixture, gitInit, makeDeps, nestedFixture, pollUntil, roots, waitForStatus } from './__fixtures__/runner-fixtures'

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

afterEach(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})

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
})
