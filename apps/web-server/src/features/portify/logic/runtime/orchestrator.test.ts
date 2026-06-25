import { describe, expect, it, vi } from 'vitest'
import { PortifyOrchestrator, type PortifyOrchestratorDeps } from './orchestrator'
import type { PortifyManifest, PortifyVerification } from './types'

function baseManifest(maxAttempts = 3): PortifyManifest {
  return {
    workflowId: 'portify-test',
    feature: 'f',
    featureDir: '/tmp/f',
    repos: [{ name: 'r', path: '~/r' }],
    agent: 'claude',
    branch: 'canary/dynamic-ports-f',
    status: 'planning',
    attempt: 0,
    maxAttempts,
    startedAt: '2026-06-07T00:00:00.000Z',
  }
}

function makeDeps(overrides: Partial<PortifyOrchestratorDeps>): {
  deps: PortifyOrchestratorDeps
  saved: PortifyManifest[]
} {
  const saved: PortifyManifest[] = []
  const deps: PortifyOrchestratorDeps = {
    manifest: baseManifest(),
    persist: (m) => { saved.push(m) },
    now: () => '2026-06-07T00:01:00.000Z',
    setup: async () => [{ name: 'r', path: '~/r', worktreePath: '/wt', baseSha: 'abc' }],
    runAgent: vi.fn(async () => {}),
    runFeedbackAgent: vi.fn(async () => {}),
    captureDiff: async () => 'diff',
    verify: async (): Promise<PortifyVerification> => ({ ok: true, instances: [] }),
    checkTestsUntouched: async () => ({ ok: true, offending: [] }),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  }
  return { deps, saved }
}

