import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FlightRunStore } from './store'
import {
  startFlight,
  resumeFlight,
  respondToFlightCheckpoint,
  redoFlight,
  pauseFlight,
  enqueueFlight,
  drainQueuedFlights,
  type FlightConductorDeps,
  type StageAdapter,
  type StageAdapters,
  type StageOutcome,
} from './conductor'
import { FLIGHT_STAGE_KEYS, type FlightOptions, type FlightStageKey } from './types'

// The work clock (FlightStage.activeMs / activeSince, FlightManifest.startedAt).
// Every test drives a real conductor over a tick-able clock, because the whole
// point of the clock is WHAT time gets counted: a stage parked overnight on a
// checkpoint must report its seconds of work, not the wait, and a flight's
// ELAPSED must start when work does — not at enqueue, and not at a week-old
// original start the redo replaced.

let tmpDir: string
let store: FlightRunStore
let n: number
let clock: number

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-dur-')))
  store = new FlightRunStore(tmpDir)
  n = 0
  clock = Date.parse('2026-01-01T00:00:00Z')
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

const ids = () => `fl-${++n}`
const now = () => new Date(clock).toISOString()
const tick = (ms: number) => { clock += ms }

const OPTS: FlightOptions = { env: 'local', coverageTarget: 100, yolo: false }

const doneAdapter = (workMs = 0): StageAdapter => ({
  teardown: () => null,
  run: async () => {
    tick(workMs)
    return { kind: 'done' }
  },
})

function allDone(): StageAdapters {
  return Object.fromEntries(FLIGHT_STAGE_KEYS.map((k) => [k, doneAdapter()])) as StageAdapters
}

function deps(adapters: StageAdapters): FlightConductorDeps {
  return { store, adapters, now, newFlightId: ids }
}

function args(feature = 'checkout') {
  return { feature, repoPaths: ['/repo/a'], description: 'checkout flow', opts: OPTS }
}

describe('stage work clock (activeMs / activeSince)', () => {
  it('a settled stage banks exactly its work, and a checkpoint park stops the clock', async () => {
    const adapters = allDone()
    // scout: 5s of work, then parks a checkpoint no autopilot answers.
    adapters.scout = {
      teardown: () => null,
      run: async () => {
        tick(5_000)
        return {
          kind: 'checkpoint',
          checkpoint: { kind: 'similarity-choice', message: 'existing suite?', options: ['fresh'] },
        } satisfies StageOutcome
      },
      onCheckpointResponse: async () => {
        tick(2_000)
        return { kind: 'done' } satisfies StageOutcome
      },
    }
    const d = deps(adapters)
    const { manifest, completion } = startFlight(args(), d)
    await completion

    const parked = store.get(manifest.flightId)!
    const scoutParked = parked.stages.find((s) => s.key === 'scout')!
    expect(scoutParked.status).toBe('waiting-for-approval')
    // The 5s segment is banked at the park; the clock is stopped.
    expect(scoutParked.activeMs).toBe(5_000)
    expect(scoutParked.activeSince).toBeUndefined()

    // The overnight wait at the checkpoint — the exact time the old
    // startedAt→endedAt span lied about.
    tick(9 * 3_600_000)

    const { completion: rest } = respondToFlightCheckpoint(manifest.flightId, { choice: 'fresh' }, d)
    await rest

    const scout = store.get(manifest.flightId)!.stages.find((s) => s.key === 'scout')!
    expect(scout.status).toBe('done')
    // 5s before the park + 2s answering it. Not nine hours.
    expect(scout.activeMs).toBe(7_000)
    expect(scout.activeSince).toBeUndefined()
    // The wall-clock span still shows the wait — which is why durations must
    // read activeMs, and why this assertion documents the difference.
    expect(Date.parse(scout.endedAt!) - Date.parse(scout.startedAt!)).toBeGreaterThan(9 * 3_600_000)
  })

  it('a user pause banks the open segment; resume re-runs on a fresh segment', async () => {
    const adapters = allDone()
    const d = deps(adapters)
    let paused = false
    adapters.scout = {
      teardown: () => null,
      run: async () => {
        if (!paused) {
          paused = true
          tick(4_000)
          await pauseFlight('fl-1', d)
          return { kind: 'failed', error: 'SIGTERM' } satisfies StageOutcome
        }
        tick(1_000)
        return { kind: 'done' } satisfies StageOutcome
      },
    }
    const { manifest, completion } = startFlight(args(), d)
    await completion

    const afterPause = store.get(manifest.flightId)!.stages.find((s) => s.key === 'scout')!
    expect(afterPause.status).toBe('pending')
    expect(afterPause.activeMs).toBe(4_000)
    expect(afterPause.activeSince).toBeUndefined()
    // The interrupted marker survives the pause — banking must not clear it.
    expect(afterPause.startedAt).toBeDefined()

    tick(60 * 60_000) // paused for an hour
    const { completion: resumed } = resumeFlight(manifest.flightId, deps(adapters))
    await resumed

    const scout = store.get(manifest.flightId)!.stages.find((s) => s.key === 'scout')!
    expect(scout.status).toBe('done')
    expect(scout.activeMs).toBe(5_000)
  })

  it('a server-restart reconcile clears the live segment WITHOUT banking the downtime', () => {
    const flightId = 'fl-crashed'
    store.save({
      flightId,
      feature: 'checkout',
      repoPaths: ['/repo/a'],
      description: 'checkout flow',
      opts: OPTS,
      status: 'running',
      currentStage: 'scout',
      stages: [
        { key: 'similarity', status: 'done', activeMs: 1_000 },
        { key: 'scout', status: 'running', startedAt: now(), activeSince: now(), activeMs: 2_000 },
      ],
      createdAt: now(),
      updatedAt: now(),
    })
    tick(3 * 3_600_000) // dead server for three hours

    const reopened = new FlightRunStore(tmpDir)
    reopened.reconcileInterrupted(now)
    const scout = reopened.get(flightId)!.stages.find((s) => s.key === 'scout')!
    expect(scout.status).toBe('pending')
    expect(scout.activeSince).toBeUndefined()
    // The crash time is unknowable, so nothing was banked: the prior 2s stand,
    // the downtime never lands in the number.
    expect(scout.activeMs).toBe(2_000)
  })
})

