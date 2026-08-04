// The orchestrator's read-only surface plus its best-effort teardown arms.
//
// Everything `stop()` does after the ptys are killed — fix capture, the auto
// PR, reversing the port overlay, removing worktrees — is deliberately
// best-effort: a failure there must never change the run's verdict or leave the
// run un-finalised. Each collaborator is mocked to reject so that promise is
// actually exercised rather than assumed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import type { OrchestratorOptions } from './run-orchestrator-types'
import type { RunContext } from './run-context'
import type { ServiceSpec } from './orchestrator'
import { RunnerLog } from './runner-log'

const h = vi.hoisted(() => ({
  ensureServicesRunning: vi.fn(),
  spawnService: vi.fn(),
  waitForHealth: vi.fn(),
  runPlaywright: vi.fn(),
  captureFixes: vi.fn(),
  reversePortifyOverlay: vi.fn(),
  removeWorktree: vi.fn(),
  autoProposeFixes: vi.fn(),
}))

vi.mock('./run-service-boot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-service-boot')>()),
  ensureServicesRunning: h.ensureServicesRunning,
  spawnService: h.spawnService,
  waitForHealth: h.waitForHealth,
}))
vi.mock('./run-playwright', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-playwright')>()),
  runPlaywright: h.runPlaywright,
}))
vi.mock('./run-fix-capture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-fix-capture')>()),
  captureFixes: h.captureFixes,
  reversePortifyOverlay: h.reversePortifyOverlay,
}))
vi.mock('./repo-worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repo-worktree')>()),
  removeWorktree: h.removeWorktree,
}))
vi.mock('../pr/auto-propose', () => ({ autoProposeFixes: h.autoProposeFixes }))

const { RunOrchestrator } = await import('./orchestrator')

let tmpDir: string
const RUN_ID = '2026-08-03T1100-tear'

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-teardown-')))
  vi.clearAllMocks()
  h.ensureServicesRunning.mockResolvedValue([])
  h.waitForHealth.mockResolvedValue(undefined)
  h.runPlaywright.mockResolvedValue(0)
  h.captureFixes.mockResolvedValue(null)
  h.reversePortifyOverlay.mockResolvedValue(undefined)
  h.removeWorktree.mockResolvedValue(undefined)
  h.autoProposeFixes.mockResolvedValue(undefined)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** A real RunnerLog (the orchestrator also calls `recordEvent` on it) with its
 *  two text levels captured, so teardown's best-effort warnings are readable. */
function spyRunnerLog(): { log: RunnerLog; warnings: string[]; infos: string[] } {
  const warnings: string[] = []
  const infos: string[] = []
  const log = new RunnerLog(path.join(tmpDir, 'runner.log'))
  vi.spyOn(log, 'warn').mockImplementation((m) => { warnings.push(m) })
  vi.spyOn(log, 'info').mockImplementation((m) => { infos.push(m) })
  return { log, warnings, infos }
}

function makeOrchestrator(over: Partial<OrchestratorOptions> = {}) {
  const featureDir = path.join(tmpDir, 'features', 'demo')
  fs.mkdirSync(featureDir, { recursive: true })
  const feature: FeatureConfig = {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir,
    repos: [],
  } as FeatureConfig
  return new RunOrchestrator({
    feature,
    env: 'local',
    runId: RUN_ID,
    runDir: path.join(tmpDir, 'logs', 'runs', RUN_ID),
    ptyFactory: () => { throw new Error('no services in these tests') },
    ...over,
  } as OrchestratorOptions)
}

describe('RunOrchestrator read-only surface', () => {
  it('exposes the run identity its callers read off it', () => {
    const orch = makeOrchestrator()

    expect(orch.runId).toBe(RUN_ID)
    expect(orch.runDir).toBe(path.join(tmpDir, 'logs', 'runs', RUN_ID))
    expect(orch.feature.name).toBe('demo')
    expect(orch.env).toBe('local')
    expect(orch.paths.manifestPath).toContain(RUN_ID)
    expect(orch.services).toEqual([])
  })

  it('reports no env when the run was started without one', () => {
    expect(makeOrchestrator({ env: undefined }).env).toBeUndefined()
  })
})

describe('recordBootFailureHealWait', () => {
  it('does nothing when no boot failure was recorded', () => {
    const orch = makeOrchestrator()
    // Called from the heal loop on every cycle whose services came up fine.
    expect(() => orch.recordBootFailureHealWait()).not.toThrow()
  })
})

describe('restartTerminalRun', () => {
  it('returns the live status when the run was aborted during start', async () => {
    const orch = makeOrchestrator()
    h.ensureServicesRunning.mockImplementation(async (ctx: RunContext) => {
      ctx.stopped = true
      ctx.status = 'aborted'
      return []
    })

    expect(await orch.restartTerminalRun()).toBe('aborted')
    expect(h.runPlaywright).not.toHaveBeenCalled()
  })

  it('returns the live status when the abort lands while Playwright reruns', async () => {
    const orch = makeOrchestrator()
    h.runPlaywright.mockImplementation(async (ctx: RunContext) => {
      ctx.stopped = true
      ctx.status = 'aborted'
      return 143
    })

    expect(await orch.restartTerminalRun()).toBe('aborted')
  })

  it('logs the guidance it was restarted with', async () => {
    const { log, infos } = spyRunnerLog()
    const orch = makeOrchestrator({ runnerLog: log })
    h.runPlaywright.mockImplementation(async (ctx: RunContext) => { ctx.stopped = true; return 0 })

    await orch.restartTerminalRun('look at the cart total')

    expect(infos).toEqual([expect.stringContaining('look at the cart total')])
  })
})

