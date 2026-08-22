import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FlightRunStore, type FlightStore } from './store'
import {
  startFlight,
  resumeFlight,
  setFlightAutopilot,
  respondToFlightCheckpoint,
  abortFlight,
  pauseFlight,
  redoFlight,
  deleteFlight,
  removeFlightRecordsForFeature,
  enqueueFlight,
  drainQueuedFlights,
  reopenStages,
  stampSystemLine,
  FlightConflictError,
  FlightExistsError,
  FlightFrozenError,
  FlightStageEntryError,
  type FlightConductorDeps,
  type StageAdapter,
  type StageAdapters,
  type StageOutcome,
} from './conductor'

import { FLIGHT_STAGE_KEYS, type FlightOptions, type FlightStageKey } from './types'

let tmpDir: string

let store: FlightRunStore

let n: number

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flights-')))
  store = new FlightRunStore(tmpDir)
  n = 0
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

const ids = () => `fl-${++n}`

const now = () => '2026-01-01T00:00:00Z'

const OPTS: FlightOptions = { env: 'local', coverageTarget: 100, yolo: false }

const doneAdapter = (calls?: FlightStageKey[]): StageAdapter => ({
  run: async (ctx) => {
    calls?.push(ctx.manifest().currentStage as FlightStageKey)
    return { kind: 'done' }
  },
})

function allDone(calls?: FlightStageKey[]): StageAdapters {
  return Object.fromEntries(FLIGHT_STAGE_KEYS.map((k) => [k, doneAdapter(calls)])) as StageAdapters
}

function deps(adapters: StageAdapters): FlightConductorDeps {
  return { store, adapters, now, newFlightId: ids }
}

function args(repo = '/repo/a') {
  return { feature: 'checkout', repoPaths: [repo], description: 'checkout flow', opts: OPTS }
}

describe('store events', () => {
  it('emits changed on every manifest transition', async () => {
    const events: string[] = []
    store.onEvent((e) => events.push(e.kind))
    const { completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(events.length).toBeGreaterThan(FLIGHT_STAGE_KEYS.length) // start + per-stage transitions + settle
    expect(new Set(events)).toEqual(new Set(['changed']))
  })

  it('offEvent stops a listener from receiving further events', async () => {
    const events: string[] = []
    const listener = (e: { kind: string }) => events.push(e.kind)
    store.onEvent(listener)
    const { completion } = startFlight(args(), deps(allDone()))
    await completion
    const countAfterFirst = events.length
    expect(countAfterFirst).toBeGreaterThan(0)

    store.offEvent(listener)
    const second = startFlight({ ...args('/repo/other'), feature: 'other' }, deps(allDone()))
    await second.completion
    expect(events.length).toBe(countAfterFirst)
  })
})

describe('index row staleness (merge-upsert can update but never delete)', () => {
  it('resume clears pauseReason from the INDEX row, not just the manifest', async () => {
    let attempts = 0
    const adapters = allDone()
    adapters.portify = {
      run: async () => {
        attempts += 1
        return attempts === 1 ? { kind: 'failed', error: 'repo has uncommitted changes' } : { kind: 'done' }
      },
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion

    // Parked: the row carries the pause reason (the pill reads it from here).
    const parkedRow = store.list().find((e) => e.flightId === manifest.flightId)!
    expect(parkedRow.status).toBe('paused')
    expect(parkedRow.pauseReason).toBe('stage-failed')

    const resumed = resumeFlight(manifest.flightId, deps(adapters))
    // Mid-drive: a running flight must not still advertise its old failure —
    // this was the "status running WITH pauseReason stage-failed" stale row.
    const runningRow = store.list().find((e) => e.flightId === manifest.flightId)!
    expect(runningRow.status).toBe('running')
    expect(runningRow.pauseReason).toBeUndefined()
    await resumed.completion
    expect(store.list().find((e) => e.flightId === manifest.flightId)!.pauseReason).toBeUndefined()
  })

  it('publishes the parked checkpoint KIND on the index row, and clears it on release', async () => {
    // The pill, picker, suites column and toasts never load a manifest, so
    // without this they cannot tell an `external-work` hand-off (work running in
    // the user's own agent) from a question aimed at the human.
    const adapters = allDone()
    adapters.scout = {
      run: async () => ({
        kind: 'checkpoint',
        checkpoint: { kind: 'external-work', message: 'hand it off', options: ['submit', 'run-internally'] },
      }),
      onCheckpointResponse: async () => ({ kind: 'done' }),
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const parked = store.list().find((e) => e.flightId === manifest.flightId)!
    expect(parked.status).toBe('waiting-for-approval')
    expect(parked.checkpointKind).toBe('external-work')

    const released = respondToFlightCheckpoint(manifest.flightId, { choice: 'submit' }, deps(adapters))
    await released.completion
    // Explicitly cleared, not merely absent from the write: the index upsert is
    // a shallow merge, so an omitted key would leave 'external-work' stuck on
    // the row for the rest of the flight.
    expect(store.list().find((e) => e.flightId === manifest.flightId)!.checkpointKind).toBeUndefined()
  })

  it('publishes stageProducer on the index row, for the same slim consumers', async () => {
    // An externally driven flight is read-only in the web UI. The pill must not
    // count it as needing input and the picker must not offer to resume it —
    // neither of which loads a manifest to find out who is driving.
    const external = startFlight(
      { ...args('/repo/ext'), feature: 'ext-flight', opts: { ...OPTS, stageProducer: 'external' } },
      deps(allDone()),
    )
    await external.completion
    expect(store.list().find((e) => e.flightId === external.manifest.flightId)!.stageProducer).toBe('external')

    const internal = startFlight({ ...args('/repo/int'), feature: 'int-flight' }, deps(allDone()))
    await internal.completion
    expect(store.list().find((e) => e.flightId === internal.manifest.flightId)!.stageProducer).toBeUndefined()
  })

  it('redo clears endedAt from the INDEX row of a settled flight', async () => {
    const first = startFlight(args(), deps(allDone()))
    await first.completion
    expect(store.list().find((e) => e.flightId === first.manifest.flightId)!.endedAt).toBeTruthy()

    const redone = startFlight({ ...args(), mode: 'redo' }, deps(allDone()))
    expect(redone.manifest.flightId).toBe(first.manifest.flightId)
    // The reset record has no endedAt; the row must drop it too, not keep the
    // old settle time glued to a freshly running flight.
    const row = store.list().find((e) => e.flightId === first.manifest.flightId)!
    expect(row.endedAt).toBeUndefined()
    await redone.completion
  })
})

describe('legacy terminal-stage repair', () => {
  it('clears a stale live stage from a terminal record when the store reopens', () => {
    const stale = {
      flightId: 'fl-legacy',
      feature: 'checkout',
      repoPaths: ['/repo/a'],
      description: 'checkout flow',
      opts: OPTS,
      status: 'aborted' as const,
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'similarity' ? 'done' as const : key === 'scout' ? 'running' as const : 'pending' as const,
      })),
      createdAt: now(),
      updatedAt: now(),
      endedAt: now(),
    }
    store.save(stale)

    const reopened = new FlightRunStore(tmpDir)
    const repaired = reopened.get(stale.flightId)!
    expect(repaired.stages.find((stage) => stage.key === 'scout')?.status).toBe('pending')
    expect(reopened.list().find((entry) => entry.flightId === stale.flightId)?.stages?.find((stage) => stage.key === 'scout')?.status).toBe('pending')
  })
})

