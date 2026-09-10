import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ROBUSTNESS_ENVELOPE_FORMAT } from '../../../../../../../shared/robustness/types'
import { createRegistry, RunStore } from '../run-store'
import type { RunManifest } from '../runtime/manifest'
import type { StartRunOutcome } from '../run-store'
import { makeRobustnessCellRunner, type RobustnessCellRequest } from './cell-runner'

// The cell runner is glue between `startRun` and the run store: it must pass a
// cell through the start path with exactly the arguments that make it a
// no-heal, one-file, one-atom run, then wait for THAT run to settle. A real
// RunStore over a tmp dir plays the run loop's half — bootstrap, then finalize
// — so the settle logic is exercised against the events the store really emits.

let tmp: string
let store: RunStore

const ENVELOPE = { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 300 } }
const REQUEST: RobustnessCellRequest = {
  feature: 'storefront-journey',
  env: 'local',
  envelope: ENVELOPE,
  selection: { kind: 'grep', grep: 'browse', selected: 1, total: 3, mode: 'robustness-cell', reason: 'Robustness Lab cell: e2e/storefront.spec.ts under latency.' },
}

function manifest(runId: string, status: RunManifest['status'] = 'running'): RunManifest {
  return { runId, feature: 'storefront-journey', startedAt: '2026-09-10T00:00:00Z', status, healCycles: 0, services: [], repoPaths: [] }
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cell-runner-')))
  store = new RunStore(tmp, createRegistry())
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('makeRobustnessCellRunner', () => {
  it('starts the cell as a worktree-isolated robustness run with the envelope and selection, then waits for it to settle', async () => {
    const calls: unknown[][] = []
    const runCell = makeRobustnessCellRunner({
      startRun: async (...args) => {
        calls.push(args)
        store.bootstrap(manifest('run-1'))
        return { kind: 'started', orch: { runId: 'run-1' } } as unknown as StartRunOutcome
      },
      runStore: store,
    })
    const pending = runCell(REQUEST)
    expect(calls).toEqual([['storefront-journey', 'local', undefined, 'worktree', 'robustness', undefined, ENVELOPE, REQUEST.selection]])

    // Let the runner get past `startRun` and subscribe, THEN settle an unrelated
    // run: its events reach the listener and must not release the cell.
    await new Promise((r) => setTimeout(r, 0))
    expect(store.listenerCount('event')).toBe(1)
    store.bootstrap(manifest('run-other'))
    store.finalize('run-other', 'passed', '2026-09-10T00:01:00Z', 0)
    let settled = false
    void pending.then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)

    fs.writeFileSync(path.join(tmp, 'runs', 'run-1', 'e2e-summary.json'), JSON.stringify({ complete: true, total: 1, passed: 0, failed: [{ name: 'browse', error: 'timeout' }] }))
    store.finalize('run-1', 'failed', '2026-09-10T00:02:00Z', 0)
    const result = await pending
    expect(result.runId).toBe('run-1')
    expect(result.status).toBe('failed')
    expect(result.summary?.failed).toEqual([{ name: 'browse', error: 'timeout' }])
    expect(store.listenerCount('event')).toBe(0)
  })

  it('follows a queued run by its id from before its manifest exists until it settles', async () => {
    const runCell = makeRobustnessCellRunner({
      startRun: async () => ({ kind: 'queued', runId: 'run-q', reason: 'queued behind run-0' }) as unknown as StartRunOutcome,
      runStore: store,
    })
    const pending = runCell(REQUEST)
    await new Promise((r) => setTimeout(r, 5))
    // The queue launches it later: the bootstrap is seen (not terminal), then the end.
    store.bootstrap(manifest('run-q'))
    store.finalize('run-q', 'aborted', '2026-09-10T00:03:00Z', 0)
    expect(await pending).toEqual({ runId: 'run-q', status: 'aborted', summary: undefined })
  })

  it('returns at once when the run has already settled by the time it looks', async () => {
    const runCell = makeRobustnessCellRunner({
      startRun: async () => {
        store.bootstrap(manifest('run-done', 'passed'))
        return { kind: 'started', orch: { runId: 'run-done' } } as unknown as StartRunOutcome
      },
      runStore: store,
    })
    expect(await runCell(REQUEST)).toEqual({ runId: 'run-done', status: 'passed', summary: undefined })
  })

  it('aborts the cell\'s run through the store when the job\'s signal fires, so the cell settles as aborted instead of running on', async () => {
    const controller = new AbortController()
    const runCell = makeRobustnessCellRunner({
      startRun: async () => {
        store.bootstrap(manifest('run-sig'))
        return { kind: 'started', orch: { runId: 'run-sig' } } as unknown as StartRunOutcome
      },
      runStore: store,
    })
    const pending = runCell({ ...REQUEST, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    // `RunStore.abort` on a run with no live orchestrator finalizes the
    // persisted row — that is the event the runner is waiting on.
    const result = await pending
    expect(result).toMatchObject({ runId: 'run-sig', status: 'aborted' })
    expect(store.listenerCount('event')).toBe(0)
  })

  it('swallows a store abort that rejects — the cell still settles on the run\'s own event', async () => {
    const controller = new AbortController()
    let aborted = 0
    const runCell = makeRobustnessCellRunner({
      startRun: async () => {
        store.bootstrap(manifest('run-rej'))
        return { kind: 'started', orch: { runId: 'run-rej' } } as unknown as StartRunOutcome
      },
      runStore: {
        get: (id) => store.get(id),
        onEvent: (fn) => store.onEvent(fn),
        offEvent: (fn) => store.offEvent(fn),
        abort: async () => { aborted += 1; throw new Error('registry gone') },
      },
    })
    const pending = runCell({ ...REQUEST, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    await new Promise((r) => setTimeout(r, 0))
    expect(aborted).toBe(1)
    store.finalize('run-rej', 'aborted', '2026-09-10T00:02:00Z', 0)
    expect(await pending).toMatchObject({ runId: 'run-rej', status: 'aborted' })
  })

  it('aborts at once when the signal already fired before the run was started', async () => {
    const controller = new AbortController()
    controller.abort()
    const runCell = makeRobustnessCellRunner({
      startRun: async () => {
        store.bootstrap(manifest('run-late'))
        return { kind: 'started', orch: { runId: 'run-late' } } as unknown as StartRunOutcome
      },
      runStore: store,
    })
    const result = await runCell({ ...REQUEST, signal: controller.signal })
    expect(result).toMatchObject({ runId: 'run-late', status: 'aborted' })
  })

  it('reports a collision as a failure to start, naming the run that holds the repos', async () => {
    const runCell = makeRobustnessCellRunner({
      startRun: async () => ({ kind: 'collision', conflictingFeature: 'demo', conflictingRunId: 'run-9' }) as unknown as StartRunOutcome,
      runStore: store,
    })
    await expect(runCell(REQUEST)).rejects.toThrow('robustness cell for storefront-journey could not start: another run (demo, run-9) holds its repos')
  })
})
