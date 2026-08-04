// The four UI-driven controls over a run's heal phase, driven directly. The
// heal loops themselves are mocked out — this file is about the decisions the
// controls make BEFORE handing off (is there anything to pause? is the run
// already gone?), not about what the loop does afterwards.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RunContext } from './run-context'
import type { PtyHandle } from './pty-spawner'

const h = vi.hoisted(() => ({
  waitForPlaywrightExit: vi.fn(),
  recordHealEnd: vi.fn(),
  summarizeFailures: vi.fn(),
  killTree: vi.fn(),
  scheduleSigkillFallback: vi.fn(),
  appendJournalIteration: vi.fn(),
  markStoppedEarly: vi.fn(),
  prepareRun: vi.fn(),
  recordLifecycle: vi.fn(),
  runAutoHealLoop: vi.fn(),
  runManualExternalHealLoop: vi.fn(),
}))

vi.mock('./run-playwright', () => ({ waitForPlaywrightExit: h.waitForPlaywrightExit }))
vi.mock('./run-heal-agent', () => ({ recordHealEnd: h.recordHealEnd }))
vi.mock('./run-verdict', () => ({ summarizeFailures: h.summarizeFailures }))
// Spread the originals: `run-context` pulls `defaultPlaywrightSpawner` from
// this same module, so a bare factory would leave it undefined at import time.
vi.mock('./run-spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-spawn')>()),
  killTree: h.killTree,
  scheduleSigkillFallback: h.scheduleSigkillFallback,
}))
vi.mock('./run-manifest-writer', () => ({
  appendJournalIteration: h.appendJournalIteration,
  markStoppedEarly: h.markStoppedEarly,
  prepareRun: h.prepareRun,
  recordLifecycle: h.recordLifecycle,
}))
// Same reason: `orchestrator` re-imports the controls through this module.
vi.mock('./run-heal-loop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-heal-loop')>()),
  runAutoHealLoop: h.runAutoHealLoop,
  runManualExternalHealLoop: h.runManualExternalHealLoop,
}))

const { cancelHeal, continueAfterTestRun, pauseAndHeal, restartHealFromFailure } =
  await import('./run-heal-controls')
const { makeHealLoopContext, makeLoopHost } = await import('./__fixtures__/heal-loop-context')

let tmpDir: string