describe('durable stage substage timings', () => {
  it('banks named wall phases and checkpoint wait without double-counting resume', async () => {
    const adapters = allDone()
    adapters.scout = {
      teardown: () => null,
      run: async (ctx) => {
        ctx.setTimingPhase?.('authoring')
        tick(3_000)
        ctx.setTimingPhase?.('validation')
        tick(2_000)
        return { kind: 'checkpoint', checkpoint: { kind: 'similarity-choice', message: 'approve?', options: ['approve'] } }
      },
      onCheckpointResponse: async (ctx) => {
        ctx.setTimingPhase?.('mapping')
        tick(4_000)
        return { kind: 'done' }
      },
    }
    const d = deps(adapters)
    const { manifest, completion } = startFlight(args(), d)
    await completion
    tick(60_000)
    const { completion: resumed } = respondToFlightCheckpoint(manifest.flightId, { choice: 'approve' }, d)
    await resumed

    const timings = store.get(manifest.flightId)!.stages.find((stage) => stage.key === 'scout')!.timings
    expect(timings).toEqual({
      authoring: { elapsedMs: 3_000 },
      validation: { elapsedMs: 2_000 },
      'checkpoint-wait': { elapsedMs: 60_000 },
      mapping: { elapsedMs: 4_000 },
    })
  })

  it('drops an unknowable live segment on restart but keeps its banked total', () => {
    const flightId = 'fl-substage-crashed'
    store.save({
      flightId,
      feature: 'checkout',
      repoPaths: ['/repo/a'],
      description: 'checkout flow',
      opts: OPTS,
      status: 'running',
      currentStage: 'specs-coverage',
      stages: [{
        key: 'specs-coverage',
        status: 'running',
        activeSince: now(),
        timings: { authoring: { elapsedMs: 2_000, since: now() } },
      }],
      createdAt: now(),
      updatedAt: now(),
    })
    tick(60_000)

    const reopened = new FlightRunStore(tmpDir)
    reopened.reconcileInterrupted(now)
    expect(reopened.get(flightId)!.stages[0].timings).toEqual({ authoring: { elapsedMs: 2_000 } })
  })
})

describe('flight startedAt (ELAPSED starts when work does)', () => {
  it('a queued flight is stamped at dequeue, not at enqueue', async () => {
    const adapters = allDone()
    const d = deps(adapters)
    const queued = enqueueFlight(args('parked-suite'), d)
    expect(queued.startedAt).toBeUndefined()
    expect(queued.createdAt).toBe('2026-01-01T00:00:00.000Z')

    tick(45 * 60_000) // siblings run for 45 minutes
    drainQueuedFlights(d)
    await new Promise((r) => setTimeout(r, 0))
    // Drive settles asynchronously — poll the record until it is done.
    for (let i = 0; i < 200 && store.get(queued.flightId)!.status !== 'done'; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
    }

    const final = store.get(queued.flightId)!
    expect(final.status).toBe('done')
    expect(final.startedAt).toBe('2026-01-01T00:45:00.000Z')
  })

  it('a redo re-stamps startedAt while createdAt keeps the record identity', async () => {
    const adapters = allDone()
    const d = deps(adapters)
    const { manifest, completion } = startFlight(args(), d)
    await completion
    expect(store.get(manifest.flightId)!.startedAt).toBe('2026-01-01T00:00:00.000Z')

    tick(7 * 24 * 3_600_000) // a week later
    const { completion: redone } = redoFlight(manifest.flightId, deps(adapters))
    await redone

    const final = store.get(manifest.flightId)!
    expect(final.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(final.startedAt).toBe('2026-01-08T00:00:00.000Z')
  })
})
