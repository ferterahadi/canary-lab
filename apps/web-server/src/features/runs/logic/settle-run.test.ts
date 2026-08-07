import { describe, expect, it } from 'vitest'
import { settleOrchestratorRun } from './settle-run'

function harness(stopImpl?: () => Promise<unknown>) {
  const chunks: string[] = []
  const errors: string[] = []
  const deleted: string[] = []
  const orch = {
    runId: 'run-1',
    stopped: [] as (string | undefined)[],
    stop(status?: 'aborted' | 'passed' | 'failed' | 'queued' | 'running' | 'healing') {
      this.stopped.push(status)
      return stopImpl ? stopImpl() : Promise.resolve()
    },
  }
  return {
    orch,
    chunks,
    errors,
    deleted,
    deps: {
      orch,
      registry: { delete: (id: string) => deleted.push(id) },
      broker: { push: (_pane: 'agent', chunk: string) => chunks.push(chunk) },
      runnerLog: { error: (m: string) => errors.push(m) },
    },
  }
}

describe('settleOrchestratorRun', () => {
  it('stops with the status the run reached and deregisters it', async () => {
    const h = harness()

    await settleOrchestratorRun(Promise.resolve('passed'), h.deps)

    expect(h.orch.stopped).toEqual(['passed'])
    expect(h.deleted).toEqual(['run-1'])
    expect(h.chunks).toEqual([])
    expect(h.errors).toEqual([])
  })

  it('persists the cause to the runner log, not just the live pane', async () => {
    // The B2 regression: a spawn failure reached only the agent pane, so a run
    // nobody was watching left an `aborted` manifest with no cause on disk.
    const h = harness()

    await settleOrchestratorRun(Promise.reject(new Error('posix_spawnp failed.')), h.deps)

    expect(h.errors).toEqual(['Run failed to complete: Error: posix_spawnp failed.'])
    expect(h.chunks[0]).toContain('[orchestrator error] Error: posix_spawnp failed.')
    expect(h.orch.stopped).toEqual(['aborted'])
    expect(h.deleted).toEqual(['run-1'])
  })

  it('deregisters even when stopping throws', async () => {
    const h = harness(() => Promise.reject(new Error('teardown blew up')))

    await settleOrchestratorRun(Promise.resolve('failed'), h.deps)

    expect(h.deleted).toEqual(['run-1'])
  })

  it('tolerates a missing runner log', async () => {
    const h = harness()

    await settleOrchestratorRun(Promise.reject(new Error('boom')), { ...h.deps, runnerLog: null })

    expect(h.chunks[0]).toContain('boom')
    expect(h.deleted).toEqual(['run-1'])
  })
})
