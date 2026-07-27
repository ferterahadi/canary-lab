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

describe('abortFlight', () => {
  it('refuses to abort an unknown flight id', () => {
    expect(() => abortFlight('nope', deps(allDone()))).toThrow(/flight not found: nope/)
  })

  it('settles a parked checkpoint like pause does — a terminal record keeps no answerable ask', async () => {
    const adapters = allDone()
    adapters.docs = {
      run: async () => ({
        kind: 'checkpoint',
        checkpoint: { kind: 'prd-source', message: 'docs?', options: ['collect-repo-docs'] },
      }),
    }
    const d = deps(adapters)
    const { manifest, completion } = startFlight(args(), d)
    await completion // parks on the docs checkpoint
    expect(store.get(manifest.flightId)!.status).toBe('waiting-for-approval')
    abortFlight(manifest.flightId, d)
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('aborted')
    const docsStage = final.stages.find((s) => s.key === 'docs')!
    expect(docsStage.status).toBe('pending')
    expect(docsStage.checkpoint).toBeUndefined()
  })
})

describe('abort', () => {
  it('stops advancing once aborted, even mid-stage', async () => {
    const calls: FlightStageKey[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const adapters = allDone(calls)
    const d = deps(adapters)
    adapters.scout = {
      run: async () => {
        abortFlight('fl-1', d)
        await gate
        return { kind: 'done' } satisfies StageOutcome
      },
    }
    const { manifest, completion } = startFlight(args(), d)
    release()
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('aborted')
    // similarity ran; scout's work settled but nothing after it started.
    expect(calls).toEqual(['similarity'])
  })
})

describe('deleteFlight', () => {
  it('removes a settled record so the feature can start fresh', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    deleteFlight(manifest.flightId, deps(allDone()))
    expect(store.get(manifest.flightId)).toBeNull()
    expect(store.latestForFeature('checkout')).toBeNull()
  })

  it('R76: removeFlightRecordsForFeature clears every settled record; an active flight blocks it', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    const cleared = removeFlightRecordsForFeature(store, 'checkout')
    expect(cleared).toEqual({ removed: 1 })
    expect(store.get(manifest.flightId)).toBeNull()
    expect(store.latestForFeature('checkout')).toBeNull()

    // Active → error, nothing removed.
    const adapters = allDone()
    adapters.scout = { run: () => new Promise(() => {}) }
    const live = startFlight(args(), deps(adapters))
    await new Promise((r) => setTimeout(r, 10))
    const blocked = removeFlightRecordsForFeature(store, 'checkout')
    expect(blocked.error).toMatch(/pause it before deleting/)
    expect(blocked.removed).toBe(0)
    expect(store.get(live.manifest.flightId)).not.toBeNull()
  })

  it('rejects deleting an active flight — stop it first', async () => {
    const adapters = allDone()
    adapters.scout = { run: () => new Promise(() => {}) }
    const { manifest } = startFlight(args(), deps(adapters))
    await new Promise((r) => setTimeout(r, 10))
    expect(() => deleteFlight(manifest.flightId, deps(allDone()))).toThrow(/stop it before deleting/)
    expect(store.get(manifest.flightId)).not.toBeNull()
  })
})