describe('FlightRunStore.remove', () => {
  it('removes a flight and emits a removed event', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    const events: { kind: string; flightId?: string }[] = []
    store.onEvent((e) => events.push(e))

    store.remove(manifest.flightId)

    expect(store.get(manifest.flightId)).toBeNull()
    expect(store.list().find((e) => e.flightId === manifest.flightId)).toBeUndefined()
    expect(events).toContainEqual({ kind: 'removed', flightId: manifest.flightId })
  })
})

describe('FlightRunStore.renameFeature', () => {
  it('re-homes every flight on the renamed suite and reports the count', async () => {
    // A suite rename has to carry the new name into flight history rather than
    // orphaning it behind the old one.
    const a = startFlight({ ...args('/repo/a'), feature: 'checkout' }, deps(allDone()))
    await a.completion
    const b = startFlight({ ...args('/repo/b'), feature: 'other' }, deps(allDone()))
    await b.completion

    expect(store.renameFeature('checkout', 'checkout_v2')).toBe(1)
    expect(store.get(a.manifest.flightId)!.feature).toBe('checkout_v2')
    expect(store.get(b.manifest.flightId)!.feature).toBe('other')
    expect(store.latestForFeature('checkout_v2')?.flightId).toBe(a.manifest.flightId)
    expect(store.latestForFeature('checkout')).toBeNull()
  })

  it('is a no-op when no flight carries the old name', async () => {
    const { manifest, completion } = startFlight(args('/repo/a'), deps(allDone()))
    await completion
    expect(store.renameFeature('absent', 'whatever')).toBe(0)
    expect(store.get(manifest.flightId)!.feature).toBe('checkout')
  })
})

describe('FlightRunStore repo lookups', () => {
  it('activeForRepos skips an active flight whose repo set does not intersect', async () => {
    const adapters = allDone()
    adapters.scout = {
      run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'config-approval', message: 'approve?' } }),
    }
    const { manifest, completion } = startFlight(args('/repo/a'), deps(adapters))
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('waiting-for-approval')

    // Active, but a disjoint repo set — isActiveFlightStatus true, intersect false.
    expect(store.activeForRepos(['/repo/unrelated'])).toBeNull()
  })

  it('activeForRepos ignores an intersecting flight that is not active (done)', async () => {
    const { manifest, completion } = startFlight(args('/repo/a'), deps(allDone()))
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('done')

    // Intersecting repo, but terminal status — isActiveFlightStatus false.
    expect(store.activeForRepos(['/repo/a'])).toBeNull()
  })

  it('latestForRepos returns null when no flight intersects the repo set', async () => {
    const { completion } = startFlight(args('/repo/a'), deps(allDone()))
    await completion
    expect(store.latestForRepos(['/repo/nonexistent'])).toBeNull()
  })

  it('tolerates a legacy index entry with no repoPaths field', async () => {
    const adapters = allDone()
    adapters.scout = {
      run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'config-approval', message: 'approve?' } }),
    }
    const { manifest, completion } = startFlight(args('/repo/a'), deps(adapters))
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('waiting-for-approval') // still active
    // Simulate a pre-repoPaths on-disk record (schema predates the field) —
    // the store reads its index back with a blind `as FlightIndexEntry[]`
    // cast, so a legacy/malformed record isn't caught by the type system.
    const legacy = { ...store.get(manifest.flightId)! } as Record<string, unknown>
    delete legacy.repoPaths
    store.save(legacy as unknown as Parameters<typeof store.save>[0])

    expect(store.activeForRepos(['/repo/a'])).toBeNull()
    expect(store.latestForRepos(['/repo/a'])).toBeNull()
  })
})
