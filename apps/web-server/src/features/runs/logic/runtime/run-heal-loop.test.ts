// Drives `runAutoHealLoop` / `runManualExternalHealLoop` directly rather than
// through a live RunOrchestrator. Every collaborator that touches a pty, a
// child process or the filesystem is mocked, which turns the loop into pure
// control flow: a mocked `runPlaywright` can flip `ctx.stopped` before it
// returns, so the abort windows between awaits are ordinary assignments here
// instead of the timing races they are in a full-orchestrator test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { HealSignal } from '../../../../../../../shared/run-state'
import type { RunContext } from './run-context'
import type { VerificationPlan } from './run-verdict'

const h = vi.hoisted(() => ({
  runPlaywright: vi.fn(),
  verificationPlanForSummary: vi.fn(),
  runHealAgent: vi.fn(),
  waitForHealSignal: vi.fn(),
  persistAgentSessionRef: vi.fn(),
  cleanupHealAgentPty: vi.fn(),
  emitAgentSystemMessage: vi.fn(),
  captureHealAgentCause: vi.fn(),
  recordHealEnd: vi.fn(),
  ensureServicesRunning: vi.fn(),
  snapshotFeatureRepos: vi.fn(),
  diffFeatureRepos: vi.fn(),
  diffContentForFeatureRepos: vi.fn(),
  readSummary: vi.fn(),
  extractFailedSlugs: vi.fn(),
  decideRunStatus: vi.fn(),
  summarizeFailures: vi.fn(),
  summaryHasPassingEvidence: vi.fn(),
  computeVerificationPlan: vi.fn(),
  nonPassedSignatureFromPlan: vi.fn(),
  selectionForPlan: vi.fn(),
  appendJournalIteration: vi.fn(),
  markStoppedEarly: vi.fn(),
  recordLifecycle: vi.fn(),
}))

vi.mock('./run-playwright', () => ({
  runPlaywright: h.runPlaywright,
  verificationPlanForSummary: h.verificationPlanForSummary,
}))
vi.mock('./run-heal-agent', () => ({
  runHealAgent: h.runHealAgent,
  waitForHealSignal: h.waitForHealSignal,
  persistAgentSessionRef: h.persistAgentSessionRef,
  cleanupHealAgentPty: h.cleanupHealAgentPty,
  emitAgentSystemMessage: h.emitAgentSystemMessage,
  captureHealAgentCause: h.captureHealAgentCause,
  recordHealEnd: h.recordHealEnd,
}))
vi.mock('./run-service-boot', () => ({ ensureServicesRunning: h.ensureServicesRunning }))
vi.mock('./feature-repo-diff', () => ({
  snapshotFeatureRepos: h.snapshotFeatureRepos,
  diffFeatureRepos: h.diffFeatureRepos,
  diffContentForFeatureRepos: h.diffContentForFeatureRepos,
}))
vi.mock('./run-verdict', () => ({
  readSummary: h.readSummary,
  extractFailedSlugs: h.extractFailedSlugs,
  decideRunStatus: h.decideRunStatus,
  summarizeFailures: h.summarizeFailures,
  summaryHasPassingEvidence: h.summaryHasPassingEvidence,
  computeVerificationPlan: h.computeVerificationPlan,
  nonPassedSignatureFromPlan: h.nonPassedSignatureFromPlan,
  selectionForPlan: h.selectionForPlan,
}))
// `setStatus` and `noteHealCycle` are the two manifest writers whose effect on
// the context the loop reads back, so the mocks keep that and drop the disk
// write. The rest are pure spies.
vi.mock('./run-manifest-writer', () => ({
  appendJournalIteration: h.appendJournalIteration,
  markStoppedEarly: h.markStoppedEarly,
  noteHealCycle: vi.fn((ctx: RunContext) => { ctx.healCycles += 1 }),
  recordLifecycle: h.recordLifecycle,
  setStatus: vi.fn((ctx: RunContext, status: RunContext['status']) => { ctx.status = status }),
}))

const { runAutoHealLoop, runManualExternalHealLoop } = await import('./run-heal-loop')
const { makeHealLoopContext, makeLoopHost } = await import('./__fixtures__/heal-loop-context')