describe('restart', () => {
  /** Put services on the context directly — `buildServiceSpecs` derives them
   *  from the feature's start commands, and these tests are about the restart
   *  bookkeeping rather than the spec builder. */
  function withServices(orch: ReturnType<typeof makeOrchestrator>, specs: Partial<ServiceSpec>[]) {
    const ctx = (orch as unknown as { ctx: RunContext }).ctx
    ;(ctx as { services: ServiceSpec[] }).services = specs as ServiceSpec[]
    return ctx
  }

  it('skips the health wait entirely when the feature declares no services', async () => {
    const orch = makeOrchestrator()

    const plan = await orch.restart()

    expect(plan).toEqual({ restarted: [], kept: [], startedBecauseMissing: [] })
    expect(h.waitForHealth).not.toHaveBeenCalled()
    expect(h.spawnService).not.toHaveBeenCalled()
  })

  it('starts a service that has no live pty instead of trying to kill one', async () => {
    const orch = makeOrchestrator()
    const svc = { name: 'api', safeName: 'api', command: 'noop', cwd: tmpDir }
    const ctx = withServices(orch, [svc])
    // No entry in servicePtys — the process already exited, or a restart-heal
    // is running in a fresh orchestrator that never spawned it.
    expect(ctx.servicePtys.size).toBe(0)

    const plan = await orch.restart()

    expect(plan.startedBecauseMissing).toEqual(['api'])
    expect(h.spawnService).toHaveBeenCalledTimes(1)
    expect(h.waitForHealth).toHaveBeenCalledTimes(1)
  })

  it('kills the live pty before respawning when one is attached', async () => {
    const orch = makeOrchestrator()
    const svc = { name: 'api', safeName: 'api', command: 'noop', cwd: tmpDir }
    const ctx = withServices(orch, [svc])
    const kill = vi.fn()
    ctx.servicePtys.set('api', { kill } as never)

    const plan = await orch.restart()

    expect(kill).toHaveBeenCalledWith('SIGTERM')
    expect(ctx.servicePtys.has('api')).toBe(false)
    // It had a pty, so it was not "missing" — only the no-pty case reports that.
    expect(plan.startedBecauseMissing).toEqual([])
    expect(h.spawnService).toHaveBeenCalledTimes(1)
  })
})

describe('stop() teardown is best-effort', () => {
  it('finalises the run even when every teardown step rejects', async () => {
    const { log, warnings } = spyRunnerLog()
    const orch = makeOrchestrator({
      runnerLog: log,
      portMap: new Map([['API', 4310]]),
      worktrees: [{ repoName: 'app', localPath: tmpDir, worktreeRoot: tmpDir, sourceRoot: tmpDir }] as never,
    })
    await orch.start()
    h.captureFixes.mockRejectedValue(new Error('git exploded'))
    h.autoProposeFixes.mockRejectedValue(new Error('github unreachable'))
    h.removeWorktree.mockRejectedValue(new Error('worktree busy'))

    await expect(orch.stop('failed')).resolves.toBeUndefined()

    expect(warnings).toEqual([
      'Fix capture failed: git exploded',
      'Auto PR failed: github unreachable',
    ])
    // The worktree removal failure is swallowed entirely — it has no bearing on
    // the verdict and the Cleanup page can still remove it later.
    expect(h.removeWorktree).toHaveBeenCalledTimes(1)
  })

  it('reverses the overlay instead of removing the worktree on a portified run', async () => {
    const orch = makeOrchestrator({
      worktrees: [{ repoName: 'app', localPath: tmpDir, worktreeRoot: tmpDir, sourceRoot: tmpDir }] as never,
    })
    await orch.start()
    // `portified` is fixed at construction from the feature's saved overlay.
    // Flip it after boot: start() would otherwise refuse, because a run marked
    // portified with no readable overlay on disk must not boot un-portified.
    ;((orch as unknown as { ctx: RunContext }).ctx as { portified: boolean }).portified = true
    h.reversePortifyOverlay.mockRejectedValue(new Error('patch gone'))

    await expect(orch.stop('passed')).resolves.toBeUndefined()

    expect(h.reversePortifyOverlay).toHaveBeenCalledTimes(1)
    expect(h.removeWorktree).not.toHaveBeenCalled()
  })

  it('is idempotent — a second stop returns immediately', async () => {
    const orch = makeOrchestrator()
    await orch.start()
    await orch.stop('failed')
    h.captureFixes.mockClear()

    await orch.stop('failed')

    expect(h.captureFixes).not.toHaveBeenCalled()
  })
})