describe('enqueueFlight + drainQueuedFlights (R54)', () => {
  it('enqueue parks a fresh record paused/queued without driving it', () => {
    const queued = enqueueFlight(args(), deps(allDone()))
    expect(queued.status).toBe('paused')
    expect(queued.pauseReason).toBe('queued')
    expect(queued.stages.every((s) => s.status === 'pending')).toBe(true)
    expect(store.get(queued.flightId)!.status).toBe('paused')
  })

  it('enqueue refuses a feature that already has a record', async () => {
    const { completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(() => enqueueFlight(args(), deps(allDone()))).toThrow(FlightExistsError)
  })

  it('a settling flight drains the oldest queued sibling; the chain runs the batch sequentially', async () => {
    // Three queued flights on the same repo; drain starts them one at a time,
    // each settle pulling the next.
    const started: string[] = []
    const adapters = allDone()
    adapters.similarity = {
      run: async (ctx) => {
        started.push(ctx.manifest().feature)
        return { kind: 'done' }
      },
    }
    const d = deps(adapters)
    enqueueFlight({ ...args(), feature: 'f-one' }, d)
    enqueueFlight({ ...args(), feature: 'f-two' }, d)
    enqueueFlight({ ...args(), feature: 'f-three' }, d)
    drainQueuedFlights(d)
    // Drains cascade off each settle; wait for the tail to finish.
    await new Promise((r) => setTimeout(r, 50))
    expect(started).toEqual(['f-one', 'f-two', 'f-three'])
    expect(store.list().every((e) => e.status === 'done')).toBe(true)
  })

  it('drain skips queued flights whose repos are held by an active flight', async () => {
    const adapters = allDone()
    adapters.scout = { run: () => new Promise(() => {}) }
    startFlight({ ...args(), feature: 'holder' }, deps(adapters))
    await new Promise((r) => setTimeout(r, 10))
    const d = deps(allDone())
    const queued = enqueueFlight({ ...args(), feature: 'waiting' }, d)
    drainQueuedFlights(d)
    expect(store.get(queued.flightId)!.status).toBe('paused')
    expect(store.get(queued.flightId)!.pauseReason).toBe('queued')
  })

  it('a queued flight on a FREE repo drains even while another repo is busy', async () => {
    const adapters = allDone()
    adapters.scout = { run: () => new Promise(() => {}) }
    startFlight({ ...args('/repo/busy'), feature: 'holder' }, deps(adapters))
    await new Promise((r) => setTimeout(r, 10))
    const d = deps(allDone())
    enqueueFlight({ ...args('/repo/free'), feature: 'free-rider' }, d)
    drainQueuedFlights(d)
    await new Promise((r) => setTimeout(r, 30))
    expect(store.latestForFeature('free-rider')!.status).toBe('done')
  })

  it('abort drains the queue too — the repo is freed', async () => {
    const adapters = allDone()
    adapters.scout = { run: () => new Promise(() => {}) }
    const d = deps(adapters)
    const { manifest } = startFlight({ ...args(), feature: 'holder' }, d)
    await new Promise((r) => setTimeout(r, 10))
    const drained = deps(allDone())
    enqueueFlight({ ...args(), feature: 'next-up' }, drained)
    abortFlight(manifest.flightId, drained)
    await new Promise((r) => setTimeout(r, 30))
    expect(store.latestForFeature('next-up')!.status).toBe('done')
  })

  it('a queued entry whose resumeFlight throws (raced with a manual start) is skipped in favor of the next queued flight', async () => {
    const adapters = allDone()
    const first = enqueueFlight({ ...args(), feature: 'f-one' }, deps(adapters))
    const second = enqueueFlight({ ...args(), feature: 'f-two' }, deps(adapters))

    // A store whose `get` reports the first queued flight as already
    // "running" (simulating a manual start that raced the drain), so
    // resumeFlight's own status guard throws for it — the underlying record
    // is untouched.
    const racingStore: FlightStore = {
      list: (...a) => store.list(...a),
      get: (id: string) => {
        const m = store.get(id)
        return id === first.flightId && m ? { ...m, status: 'running' as const } : m
      },
      activeForRepos: (...a) => store.activeForRepos(...a),
      latestForRepos: (...a) => store.latestForRepos(...a),
      latestForFeature: (...a) => store.latestForFeature(...a),
      save: (...a) => store.save(...a),
      remove: (...a) => store.remove(...a),
      flightDir: (...a) => store.flightDir(...a),
      reconcileInterrupted: (...a) => store.reconcileInterrupted(...a),
      onEvent: (...a) => store.onEvent(...a),
      offEvent: (...a) => store.offEvent(...a),
    }
    const d: FlightConductorDeps = { store: racingStore, adapters, now, newFlightId: ids }

    drainQueuedFlights(d)
    await new Promise((r) => setTimeout(r, 30))

    // f-one's resumeFlight threw ("not paused") — its real record was never
    // touched, so it stays queued; the drain moved on to f-two instead.
    expect(store.get(first.flightId)!.status).toBe('paused')
    expect(store.get(first.flightId)!.pauseReason).toBe('queued')
    expect(store.get(second.flightId)!.status).toBe('done')
  })
})