let tmpDir: string

const ALL_PASSED: VerificationPlan = { kind: 'all-passed', total: 3 }
const FULL_SUITE: VerificationPlan = { kind: 'full-suite', reason: 'no known tests', total: 3 }
function targeted(skipped: string[]): VerificationPlan {
  return {
    kind: 'targeted',
    selection: { files: [], titles: [] },
    failedFirst: [],
    skipped: skipped.map((name) => ({ name })),
    pending: [],
    total: 3,
  } as unknown as VerificationPlan
}

function rerunSignal(body: Record<string, unknown> = {}): HealSignal {
  return { kind: 'rerun', body }
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-loop-')))
  vi.clearAllMocks()
  // Defaults: nothing failing, no services missing, no files changed.
  h.readSummary.mockReturnValue({})
  h.extractFailedSlugs.mockReturnValue([])
  h.summarizeFailures.mockReturnValue({ failed: [], total: 3 })
  h.summaryHasPassingEvidence.mockReturnValue(true)
  h.verificationPlanForSummary.mockReturnValue(ALL_PASSED)
  h.computeVerificationPlan.mockReturnValue(ALL_PASSED)
  h.nonPassedSignatureFromPlan.mockReturnValue('sig')
  h.selectionForPlan.mockReturnValue({ files: [], titles: [] })
  h.ensureServicesRunning.mockResolvedValue([])
  h.snapshotFeatureRepos.mockResolvedValue([])
  h.diffFeatureRepos.mockResolvedValue([])
  h.diffContentForFeatureRepos.mockResolvedValue('')
  h.decideRunStatus.mockReturnValue('failed')
  h.runPlaywright.mockResolvedValue(1)
  h.captureHealAgentCause.mockReturnValue(undefined)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function ctxFor(state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  return makeHealLoopContext({ root: tmpDir, opts, state })
}

// ───────────────────────── manual / external loop ─────────────────────────

describe('runManualExternalHealLoop', () => {
  it('gives up as failed when the 24h wait returns no signal', async () => {
    const { ctx } = ctxFor({ manualHeal: true } as Partial<RunContext>)
    h.waitForHealSignal.mockResolvedValue({ signal: undefined })

    const status = await runManualExternalHealLoop(ctx, makeLoopHost(), 'failed')

    expect(status).toBe('failed')
    expect(ctx.status).toBe('failed')
    expect(h.runPlaywright).not.toHaveBeenCalled()
  })

  it('bails as failed when the user cancelled while we waited', async () => {
    const { ctx } = ctxFor()
    h.waitForHealSignal.mockImplementation(async () => {
      ctx.healCancelled = true
      return { signal: rerunSignal() }
    })

    expect(await runManualExternalHealLoop(ctx, makeLoopHost(), 'failed')).toBe('failed')
    expect(h.runPlaywright).not.toHaveBeenCalled()
  })

  it('drops a non-string hypothesis/fixDescription from the journal entry', async () => {
    const { ctx } = ctxFor()
    h.waitForHealSignal.mockResolvedValue({
      signal: rerunSignal({ hypothesis: 123, fixDescription: { nope: true } }),
    })
    h.decideRunStatus.mockReturnValue('passed')

    await runManualExternalHealLoop(ctx, makeLoopHost(), 'failed')

    expect(h.appendJournalIteration).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ signal: '.rerun', hypothesis: undefined, fixDescription: undefined }),
    )
  })

  it('journals a string hypothesis and fixDescription verbatim', async () => {
    const { ctx } = ctxFor()
    h.waitForHealSignal.mockResolvedValue({
      signal: rerunSignal({ hypothesis: 'off-by-one in the cart total', fixDescription: 'clamped the index' }),
    })
    h.decideRunStatus.mockReturnValue('passed')

    await runManualExternalHealLoop(ctx, makeLoopHost(), 'failed')

    expect(h.appendJournalIteration).toHaveBeenCalledWith(ctx, expect.objectContaining({
      hypothesis: 'off-by-one in the cart total',
      fixDescription: 'clamped the index',
    }))
  })

  it('names the external client rather than a human when externalHeal is set', async () => {
    const { ctx, events } = ctxFor({}, { externalHeal: true })
    h.waitForHealSignal.mockResolvedValue({ signal: { kind: 'restart', body: {} } })
    h.decideRunStatus.mockReturnValue('passed')

    await runManualExternalHealLoop(ctx, makeLoopHost(), 'failed')

    expect(events).toContainEqual({ event: 'agent-started', payload: { cycle: 1, command: '<external>' } })
    expect(h.recordLifecycle).toHaveBeenCalledWith(
      ctx,
      'agent-healing',
      'External heal cycle 1 started',
      expect.objectContaining({ detail: expect.stringContaining('external AI client') }),
    )
    // `.restart` journal shape, distinct from the `.rerun` cases above.
    expect(h.appendJournalIteration).toHaveBeenCalledWith(ctx, expect.objectContaining({ signal: '.restart' }))
  })

  it('returns the live status when the run is aborted during the restart', async () => {
    const { ctx } = ctxFor()
    h.waitForHealSignal.mockResolvedValue({ signal: { kind: 'restart', body: {} } })
    const host = makeLoopHost({
      restart: vi.fn(async () => {
        ctx.stopped = true
        ctx.status = 'aborted'
        return { restarted: [], kept: [], startedBecauseMissing: [] }
      }),
    })

    expect(await runManualExternalHealLoop(ctx, host, 'failed')).toBe('aborted')
    expect(host.restart).toHaveBeenCalled()
    expect(h.runPlaywright).not.toHaveBeenCalled()
  })

  it('records a lifecycle note when services had to be started before the rerun', async () => {
    const { ctx } = ctxFor()
    h.waitForHealSignal.mockResolvedValue({ signal: rerunSignal() })
    h.ensureServicesRunning.mockResolvedValue(['api', 'web'])
    h.decideRunStatus.mockReturnValue('passed')

    expect(await runManualExternalHealLoop(ctx, makeLoopHost(), 'failed')).toBe('passed')
    expect(h.recordLifecycle).toHaveBeenCalledWith(
      ctx,
      'restarting-services',
      'Started missing services',
      expect.objectContaining({ detail: 'Started api, web before rerun.' }),
    )
  })

  it('waits again without judging the suite when the services failed to boot', async () => {
    const { ctx } = ctxFor()
    let cycle = 0
    h.waitForHealSignal.mockImplementation(async () => {
      cycle += 1
      if (cycle === 1) ctx.bootFailure = { service: 'api' } as RunContext['bootFailure']
      else ctx.bootFailure = undefined
      return { signal: rerunSignal() }
    })
    h.decideRunStatus.mockReturnValue('passed')
    const host = makeLoopHost()

    expect(await runManualExternalHealLoop(ctx, host, 'failed')).toBe('passed')
    expect(host.recordBootFailureHealWait).toHaveBeenCalledTimes(1)
    expect(h.runPlaywright).toHaveBeenCalledTimes(1)
  })

  it('returns the live status when the abort lands while Playwright is running', async () => {
    const { ctx } = ctxFor()
    h.waitForHealSignal.mockResolvedValue({ signal: rerunSignal() })
    h.runPlaywright.mockImplementation(async () => {
      ctx.stopped = true
      ctx.status = 'aborted'
      return 143
    })

    expect(await runManualExternalHealLoop(ctx, makeLoopHost(), 'failed')).toBe('aborted')
    expect(h.decideRunStatus).not.toHaveBeenCalled()
  })

  it('journals nothing for a bare `heal` signal but still reruns', async () => {
    const { ctx } = ctxFor()
    h.waitForHealSignal.mockResolvedValue({ signal: { kind: 'heal', body: {} } })
    h.decideRunStatus.mockReturnValue('passed')
    const host = makeLoopHost()

    expect(await runManualExternalHealLoop(ctx, host, 'failed')).toBe('passed')
    expect(h.appendJournalIteration).not.toHaveBeenCalled()
    expect(host.rerun).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting for another signal while the suite is still red', async () => {
    const { ctx } = ctxFor()
    h.waitForHealSignal.mockResolvedValue({ signal: rerunSignal() })
    h.decideRunStatus.mockReturnValueOnce('failed').mockReturnValueOnce('passed')

    expect(await runManualExternalHealLoop(ctx, makeLoopHost(), 'failed')).toBe('passed')
    expect(h.waitForHealSignal).toHaveBeenCalledTimes(2)
    expect(h.runPlaywright).toHaveBeenCalledTimes(2)
  })
})

