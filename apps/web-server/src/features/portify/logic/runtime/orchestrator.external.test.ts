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
  // ── revise: user-driven feedback pass (post ready-to-save) ─────────────
  function readyManifest(): PortifyManifest {
    return { ...baseManifest(), status: 'ready-to-save', attempt: 1, diff: 'old diff', verification: { ok: true, instances: [] } }
  }

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

    describe('reopenExternal', () => {
      function verified(patch: Partial<PortifyManifest> = {}): PortifyManifest {
        return {
          ...baseManifest(),
          status: 'ready-to-save',
          attempt: 1,
          diff: 'verified diff',
          verification: { ok: true, instances: [] },
          ...patch,
        }
      }

      it('reopens a verified workflow for editing and clears a stale error', () => {
        const { deps, saved } = makeDeps({})
        const m = new PortifyOrchestrator(deps).reopenExternal(verified({ error: 'from an earlier round' }))
        expect(m.status).toBe('editing')
        expect(m.error).toBeUndefined()
        // The verified diff stays on the record — the client edits ON TOP of it.
        expect(m.diff).toBe('verified diff')
        expect(saved).toEqual([m])
      })

      it('starts the feedback count at 1 when the record predates the counter', () => {
        // `feedbackRounds` is optional on the manifest: prepare-workflow seeds it
        // at 0 today, but a record written before it existed carries none.
        const { deps } = makeDeps({})
        expect(new PortifyOrchestrator(deps).reopenExternal(verified()).feedbackRounds).toBe(1)
      })

      it('increments an existing feedback count — the review loop is unbounded', () => {
        const { deps } = makeDeps({})
        expect(new PortifyOrchestrator(deps).reopenExternal(verified({ feedbackRounds: 3 })).feedbackRounds).toBe(4)
      })
    })
  })
})