/** A pty whose kills are recorded rather than sent anywhere. */
function fakePty(): PtyHandle & { kills: string[] } {
  const kills: string[] = []
  return { kills, kill: vi.fn((sig: string) => { kills.push(sig) }) } as unknown as PtyHandle & { kills: string[] }
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-ctl-')))
  vi.clearAllMocks()
  h.summarizeFailures.mockReturnValue({ failed: [], total: 4 })
  h.waitForPlaywrightExit.mockResolvedValue({ exitCode: 0 })
  h.runAutoHealLoop.mockResolvedValue('passed')
  h.runManualExternalHealLoop.mockResolvedValue('passed')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function ctxFor(state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  return makeHealLoopContext({ root: tmpDir, opts, state })
}

describe('pauseAndHeal', () => {
  it('refuses when a heal cycle is already in flight', async () => {
    const { ctx } = ctxFor({ status: 'healing' })
    expect(await pauseAndHeal(ctx, makeLoopHost())).toEqual({ ok: false, reason: 'already-healing' })
  })

  it('refuses when no Playwright process is running', async () => {
    const { ctx } = ctxFor()
    expect(await pauseAndHeal(ctx, makeLoopHost())).toEqual({ ok: false, reason: 'no-playwright-running' })
  })

  it('refuses without killing Playwright when nothing has failed yet', async () => {
    const pty = fakePty()
    const { ctx } = ctxFor({ playwrightPty: pty })

    expect(await pauseAndHeal(ctx, makeLoopHost())).toEqual({ ok: false, reason: 'no-failures-yet' })
    expect(pty.kills).toEqual([])
    expect(h.markStoppedEarly).not.toHaveBeenCalled()
  })

  it('stamps the pause reason before killing, so a clean exit still triggers heal', async () => {
    const pty = fakePty()
    const { ctx, events } = ctxFor({ playwrightPty: pty })
    h.summarizeFailures.mockReturnValue({ failed: ['a', 'b'], total: 4 })

    expect(await pauseAndHeal(ctx, makeLoopHost())).toEqual({ ok: true, failureCount: 2 })
    expect(h.markStoppedEarly).toHaveBeenCalledWith(ctx, 'user-pause', 2, 4)
    expect(pty.kills).toEqual(['SIGTERM'])
    expect(events).toContainEqual({ event: 'paused-by-user', payload: { failureCount: 2 } })
    expect(h.recordLifecycle).toHaveBeenCalledWith(
      ctx, 'pausing-for-heal', 'Pause accepted',
      expect.objectContaining({ detail: expect.stringContaining('2 failures') }),
    )
  })

  it('says "1 failure" rather than "1 failures"', async () => {
    const { ctx } = ctxFor({ playwrightPty: fakePty() })
    h.summarizeFailures.mockReturnValue({ failed: ['only'], total: 4 })

    await pauseAndHeal(ctx, makeLoopHost())

    expect(h.recordLifecycle).toHaveBeenCalledWith(
      ctx, 'pausing-for-heal', 'Pause accepted',
      expect.objectContaining({ detail: expect.stringContaining('1 failure ') }),
    )
  })

  it('escalates to SIGKILL when the graceful stop times out', async () => {
    const pty = fakePty()
    const { ctx } = ctxFor({ playwrightPty: pty })
    h.summarizeFailures.mockReturnValue({ failed: ['a'], total: 4 })
    h.waitForPlaywrightExit.mockResolvedValue(null) // never exited

    expect(await pauseAndHeal(ctx, makeLoopHost())).toEqual({ ok: true, failureCount: 1 })
    expect(pty.kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(h.waitForPlaywrightExit).toHaveBeenNthCalledWith(1, ctx, 5000)
    expect(h.waitForPlaywrightExit).toHaveBeenNthCalledWith(2, ctx, 1000)
  })

  it('survives a pty that is already dead on both kill attempts', async () => {
    const pty = { kill: vi.fn(() => { throw new Error('ESRCH') }) } as unknown as RunContext['playwrightPty']
    const { ctx } = ctxFor({ playwrightPty: pty })
    h.summarizeFailures.mockReturnValue({ failed: ['a'], total: 4 })
    h.waitForPlaywrightExit.mockResolvedValue(null)

    expect(await pauseAndHeal(ctx, makeLoopHost())).toEqual({ ok: true, failureCount: 1 })
  })
})

describe('cancelHeal', () => {
  it('refuses when the run is not inside the heal loop at all', async () => {
    const { ctx } = ctxFor({ status: 'running', healCycles: 0 })
    expect(await cancelHeal(ctx, makeLoopHost())).toEqual({ ok: false, reason: 'not-healing' })
    expect(ctx.healCancelled).toBe(false)
  })

  it('is accepted while the heal agent is processing', async () => {
    const { ctx } = ctxFor({ status: 'healing' })

    expect(await cancelHeal(ctx, makeLoopHost())).toEqual({ ok: true })
    expect(ctx.healCancelled).toBe(true)
    expect(h.recordHealEnd).toHaveBeenCalledWith(ctx, expect.objectContaining({ reason: 'cancelled' }))
    expect(h.appendJournalIteration).toHaveBeenCalledWith(ctx, expect.objectContaining({ signal: '.rerun' }))
  })

  // Without this the user's click is silently 409'd until the cycle wraps back
  // round to 'healing'.
  it('is accepted during the post-heal Playwright rerun between cycles', async () => {
    const { ctx } = ctxFor({ status: 'running', healCycles: 2 })
    expect(await cancelHeal(ctx, makeLoopHost())).toEqual({ ok: true })
  })

  it('succeeds with no pty attached — that is what unwedges a dead REPL', async () => {
    const { ctx } = ctxFor({ status: 'healing' })
    expect(await cancelHeal(ctx, makeLoopHost())).toEqual({ ok: true })
    expect(h.killTree).not.toHaveBeenCalled()
  })

  it('kills whichever ptys are in flight, agent and Playwright alike', async () => {
    const agent = fakePty()
    const pw = fakePty()
    const { ctx } = ctxFor({ status: 'healing', healAgentPty: agent, playwrightPty: pw })

    await cancelHeal(ctx, makeLoopHost())

    expect(h.killTree).toHaveBeenCalledWith(agent, 'SIGTERM')
    expect(h.killTree).toHaveBeenCalledWith(pw, 'SIGTERM')
    expect(h.scheduleSigkillFallback).toHaveBeenCalledTimes(2)
  })

  it('still cancels when the best-effort journal append throws', async () => {
    const { ctx } = ctxFor({ status: 'healing' })
    h.appendJournalIteration.mockImplementation(() => { throw new Error('disk full') })

    expect(await cancelHeal(ctx, makeLoopHost())).toEqual({ ok: true })
    expect(ctx.healCancelled).toBe(true)
  })
})

describe('continueAfterTestRun', () => {
  it('does nothing more once the suite is green', async () => {
    const { ctx } = ctxFor()
    expect(await continueAfterTestRun(ctx, makeLoopHost(), 'passed')).toBe('passed')
    expect(h.runAutoHealLoop).not.toHaveBeenCalled()
    expect(h.runManualExternalHealLoop).not.toHaveBeenCalled()
  })

  for (const mode of ['manualHeal', 'externalHeal'] as const) {
    it(`routes into the manual/external loop for ${mode}`, async () => {
      const { ctx } = ctxFor({}, { [mode]: true })
      expect(await continueAfterTestRun(ctx, makeLoopHost(), 'failed')).toBe('passed')
      expect(h.runManualExternalHealLoop).toHaveBeenCalledWith(ctx, expect.anything(), 'failed')
    })
  }

  it('leaves a failed run failed when no heal mode is configured', async () => {
    const { ctx } = ctxFor()
    expect(await continueAfterTestRun(ctx, makeLoopHost(), 'failed')).toBe('failed')
    expect(h.runAutoHealLoop).not.toHaveBeenCalled()
  })

  // Without this guard auto-heal races past stop() and spawns a heal pty the
  // user has no way to interrupt — the run row already reads 'aborted'.
  it('never spawns a heal agent when the run was aborted first', async () => {
    const { ctx } = ctxFor({ stopped: true, status: 'aborted' }, { autoHeal: { maxCycles: 3 } })

    expect(await continueAfterTestRun(ctx, makeLoopHost(), 'failed')).toBe('aborted')
    expect(h.runAutoHealLoop).not.toHaveBeenCalled()
  })

  it('enters the auto-heal loop otherwise', async () => {
    const { ctx } = ctxFor({}, { autoHeal: { maxCycles: 3 } })
    expect(await continueAfterTestRun(ctx, makeLoopHost(), 'failed')).toBe('passed')
    expect(h.runAutoHealLoop).toHaveBeenCalledWith(ctx, expect.anything())
  })
})

describe('restartHealFromFailure', () => {
  it('reports failed without restarting when the run has no auto-heal config', async () => {
    const { ctx } = ctxFor()
    expect(await restartHealFromFailure(ctx, makeLoopHost(), 'try again')).toBe('failed')
    expect(h.prepareRun).not.toHaveBeenCalled()
    expect(h.runAutoHealLoop).not.toHaveBeenCalled()
  })

  it('returns the live status when the run was aborted during preparation', async () => {
    const { ctx } = ctxFor({}, { autoHeal: { maxCycles: 3 } })
    h.prepareRun.mockImplementation(() => { ctx.stopped = true; ctx.status = 'aborted' })

    expect(await restartHealFromFailure(ctx, makeLoopHost(), 'try again')).toBe('aborted')
    expect(h.runAutoHealLoop).not.toHaveBeenCalled()
  })

  it('re-enters the auto-heal loop carrying the user guidance', async () => {
    const { ctx } = ctxFor({}, { autoHeal: { maxCycles: 3 } })

    expect(await restartHealFromFailure(ctx, makeLoopHost(), 'check the cart total')).toBe('passed')
    expect(h.prepareRun).toHaveBeenCalledWith(ctx, 'stopped')
    expect(h.runAutoHealLoop).toHaveBeenCalledWith(ctx, expect.anything(), 'check the cart total')
  })
})
