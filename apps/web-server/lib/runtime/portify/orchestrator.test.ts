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
    captureDiff: async () => 'diff',
    verify: async (): Promise<PortifyVerification> => ({ ok: true, instances: [] }),
    checkTestsUntouched: async () => ({ ok: true, offending: [] }),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  }
  return { deps, saved }
}

describe('PortifyOrchestrator', () => {
  it('reaches ready-to-commit when the first verification passes', async () => {
    const { deps } = makeDeps({})
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('ready-to-commit')
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
    expect(m.status).toBe('ready-to-commit')
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
    expect(m.status).toBe('ready-to-commit')
    expect(m.attempt).toBe(2)
    expect(runAgent.mock.calls[1][1]).toContain('e2e/api.spec.ts')
  })

  it('fails (not throws) and cleans up when a dependency throws', async () => {
    const { deps } = makeDeps({ setup: async () => { throw new Error('worktree create failed') } })
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('failed')
    expect(m.error).toContain('worktree create failed')
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

  it('runs without optional isAborted / cleanup deps', async () => {
    const saved: PortifyManifest[] = []
    const deps: PortifyOrchestratorDeps = {
      manifest: baseManifest(),
      persist: (m) => saved.push(m),
      now: () => 'now',
      setup: async () => [{ name: 'r', path: '~/r' }],
      runAgent: async () => {},
      captureDiff: async () => 'd',
      verify: async () => ({ ok: true, instances: [] }),
      checkTestsUntouched: async () => ({ ok: true, offending: [] }),
      // no isAborted, no cleanup
    }
    const m = await new PortifyOrchestrator(deps).run()
    expect(m.status).toBe('ready-to-commit')
  })
})
