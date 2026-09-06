import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlightRunStore } from './store'
import { startFlight, respondToFlightCheckpoint, pauseFlight, resumeFlight, abortFlight, type FlightConductorDeps, type StageAdapter, type StageAdapters, type StageOutcome } from './conductor'
import { FLIGHT_STAGE_KEYS, type FlightStageKey } from './types'

let root: string
let store: FlightRunStore
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-overlap-'))
  store = new FlightRunStore(root)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function setup(overrides: StageAdapters = {}) {
  const calls: FlightStageKey[] = []
  const adapters: StageAdapters = Object.fromEntries(FLIGHT_STAGE_KEYS.map((key) => [key, {
    teardown: () => null,
    run: async () => { calls.push(key); return { kind: 'done' as const } },
  }]))
  Object.assign(adapters, overrides)
  const deps: FlightConductorDeps = { store, adapters }
  const start = () => startFlight({ feature: 'checkout', repoPaths: ['/repo/checkout'], description: 'checkout', opts: { env: 'local', coverageTarget: 100, yolo: false } }, deps)
  return { deps, calls, start }
}

describe('overlapping boot and requirements', () => {
  it('recovers a lost boot while preserving an external requirements checkpoint after restart', async () => {
    const { start, deps } = setup()
    const flight = start()
    await flight.completion
    const complete = store.get(flight.manifest.flightId)!
    expect(new FlightRunStore(root).get(complete.flightId)).toEqual(complete)
    const checkpoint = { kind: 'external-work' as const, message: 'collect', options: ['submit'], data: { handOffId: 'keep-me' } }
    store.save({ ...complete, status: 'waiting-for-approval', currentStage: 'docs', stages: complete.stages.map((stage) => {
      if (stage.key === 'env-capture') return { key: stage.key, status: 'running', activeSince: '2026-01-01T00:00:00Z' }
      if (stage.key === 'docs') return { key: stage.key, status: 'waiting-for-approval', checkpoint }
      return stage
    }) })
    const reopened = new FlightRunStore(root)
    reopened.reconcileInterrupted(() => '2026-01-02T00:00:00Z')
    const recovered = reopened.get(complete.flightId)!
    expect(recovered.status).toBe('waiting-for-approval')
    expect(recovered.stages.find((stage) => stage.key === 'docs')?.checkpoint).toEqual(checkpoint)
    expect(recovered.stages.find((stage) => stage.key === 'env-capture')).toMatchObject({ status: 'pending' })
    expect(recovered.stages.find((stage) => stage.key === 'env-capture')?.activeSince).toBeUndefined()
    await respondToFlightCheckpoint(complete.flightId, { choice: 'submit' }, { ...deps, store: reopened }).completion
    expect(reopened.get(complete.flightId)?.status).toBe('done')
  })

  it('starts docs and summary during boot, but gates specs on the boot receipt', async () => {
    const boot = deferred<StageOutcome>()
    const { start, calls } = setup({ 'env-capture': { teardown: () => null, run: () => boot.promise } })
    const flight = start()
    await vi.waitFor(() => expect(calls).toContain('prd-summary'))
    expect(calls).not.toContain('specs-coverage')
    const running = store.get(flight.manifest.flightId)!
    expect(running.stages.find((stage) => stage.key === 'env-capture')?.status).toBe('running')
    boot.resolve({ kind: 'done', evidence: { boot: { runId: 'boot-once' } } })
    await flight.completion
    expect(store.get(flight.manifest.flightId)?.status).toBe('done')
    expect(calls).toContain('specs-coverage')
  })

  it('keeps the same boot across an external docs checkpoint and routes its answer to docs', async () => {
    const boot = deferred<StageOutcome>()
    const runBoot = vi.fn(() => boot.promise)
    const response = vi.fn<NonNullable<StageAdapter['onCheckpointResponse']>>(async () => ({ kind: 'done' as const }))
    const { start, deps, calls } = setup({
      'env-capture': { teardown: () => null, run: runBoot },
      docs: {
        teardown: () => null,
        run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'external-work', message: 'collect', options: ['submit'] } }),
        onCheckpointResponse: response,
      },
    })
    const flight = start()
    await flight.completion
    const parked = store.get(flight.manifest.flightId)!
    expect(parked.status).toBe('waiting-for-approval')
    expect(parked.currentStage).toBe('docs')
    const continued = respondToFlightCheckpoint(parked.flightId, { choice: 'submit', data: 'docs-result' }, deps)
    await vi.waitFor(() => expect(calls).toContain('prd-summary'))
    expect(response.mock.calls[0][1]).toMatchObject({ data: 'docs-result' })
    expect(runBoot).toHaveBeenCalledTimes(1)
    expect(calls).not.toContain('specs-coverage')
    boot.resolve({ kind: 'done' })
    await continued.completion
    expect(store.get(parked.flightId)?.status).toBe('done')
  })

  it.each(['pause', 'abort'] as const)('stops both owners on %s and retains completed requirements on resume', async (action) => {
    const boot = deferred<StageOutcome>()
    const docs = deferred<StageOutcome>()
    const stopped: string[] = []
    const { start, deps } = setup({
      'env-capture': {
        run: vi.fn().mockImplementationOnce(() => boot.promise).mockResolvedValue({ kind: 'done' }),
        teardown: () => ({ id: 'boot', stop: async () => { stopped.push('boot'); boot.resolve({ kind: 'failed', error: 'cancelled' }) } }),
      },
      docs: {
        run: vi.fn().mockImplementationOnce(() => docs.promise).mockResolvedValue({ kind: 'done' }),
        teardown: () => ({ id: 'docs-agent', stop: async () => { stopped.push('docs'); docs.resolve({ kind: 'done', evidence: { docs: ['prd.md'] } }) } }),
      },
    })
    const flight = start()
    await vi.waitFor(() => expect(store.get(flight.manifest.flightId)?.currentStage).toBe('docs'))
    await (action === 'pause' ? pauseFlight : abortFlight)(flight.manifest.flightId, deps)
    await flight.completion
    expect(stopped.sort()).toEqual(['boot', 'docs'])
    const paused = store.get(flight.manifest.flightId)!
    expect(paused.stages.some((stage) => stage.status === 'running')).toBe(false)
    expect(paused.stages.find((stage) => stage.key === 'docs')?.evidence).toEqual({ docs: ['prd.md'] })
    if (action === 'pause') {
      await resumeFlight(paused.flightId, deps).completion
      expect(store.get(paused.flightId)?.status).toBe('done')
      expect(deps.adapters.docs!.run).toHaveBeenCalledTimes(1)
      expect(deps.adapters['env-capture']!.run).toHaveBeenCalledTimes(2)
    }
  })

  it('holds a missing-env checkpoint until the requirements checkpoint is answered', async () => {
    const { start, deps, calls } = setup({
      'env-capture': {
        teardown: () => null,
        run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'missing-env', message: 'supply settings', options: ['retry'] } }),
        onCheckpointResponse: async () => ({ kind: 'done' }),
      },
      docs: {
        teardown: () => null,
        run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'external-work', message: 'collect', options: ['submit'] } }),
        onCheckpointResponse: async () => ({ kind: 'done' }),
      },
    })
    const flight = start()
    await flight.completion
    expect(store.get(flight.manifest.flightId)?.stages.filter((stage) => stage.status === 'waiting-for-approval')).toHaveLength(1)
    await respondToFlightCheckpoint(flight.manifest.flightId, { choice: 'submit' }, deps).completion
    const waiting = store.get(flight.manifest.flightId)!
    expect(waiting.currentStage).toBe('env-capture')
    expect(waiting.stages.find((stage) => stage.key === 'env-capture')?.checkpoint?.kind).toBe('missing-env')
    expect(calls).not.toContain('specs-coverage')
    await respondToFlightCheckpoint(waiting.flightId, { choice: 'retry' }, deps).completion
    expect(store.get(waiting.flightId)?.status).toBe('done')
  })

  it('discards a deferred boot checkpoint when paused during the requirements handoff', async () => {
    const runBoot = vi.fn<StageAdapter['run']>().mockResolvedValueOnce({ kind: 'checkpoint', checkpoint: { kind: 'missing-env', message: 'supply settings', options: ['retry'] } }).mockResolvedValue({ kind: 'done' })
    const { start, deps } = setup({
      'env-capture': { teardown: () => null, run: runBoot },
      docs: { teardown: () => null, run: vi.fn<StageAdapter['run']>().mockResolvedValueOnce({ kind: 'checkpoint', checkpoint: { kind: 'external-work', message: 'collect', options: ['submit'] } }).mockResolvedValue({ kind: 'done' }) },
    })
    const flight = start()
    await flight.completion
    await pauseFlight(flight.manifest.flightId, deps)
    await resumeFlight(flight.manifest.flightId, deps).completion
    expect(runBoot).toHaveBeenCalledTimes(2)
    expect(store.get(flight.manifest.flightId)?.status).toBe('done')
  })

  it('stops the boot before a failed requirements pass releases the flight', async () => {
    const boot = deferred<StageOutcome>()
    const stop = vi.fn(async () => { boot.resolve({ kind: 'failed', error: 'cancelled' }) })
    const { start, calls } = setup({
      'env-capture': { teardown: () => ({ id: 'boot', stop }), run: () => boot.promise },
      docs: { teardown: () => null, run: async () => ({ kind: 'failed', error: 'no requirements' }) },
    })
    const flight = start()
    await flight.completion
    expect(stop).toHaveBeenCalledOnce()
    expect(store.get(flight.manifest.flightId)).toMatchObject({ status: 'paused', pauseReason: 'stage-failed', error: 'no requirements' })
    expect(calls).not.toContain('specs-coverage')
  })

  it.each(['resume', 'redo', 'delete'] as const)('discards a late cancelled boot after %s', async (action) => {
    const oldBoot = deferred<StageOutcome>()
    const newBoot = deferred<StageOutcome>()
    const runBoot = vi.fn().mockImplementationOnce(() => oldBoot.promise).mockImplementation(() => newBoot.promise)
    const { start, deps } = setup({
      'env-capture': { teardown: () => null, run: runBoot },
      docs: { teardown: () => null, run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'external-work', message: 'collect', options: ['submit'] } }) },
    })
    const flight = start()
    await flight.completion
    const id = flight.manifest.flightId
    await pauseFlight(id, deps)
    if (action === 'delete') store.remove(id)
    else if (action === 'resume') await resumeFlight(id, deps).completion
    else await startFlight({ feature: 'checkout', repoPaths: [], description: '', mode: 'redo', opts: flight.manifest.opts }, deps).completion
    oldBoot.resolve({ kind: 'done', evidence: { boot: { runId: 'stale-boot' } } })
    await oldBoot.promise
    if (action === 'delete') expect(store.get(id)).toBeNull()
    else {
      await vi.waitFor(() => expect(store.get(id)?.stages.find((stage) => stage.key === 'env-capture')).toMatchObject({ status: action === 'redo' ? 'running' : 'pending' }))
      expect(store.get(id)?.stages.find((stage) => stage.key === 'env-capture')?.evidence).toBeUndefined()
      newBoot.resolve({ kind: 'done', evidence: { boot: { runId: 'current-boot' } } })
      if (action === 'redo') await vi.waitFor(() => expect(store.get(id)?.stages.find((stage) => stage.key === 'env-capture')?.evidence).toEqual({ boot: { runId: 'current-boot' } }))
      await pauseFlight(id, deps)
    }
  })

  it('retains a skipped boot while requirements are parked', async () => {
    const { start, deps } = setup({
      'env-capture': { teardown: () => null, run: async () => ({ kind: 'skipped', reason: 'remote target' }) },
      docs: { teardown: () => null, run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'external-work', message: 'collect', options: ['submit'] } }) },
    })
    const flight = start()
    await flight.completion
    expect(store.get(flight.manifest.flightId)?.stages.find((stage) => stage.key === 'env-capture')).toMatchObject({ status: 'skipped', skipReason: 'remote target' })
    await pauseFlight(flight.manifest.flightId, deps)
  })

  it.each([new Error('disk full'), 'storage unavailable'])('joins a background persistence failure: %s', async (failure) => {
    const boot = deferred<StageOutcome>()
    const { start, deps, calls } = setup({
      'env-capture': { teardown: () => null, run: () => boot.promise },
      docs: {
        teardown: () => null,
        run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'external-work', message: 'collect', options: ['submit'] } }),
        onCheckpointResponse: async () => ({ kind: 'done' }),
      },
    })
    const flight = start()
    await flight.completion
    const save = store.save.bind(store)
    const failingSave = vi.spyOn(store, 'save').mockImplementationOnce(() => { throw failure }).mockImplementation(save)
    boot.resolve({ kind: 'done' })
    await vi.waitFor(() => expect(failingSave).toHaveBeenCalled())
    await respondToFlightCheckpoint(flight.manifest.flightId, { choice: 'submit' }, deps).completion
    expect(store.get(flight.manifest.flightId)).toMatchObject({ status: 'paused', pauseReason: 'stage-failed', error: failure instanceof Error ? failure.message : failure })
    expect(calls).not.toContain('specs-coverage')
  })

  it('stops the boot when persisting foreground work fails', async () => {
    const boot = deferred<StageOutcome>()
    const docs = deferred<StageOutcome>()
    const stop = vi.fn(async () => { boot.resolve({ kind: 'failed', error: 'cancelled' }) })
    const { start, calls } = setup({
      'env-capture': { teardown: () => ({ id: 'boot', stop }), run: () => boot.promise },
      docs: { teardown: () => null, run: () => docs.promise },
    })
    const flight = start()
    await vi.waitFor(() => expect(store.get(flight.manifest.flightId)?.currentStage).toBe('docs'))
    const save = store.save.bind(store)
    vi.spyOn(store, 'save').mockImplementationOnce(() => { throw new Error('disk full') }).mockImplementation(save)
    docs.resolve({ kind: 'done' })
    await flight.completion
    expect(stop).toHaveBeenCalledOnce()
    expect(store.get(flight.manifest.flightId)).toMatchObject({ status: 'failed', error: 'disk full' })
    expect(calls).not.toContain('specs-coverage')
  })
})