// ─────────────────────────────── auto loop ────────────────────────────────

describe('runAutoHealLoop', () => {
  const AUTO = { maxCycles: 3 }

  it('refuses to run at all without an autoHeal config', async () => {
    const { ctx } = ctxFor()
    expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('failed')
    expect(h.cleanupHealAgentPty).not.toHaveBeenCalled()
  })

  it('falls back to the shipped cycle cap when the run pins no maxCycles', async () => {
    const { ctx, sink } = ctxFor({}, { autoHeal: {} })
    h.extractFailedSlugs.mockReturnValue([])

    await runAutoHealLoop(ctx, makeLoopHost())

    // Clearing a stale give-up reason is the loop's first act; reaching it
    // proves the HealCycleState was constructed with the default cap.
    expect(sink.patches[0]).toEqual({ healEnd: undefined })
  })

  it('stops early when the feature pins a heal-on-failure threshold', async () => {
    const { ctx } = ctxFor({}, { autoHeal: AUTO })
    Object.assign(ctx.feature, { healOnFailureThreshold: 2 })
    h.summarizeFailures.mockReturnValue({ failed: ['a', 'b'], total: 5 })

    await runAutoHealLoop(ctx, makeLoopHost())

    expect(h.markStoppedEarly).toHaveBeenCalledWith(ctx, 'max-failures', 2, 5)
  })

  it('leaves the run alone when the failure count is under that threshold', async () => {
    const { ctx } = ctxFor({}, { autoHeal: AUTO })
    Object.assign(ctx.feature, { healOnFailureThreshold: 5 })
    h.summarizeFailures.mockReturnValue({ failed: ['a'], total: 5 })

    await runAutoHealLoop(ctx, makeLoopHost())

    expect(h.markStoppedEarly).not.toHaveBeenCalled()
  })

  it('does not claim a pass when the summary carries no passing evidence', async () => {
    const { ctx } = ctxFor({}, { autoHeal: AUTO })
    h.summaryHasPassingEvidence.mockReturnValue(false)

    expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('failed')
    expect(ctx.status).not.toBe('passed')
  })

  it('returns the live status when the run was aborted before the first cycle', async () => {
    const { ctx } = ctxFor({ stopped: true, status: 'aborted' }, { autoHeal: AUTO })

    expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('aborted')
    // The `finally` still drops the REPL, however the loop left.
    expect(h.cleanupHealAgentPty).toHaveBeenCalledWith(ctx)
  })

  it('bails at the loop top when the user cancelled between cycles', async () => {
    const { ctx } = ctxFor({ healCancelled: true }, { autoHeal: AUTO })

    expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('failed')
    expect(h.runHealAgent).not.toHaveBeenCalled()
  })

  it('passes when nothing failed and the summary carries passing evidence', async () => {
    const { ctx } = ctxFor({}, { autoHeal: AUTO })

    expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('passed')
  })

  describe('pending-test rerun (no heal agent spawned)', () => {
    beforeEach(() => {
      h.verificationPlanForSummary.mockReturnValue(targeted(['skipped-one']))
    })

    it('returns the live status when the abort lands during the pending rerun', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runPlaywright.mockImplementation(async () => {
        ctx.stopped = true
        ctx.status = 'aborted'
        return 143
      })

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('aborted')
      expect(h.runHealAgent).not.toHaveBeenCalled()
    })

    it('finalises as failed when the user cancelled during the pending rerun', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runPlaywright.mockImplementation(async () => { ctx.healCancelled = true; return 1 })

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('failed')
      expect(h.decideRunStatus).not.toHaveBeenCalled()
    })

    it('passes as soon as the rerun turns the pending tests green', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.decideRunStatus.mockReturnValue('passed')

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('passed')
      expect(h.runPlaywright).toHaveBeenCalledTimes(1)
    })

    it('stops naming the skipped tests when a rerun changed nothing', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('failed')
      expect(h.recordHealEnd).toHaveBeenCalledWith(ctx, expect.objectContaining({
        reason: 'no-progress',
        message: expect.stringContaining('1 test stayed skipped'),
      }))
      expect(h.recordLifecycle).toHaveBeenCalledWith(
        ctx,
        'rerunning-tests',
        expect.any(String),
        expect.objectContaining({ detail: expect.stringContaining('1 test remained skipped') }),
      )
    })

    it('pluralises the skipped-test message for more than one', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.verificationPlanForSummary.mockReturnValue(targeted(['a', 'b']))

      await runAutoHealLoop(ctx, makeLoopHost())

      expect(h.recordHealEnd).toHaveBeenCalledWith(ctx, expect.objectContaining({
        message: expect.stringContaining('2 tests stayed skipped'),
      }))
    })

    it('uses the generic no-progress wording when no test was skipped', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.verificationPlanForSummary.mockReturnValue(FULL_SUITE)

      await runAutoHealLoop(ctx, makeLoopHost())

      expect(h.recordHealEnd).toHaveBeenCalledWith(ctx, expect.objectContaining({
        message: 'Auto-repair stopped: a rerun made no progress on the not-yet-passed tests.',
      }))
      expect(h.recordLifecycle).toHaveBeenCalledWith(
        ctx,
        'rerunning-tests',
        expect.any(String),
        expect.objectContaining({ detail: expect.stringContaining('A rerun made no progress') }),
      )
    })

    it('loops again when the rerun did make progress', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      let call = 0
      // Progress on the first rerun, then everything passes.
      h.nonPassedSignatureFromPlan.mockImplementation(() => (call === 0 ? 'before' : 'after'))
      h.runPlaywright.mockImplementation(async () => { call += 1; return 1 })
      h.verificationPlanForSummary.mockImplementation(() =>
        (call === 0 ? targeted(['x']) : ALL_PASSED))

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('passed')
      expect(h.runPlaywright).toHaveBeenCalledTimes(1)
    })
  })

  describe('heal cycles', () => {
    beforeEach(() => {
      h.extractFailedSlugs.mockReturnValue(['spec.ts > fails'])
    })

    it('stops with a max-cycles reason once the cap is reached', async () => {
      const { ctx } = ctxFor({}, { autoHeal: { maxCycles: 1 } })
      h.runHealAgent.mockResolvedValue({ signal: rerunSignal(), reason: 'signal' })

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('failed')
      expect(h.recordHealEnd).toHaveBeenCalledWith(ctx, expect.objectContaining({
        reason: 'max-cycles',
        message: expect.stringContaining('1-cycle limit'),
      }))
    })

    it('stops with a no-progress reason when the same set keeps failing', async () => {
      const { ctx } = ctxFor({}, { autoHeal: { maxCycles: 50 } })
      h.runHealAgent.mockResolvedValue({ signal: rerunSignal(), reason: 'signal' })

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('failed')
      expect(h.recordHealEnd).toHaveBeenCalledWith(ctx, expect.objectContaining({
        reason: 'no-progress',
        message: expect.stringContaining('kept failing across'),
      }))
    })

    it('returns the live status when the abort lands while the agent runs', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockImplementation(async () => {
        ctx.stopped = true
        ctx.status = 'aborted'
        return { signal: undefined, reason: 'pty-died' }
      })

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('aborted')
      expect(h.persistAgentSessionRef).toHaveBeenCalledWith(ctx)
    })

    it('finalises as failed when the user cancelled while the agent ran', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockImplementation(async () => {
        ctx.healCancelled = true
        return { signal: rerunSignal(), reason: 'signal' }
      })

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('failed')
      expect(h.runPlaywright).not.toHaveBeenCalled()
    })

    // Each no-signal `reason` gets its own sentence in the transcript.
    const REASONS: Array<[string, string]> = [
      ['idle-timeout', 'went silent for'],
      ['hard-timeout', 'minute ceiling'],
      ['pty-died', 'exited without writing a signal'],
      ['stopped', 'reason: stopped'],
    ]
    for (const [reason, fragment] of REASONS) {
      it(`explains a "${reason}" cycle that changed nothing, then stops`, async () => {
        const { ctx } = ctxFor({}, { autoHeal: AUTO })
        h.runHealAgent.mockResolvedValue({ signal: undefined, reason })

        expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('failed')
        expect(h.emitAgentSystemMessage).toHaveBeenCalledWith(ctx, expect.stringContaining(fragment))
        expect(h.recordHealEnd).toHaveBeenCalledWith(ctx, expect.objectContaining({
          reason: 'no-signal',
          agentWait: reason,
        }))
      })
    }

    it('infers a rerun from the git diff when a silent agent still edited files', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockResolvedValue({ signal: undefined, reason: 'idle-timeout' })
      h.diffFeatureRepos.mockResolvedValue(['src/app.ts'])
      h.decideRunStatus.mockReturnValue('passed')

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('passed')
      expect(h.emitAgentSystemMessage).toHaveBeenCalledWith(
        ctx,
        'Code changes detected — inferring a rerun from git diff.',
      )
      expect(h.appendJournalIteration).toHaveBeenCalledWith(ctx, expect.objectContaining({
        signal: '.rerun',
        filesChanged: ['src/app.ts'],
      }))
    })

    // A silent agent that fixed app code must get a RESTART, not a bare rerun:
    // the service process is still serving the pre-fix code, so a rerun re-tests
    // the old binary and reports a repair that actually worked as a failure.
    it('infers a restart when the silent agent edited a file inside a service repo', async () => {
      const svcCwd = path.join(tmpDir, 'services', 'catalog')
      const { ctx } = ctxFor(
        { services: [{ name: 'catalog', safeName: 'catalog', cwd: svcCwd }] } as unknown as Partial<RunContext>,
        { autoHeal: AUTO },
      )
      h.runHealAgent.mockResolvedValue({ signal: undefined, reason: 'idle-timeout' })
      h.diffFeatureRepos.mockResolvedValue([path.join(svcCwd, 'server.ts')])
      h.decideRunStatus.mockReturnValue('passed')
      const host = makeLoopHost()

      expect(await runAutoHealLoop(ctx, host)).toBe('passed')
      expect(h.emitAgentSystemMessage).toHaveBeenCalledWith(
        ctx,
        'Code changes detected — inferring a restart from git diff.',
      )
      expect(h.appendJournalIteration).toHaveBeenCalledWith(ctx, expect.objectContaining({
        signal: '.restart',
        filesChanged: [path.join(svcCwd, 'server.ts')],
      }))
      expect(host.restart).toHaveBeenCalledWith([path.join(svcCwd, 'server.ts')])
    })

    it('warns about a malformed signal body field instead of dropping it silently', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockResolvedValue({ signal: rerunSignal({ hypothesis: 7 }), reason: 'signal' })
      h.decideRunStatus.mockReturnValue('passed')

      await runAutoHealLoop(ctx, makeLoopHost())

      expect(h.emitAgentSystemMessage).toHaveBeenCalledWith(
        ctx,
        expect.stringContaining('`hypothesis` was not a string'),
      )
    })

    it('treats a bare `heal` signal as a rerun, not a service restart', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockResolvedValue({ signal: { kind: 'heal', body: {} }, reason: 'signal' })
      h.decideRunStatus.mockReturnValue('passed')
      const host = makeLoopHost()

      expect(await runAutoHealLoop(ctx, host)).toBe('passed')
      expect(host.rerun).toHaveBeenCalledTimes(1)
      expect(host.restart).not.toHaveBeenCalled()
      // `heal` is neither `.restart` nor `.rerun`, so nothing is journalled.
      expect(h.appendJournalIteration).not.toHaveBeenCalled()
    })

    it('records the restart plan and history on a restart signal', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockResolvedValue({ signal: { kind: 'restart', body: {} }, reason: 'signal' })
      h.decideRunStatus.mockReturnValue('passed')
      const host = makeLoopHost({
        restart: vi.fn(async () => ({ restarted: ['api'], kept: ['db'], startedBecauseMissing: ['cache'] })),
      })

      expect(await runAutoHealLoop(ctx, host)).toBe('passed')
      expect(ctx.healCycleHistory).toEqual([{ cycle: 1, restarted: ['api'], kept: ['db'] }])
      expect(h.recordLifecycle).toHaveBeenCalledWith(
        ctx,
        'restarting-services',
        'Starting missing kept services',
        expect.objectContaining({ detail: expect.stringContaining('cache') }),
      )
    })

    it('records no missing-service note when the restart started nothing extra', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockResolvedValue({ signal: { kind: 'restart', body: {} }, reason: 'signal' })
      h.decideRunStatus.mockReturnValue('passed')
      const host = makeLoopHost()

      expect(await runAutoHealLoop(ctx, host)).toBe('passed')
      expect(host.restart).toHaveBeenCalledTimes(1)
      expect(h.recordLifecycle).not.toHaveBeenCalledWith(
        ctx, 'restarting-services', 'Starting missing kept services', expect.anything(),
      )
    })

    it('returns the live status when the abort lands inside the restart', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockResolvedValue({ signal: { kind: 'restart', body: {} }, reason: 'signal' })
      const host = makeLoopHost({
        restart: vi.fn(async () => {
          ctx.stopped = true
          ctx.status = 'aborted'
          return { restarted: [], kept: [], startedBecauseMissing: [] }
        }),
      })

      expect(await runAutoHealLoop(ctx, host)).toBe('aborted')
      expect(ctx.healCycleHistory).toEqual([])
    })

    it('returns the live status when the abort lands inside the rerun', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockResolvedValue({ signal: rerunSignal(), reason: 'signal' })
      const host = makeLoopHost({
        rerun: vi.fn(async () => { ctx.stopped = true; ctx.status = 'aborted' }),
      })

      expect(await runAutoHealLoop(ctx, host)).toBe('aborted')
      expect(h.runPlaywright).not.toHaveBeenCalled()
    })

    it('waits again without judging the suite when the services failed to boot', async () => {
      const { ctx } = ctxFor({}, { autoHeal: { maxCycles: 2 } })
      let cycle = 0
      h.runHealAgent.mockImplementation(async () => {
        cycle += 1
        ctx.bootFailure = cycle === 1 ? ({ service: 'api' } as RunContext['bootFailure']) : undefined
        return { signal: rerunSignal(), reason: 'signal' }
      })
      h.decideRunStatus.mockReturnValue('passed')
      const host = makeLoopHost()

      expect(await runAutoHealLoop(ctx, host)).toBe('passed')
      expect(host.recordBootFailureHealWait).toHaveBeenCalledTimes(1)
      expect(h.runPlaywright).toHaveBeenCalledTimes(1)
    })

    it('returns the live status when the abort lands while Playwright reruns', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockResolvedValue({ signal: rerunSignal(), reason: 'signal' })
      h.runPlaywright.mockImplementation(async () => {
        ctx.stopped = true
        ctx.status = 'aborted'
        return 143
      })

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('aborted')
      expect(h.decideRunStatus).not.toHaveBeenCalled()
    })

    it('finalises as failed when the user cancelled mid-Playwright', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockResolvedValue({ signal: rerunSignal(), reason: 'signal' })
      h.runPlaywright.mockImplementation(async () => { ctx.healCancelled = true; return 143 })

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('failed')
      expect(h.decideRunStatus).not.toHaveBeenCalled()
    })

    it('records a lifecycle note when services had to be started before the rerun', async () => {
      const { ctx } = ctxFor({}, { autoHeal: AUTO })
      h.runHealAgent.mockResolvedValue({ signal: rerunSignal(), reason: 'signal' })
      h.ensureServicesRunning.mockResolvedValue(['api'])
      h.decideRunStatus.mockReturnValue('passed')

      expect(await runAutoHealLoop(ctx, makeLoopHost())).toBe('passed')
      expect(h.recordLifecycle).toHaveBeenCalledWith(
        ctx,
        'restarting-services',
        'Started missing services',
        expect.objectContaining({ detail: 'Started api before rerun.' }),
      )
    })
  })
})