describe('PortifyOrchestrator', () => {
  it('reaches ready-to-save when the first verification passes', async () => {
    const { deps } = makeDeps({})
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('ready-to-save')
    expect(m.attempt).toBe(1)
    expect(m.diff).toBe('diff')
    expect(deps.cleanup).not.toHaveBeenCalled() // worktree kept for commit
  })

  it('retries with failure context until verification passes', async () => {
    const verify = vi.fn()
      .mockResolvedValueOnce({ ok: false, instances: [], failureDetail: 'port 3007 still bound' })
      .mockResolvedValueOnce({ ok: true, instances: [] })
    const runAgent = vi.fn(async () => {})
    const { deps } = makeDeps({ verify, runAgent })
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('ready-to-save')
    expect(m.attempt).toBe(2)
    // Retry carried the failure detail back into the agent prompt.
    expect(runAgent).toHaveBeenNthCalledWith(2, 2, 'port 3007 still bound')
  })

  it('fails and cleans up after exhausting attempts', async () => {
    const { deps } = makeDeps({
      maxAttempts: 2,
      manifest: baseManifest(2),
      verify: async () => ({ ok: false, instances: [], failureDetail: 'nope' }),
    })
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('failed')
    expect(deps.cleanup).toHaveBeenCalledOnce()
  })

  it('treats a test-file edit as a verification failure and retries', async () => {
    const checkTestsUntouched = vi.fn()
      .mockResolvedValueOnce({ ok: false, offending: ['e2e/api.spec.ts'] })
      .mockResolvedValueOnce({ ok: true, offending: [] })
    const runAgent = vi.fn(async () => {})
    const { deps } = makeDeps({ checkTestsUntouched, runAgent })
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('ready-to-save')
    expect(m.attempt).toBe(2)
    expect(runAgent.mock.calls[1][1]).toContain('e2e/api.spec.ts')
  })

  it('fails fast (no retries) when the boot failure is an unreachable dependency, not ports', async () => {
    const verify = vi.fn(async (): Promise<PortifyVerification> => ({
      ok: false,
      instances: [{ ports: { api: 1 }, ok: false, failedService: 'api', detail: "Can't reach database server" }],
      failureDetail: "boot failed: api — Can't reach database server",
      notPortFixable: true,
    }))
    const runAgent = vi.fn(async () => {})
    const { deps } = makeDeps({ verify, runAgent })
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('failed')
    expect(runAgent).toHaveBeenCalledOnce() // attempt 1 only — no wasted port-fix retries
    expect(verify).toHaveBeenCalledOnce()
    expect(deps.cleanup).toHaveBeenCalledOnce()
    expect(m.error).toMatch(/environment|dependenc/i)
    // The diagnosed reason is preserved on the manifest for the user.
    expect(m.verification?.failureDetail).toContain("Can't reach database server")
  })

  it('fails (not throws) and cleans up when a dependency throws', async () => {
    const { deps } = makeDeps({ setup: async () => { throw new Error('worktree create failed') } })
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('failed')
    expect(m.error).toContain('worktree create failed')
    expect(deps.cleanup).toHaveBeenCalledOnce()
  })

  it('fails fast (no retries) and surfaces the message when the agent CLI cannot launch', async () => {
    const runAgent = vi.fn(async () => { throw new Error('could not launch the claude CLI (claude): spawn claude ENOENT') })
    const { deps } = makeDeps({ runAgent })
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('failed')
    expect(m.error).toContain('could not launch the claude CLI')
    expect(runAgent).toHaveBeenCalledOnce() // bailed on attempt 1, no empty retries
    expect(deps.cleanup).toHaveBeenCalledOnce()
  })

  it('persists the verifying transition with the captured diff', async () => {
    const saved: PortifyManifest[] = []
    const { deps } = makeDeps({ persist: (m) => saved.push(m), captureDiff: async () => 'THE DIFF' })
    await new PortifyOrchestrator(deps).run()
    const verifying = saved.find((m) => m.status === 'verifying')
    expect(verifying?.diff).toBe('THE DIFF')
  })

  it('aborts mid-flight and runs cleanup', async () => {
    let aborted = false
    const { deps } = makeDeps({
      isAborted: () => aborted,
      runAgent: vi.fn(async () => { aborted = true }),
    })
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('aborted')
    expect(deps.cleanup).toHaveBeenCalledOnce()
  })

  // The orchestrator checks isAborted at four points in attempt 1: after setup,
  // at the loop top, after runAgent, and after verify. Abort at each so every
  // guard's true-arm is exercised.
  for (const checkpoint of [1, 2, 3, 4]) {
    it(`aborts at checkpoint ${checkpoint} and finalizes as aborted`, async () => {
      let calls = 0
      const { deps } = makeDeps({ isAborted: () => { calls += 1; return calls >= checkpoint } })
      const m = await new PortifyOrchestrator(deps).run()
      expect(m.status).toBe('aborted')
      expect(deps.cleanup).toHaveBeenCalledOnce()
    })
  }

  it('records aborted (not failed) when a thrown error coincides with an abort', async () => {
    const { deps } = makeDeps({
      isAborted: () => true,
      setup: async () => { throw new Error('boom during abort') },
    })
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('aborted')
  })

  it('stringifies a non-Error throw in the failure message', async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    const { deps } = makeDeps({ setup: async () => { throw 'plain string failure' } })
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('failed')
    expect(m.error).toBe('plain string failure')
  })

  // ── revise: user-driven feedback pass (post ready-to-save) ─────────────
  function readyManifest(): PortifyManifest {
    return { ...baseManifest(), status: 'ready-to-save', attempt: 1, diff: 'old diff', verification: { ok: true, instances: [] } }
  }

  describe('revise', () => {
    it('runs one pass and re-parks at ready-to-save, incrementing feedbackRounds without touching attempt', async () => {
      const runFeedbackAgent = vi.fn(async () => {})
      const { deps, saved } = makeDeps({ runFeedbackAgent })
      const m = await new PortifyOrchestrator(deps).revise(readyManifest(), 'use PORT not GATEWAY_PORT')
      expect(runFeedbackAgent).toHaveBeenCalledWith('use PORT not GATEWAY_PORT')
      expect(m.status).toBe('ready-to-save')
      expect(m.feedbackRounds).toBe(1)
      expect(m.attempt).toBe(1)
      expect(saved.map((s) => s.status)).toContain('editing')
      expect(saved.map((s) => s.status)).toContain('verifying')
      expect(deps.cleanup).not.toHaveBeenCalled()
    })

    it('re-parks at ready-to-save with ok:false (never terminal, no cleanup) when the revise breaks the boot', async () => {
      const { deps } = makeDeps({
        verify: async () => ({ ok: false, instances: [], failureDetail: 'port 3000 still bound' }),
      })
      const m = await new PortifyOrchestrator(deps).revise(readyManifest(), 'tweak')
      expect(m.status).toBe('ready-to-save')
      expect(m.verification?.ok).toBe(false)
      expect(m.verification?.failureDetail).toContain('3000')
      expect(deps.cleanup).not.toHaveBeenCalled()
    })

    it('flags a test-file edit made during a revise round', async () => {
      const { deps } = makeDeps({
        checkTestsUntouched: async () => ({ ok: false, offending: ['e2e/api.spec.ts'] }),
      })
      const m = await new PortifyOrchestrator(deps).revise(readyManifest(), 'tweak')
      expect(m.status).toBe('ready-to-save')
      expect(m.verification?.ok).toBe(false)
      expect(m.verification?.failureDetail).toContain('e2e/api.spec.ts')
    })

    it('re-parks (not failed) with an error when the agent throws mid-revise', async () => {
      const { deps } = makeDeps({ runFeedbackAgent: vi.fn(async () => { throw new Error('agent died') }) })
      const m = await new PortifyOrchestrator(deps).revise(readyManifest(), 'tweak')
      expect(m.status).toBe('ready-to-save')
      expect(m.error).toContain('agent died')
      expect(deps.cleanup).not.toHaveBeenCalled()
    })

    it('stringifies a non-Error throw mid-revise into the re-parked error', async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      const { deps } = makeDeps({ runFeedbackAgent: vi.fn(async () => { throw 'raw revise failure' }) })
      const m = await new PortifyOrchestrator(deps).revise(readyManifest(), 'tweak')
      expect(m.status).toBe('ready-to-save')
      expect(m.error).toBe('raw revise failure')
    })

    it('accumulates feedbackRounds across successive revises', async () => {
      const { deps } = makeDeps({})
      const orch = new PortifyOrchestrator(deps)
      const r1 = await orch.revise(readyManifest(), 'a')
      const r2 = await orch.revise(r1, 'b')
      expect(r1.feedbackRounds).toBe(1)
      expect(r2.feedbackRounds).toBe(2)
    })

    it('returns current untouched (no persist) when already aborted', async () => {
      const { deps, saved } = makeDeps({ isAborted: () => true })
      const current = readyManifest()
      const m = await new PortifyOrchestrator(deps).revise(current, 'x')
      expect(m).toBe(current)
      expect(saved).toHaveLength(0)
    })

    it('returns at the editing state when aborted right after the feedback agent', async () => {
      // isAborted: false on entry, true on the post-runFeedbackAgent check —
      // so revise bails before captureDiff.
      let calls = 0
      const captureDiff = vi.fn(async () => 'diff')
      const { deps } = makeDeps({ isAborted: () => { calls += 1; return calls >= 2 }, captureDiff })
      const m = await new PortifyOrchestrator(deps).revise(readyManifest(), 'tweak')
      expect(m.status).toBe('editing')
      expect(captureDiff).not.toHaveBeenCalled()
    })

    it('returns at the verifying state when aborted right after verify', async () => {
      // isAborted: false on entry + post-feedback, true on the post-verify
      // check — so revise bails before checkTestsUntouched / re-parking.
      let calls = 0
      const checkTestsUntouched = vi.fn(async () => ({ ok: true, offending: [] as string[] }))
      const { deps } = makeDeps({ isAborted: () => { calls += 1; return calls >= 3 }, checkTestsUntouched })
      const m = await new PortifyOrchestrator(deps).revise(readyManifest(), 'tweak')
      expect(m.status).toBe('verifying')
      expect(checkTestsUntouched).not.toHaveBeenCalled()
    })

    it('returns the in-flight manifest (no error) when an abort coincides with a revise error', async () => {
      // runFeedbackAgent throws → catch arm; isAborted is true there, so the
      // catch returns the editing manifest WITHOUT stamping the error / re-parking.
      let calls = 0
      const { deps } = makeDeps({
        isAborted: () => { calls += 1; return calls >= 2 },
        runFeedbackAgent: vi.fn(async () => { throw new Error('agent died mid-abort') }),
      })
      const m = await new PortifyOrchestrator(deps).revise(readyManifest(), 'tweak')
      expect(m.status).toBe('editing')
      expect(m.error).toBeUndefined()
    })
  })

  it('runs without optional isAborted / cleanup deps', async () => {
    const saved: PortifyManifest[] = []
    const deps: PortifyOrchestratorDeps = {
      manifest: baseManifest(),
      persist: (m) => saved.push(m),
      now: () => 'now',
      setup: async () => [{ name: 'r', path: '~/r' }],
      runAgent: async () => {},
      runFeedbackAgent: async () => {},
      captureDiff: async () => 'd',
      verify: async () => ({ ok: true, instances: [] }),
      checkTestsUntouched: async () => ({ ok: true, offending: [] }),
      // no isAborted, no cleanup
    }
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('ready-to-save')
  })

  describe('external producer', () => {
    it('startExternal sets up worktrees and parks at editing — no agent runs', async () => {
      const { deps } = makeDeps({})
      const m = await new PortifyOrchestrator(deps).startExternal()
      expect(m.status).toBe('editing')
      expect(m.repos[0].worktreePath).toBe('/wt')
      expect(deps.runAgent).not.toHaveBeenCalled()
      expect(deps.cleanup).not.toHaveBeenCalled()
    })

    it('startExternal fails + cleans up when setup throws', async () => {
      const { deps } = makeDeps({ setup: async () => { throw new Error('worktree boom') } })
      const m = await new PortifyOrchestrator(deps).startExternal()
      expect(m.status).toBe('failed')
      expect(m.error).toContain('worktree boom')
      expect(deps.cleanup).toHaveBeenCalledOnce()
    })

    it('verifyExternalEdits parks at ready-to-save when the in-place edits verify', async () => {
      const { deps } = makeDeps({})
      const orch = new PortifyOrchestrator(deps)
      const current = await orch.startExternal()
      const verifyAgent = deps.runAgent as ReturnType<typeof vi.fn>
      const m = await orch.verifyExternalEdits(current)
      expect(m.status).toBe('ready-to-save')
      expect(m.diff).toBe('diff')
      expect(m.verification?.ok).toBe(true)
      expect(verifyAgent).not.toHaveBeenCalled() // editing happened out-of-band
    })

    it('verifyExternalEdits re-parks at editing (not terminal) when verification fails', async () => {
      const { deps } = makeDeps({ verify: async () => ({ ok: false, instances: [], failureDetail: 'port 3007 still bound' }) })
      const orch = new PortifyOrchestrator(deps)
      const m = await orch.verifyExternalEdits(await orch.startExternal())
      expect(m.status).toBe('editing')
      expect(m.verification?.failureDetail).toContain('port 3007')
      expect(deps.cleanup).not.toHaveBeenCalled() // worktree kept so the client can fix + resubmit
    })

    it('verifyExternalEdits rejects a test-file edit as a ports-only violation', async () => {
      const { deps } = makeDeps({ checkTestsUntouched: async () => ({ ok: false, offending: ['e2e/api.spec.ts'] }) })
      const orch = new PortifyOrchestrator(deps)
      const m = await orch.verifyExternalEdits(await orch.startExternal())
      expect(m.status).toBe('editing')
      expect(m.verification?.failureDetail).toContain('e2e/api.spec.ts')
    })

    it('verifyExternalEdits parks at ready-to-save on an EMPTY diff when the double-boot passes (source already env-driven)', async () => {
      // The repo was portified for another feature, so the listeners already
      // read injected ports — no in-place edit, yet the concurrent boot works.
      const { deps } = makeDeps({ captureDiff: async () => '   ' })
      const orch = new PortifyOrchestrator(deps)
      const verifySpy = vi.fn(async () => ({ ok: true, instances: [] }))
      deps.verify = verifySpy
      const m = await orch.verifyExternalEdits(await orch.startExternal())
      expect(m.status).toBe('ready-to-save')
      expect(verifySpy).toHaveBeenCalled() // the boot IS the ground truth now
    })

    it('verifyExternalEdits re-parks at editing with a clear message on an EMPTY diff when the boot fails', async () => {
      const { deps } = makeDeps({
        captureDiff: async () => '   ',
        verify: async () => ({ ok: false, instances: [], failureDetail: 'port 3007 still bound' }),
      })
      const orch = new PortifyOrchestrator(deps)
      const m = await orch.verifyExternalEdits(await orch.startExternal())
      expect(m.status).toBe('editing')
      expect(m.verification?.failureDetail).toMatch(/no edits detected/i)
      expect(m.verification?.failureDetail).toContain('port 3007') // raw boot detail preserved
    })

    it('verifyExternalEdits uses empty-string fallback when boot error has no failureDetail', async () => {
      const { deps } = makeDeps({
        captureDiff: async () => '   ',
        verify: async () => ({ ok: false, instances: [] }),
      })
      const orch = new PortifyOrchestrator(deps)
      const m = await orch.verifyExternalEdits(await orch.startExternal())
      expect(m.status).toBe('editing')
      expect(m.verification?.failureDetail).toMatch(/no edits detected/i)
      expect(m.verification?.failureDetail).not.toContain('Boot detail:')
    })

    it('startExternal aborts and cleans up when isAborted fires after setup', async () => {
      const { deps } = makeDeps({ isAborted: () => true })
      const m = await new PortifyOrchestrator(deps).startExternal()
      expect(m.status).toBe('aborted')
      expect(deps.cleanup).toHaveBeenCalledOnce()
    })

    it('stringifies a non-Error throw in startExternal failure message', async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      const { deps } = makeDeps({ setup: async () => { throw 'network failure' } })
      const m = await new PortifyOrchestrator(deps).startExternal()
      expect(m.status).toBe('failed')
      expect(m.error).toBe('network failure')
      expect(deps.cleanup).toHaveBeenCalledOnce()
    })

    it('verifyExternalEdits returns current immediately when isAborted at entry', async () => {
      const { deps } = makeDeps({ isAborted: () => true })
      const current = { ...baseManifest(), status: 'editing' as const }
      const m = await new PortifyOrchestrator(deps).verifyExternalEdits(current)
      expect(m).toBe(current)
    })

    it('verifyExternalEdits bails after verify when isAborted fires post-verify', async () => {
      let calls = 0
      // startExternal consumes call 1 (post-setup); verifyExternalEdits entry is
      // call 2 (must pass); post-verify check is call 3 — bail there.
      const { deps } = makeDeps({ isAborted: () => { calls += 1; return calls >= 3 } })
      const orch = new PortifyOrchestrator(deps)
      const current = await orch.startExternal()
      const m = await orch.verifyExternalEdits(current)
      expect(m.status).toBe('verifying') // bailed before re-parking
    })

    it('verifyExternalEdits re-parks at editing when captureDiff throws', async () => {
      const { deps } = makeDeps({ captureDiff: async () => { throw new Error('diff failed') } })
      const orch = new PortifyOrchestrator(deps)
      const current = await orch.startExternal()
      const m = await orch.verifyExternalEdits(current)
      expect(m.status).toBe('editing')
      expect(m.error).toContain('diff failed')
    })

    it('stringifies a non-Error throw in verifyExternalEdits catch (String(err) branch)', async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      const { deps } = makeDeps({ captureDiff: async () => { throw 'capture string error' } })
      const orch = new PortifyOrchestrator(deps)
      const current = await orch.startExternal()
      const m = await orch.verifyExternalEdits(current)
      expect(m.status).toBe('editing')
      expect(m.error).toBe('capture string error')
    })
  })
})
