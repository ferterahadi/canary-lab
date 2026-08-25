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
  teardown: () => null,
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

describe('pauseFlight', () => {
  it('parks an active flight resumable with pauseReason user; the open stage flips to pending', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = {
      teardown: () => null,
      run: async () => {
        const parked = await pauseFlight('fl-1', d)
        expect(parked.status).toBe('paused')
        release()
        return { kind: 'failed', error: 'SIGTERM' } satisfies StageOutcome
      },
    }
    const { manifest, completion } = startFlight(args(), d)
    await gate
    await completion
    const final = store.get(manifest.flightId)!
    // The pause-race rule: the cancellation error is NOT recorded as failed —
    // the stage stays pending, ready to re-run on resume.
    expect(final.status).toBe('paused')
    expect(final.pauseReason).toBe('user')
    expect(final.stages.find((s) => s.key === 'scout')!.status).toBe('pending')
    expect(final.stages.find((s) => s.key === 'scout')!.error).toBeUndefined()
  })

  it('persists a done outcome that settled during the pause, but never advances', async () => {
    const calls: FlightStageKey[] = []
    const adapters = allDone(calls)
    const d = deps(adapters)
    adapters.scout = {
      teardown: () => null,
      run: async (ctx) => {
        calls.push(ctx.manifest().currentStage as FlightStageKey)
        await pauseFlight('fl-1', d)
        return { kind: 'done', evidence: { finished: true } } satisfies StageOutcome
      },
    }
    const { manifest, completion } = startFlight(args(), d)
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('paused')
    // Work that finished, finished — evidence persisted…
    expect(final.stages.find((s) => s.key === 'scout')!).toMatchObject({ status: 'done', evidence: { finished: true } })
    // …but nothing after scout ran.
    expect(calls).toEqual(['similarity', 'scout'])
  })

  it('persists a skipped outcome that settled during the pause, but never advances', async () => {
    const calls: FlightStageKey[] = []
    const adapters = allDone(calls)
    const d = deps(adapters)
    adapters.docs = {
      teardown: () => null,
      run: async (ctx) => {
        calls.push(ctx.manifest().currentStage as FlightStageKey)
        await pauseFlight('fl-1', d)
        return { kind: 'skipped', reason: 'no docs needed' } satisfies StageOutcome
      },
    }
    const { manifest, completion } = startFlight(args(), d)
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('paused')
    // Work that finished, finished — the skip verdict persisted…
    expect(final.stages.find((s) => s.key === 'docs')!).toMatchObject({
      status: 'skipped',
      skipReason: 'no docs needed',
    })
    expect(final.stages.find((s) => s.key === 'docs')!.checkpoint).toBeUndefined()
    // …but nothing after docs ran.
    expect(calls.at(-1)).toBe('docs')
    expect(calls).not.toContain('prd-summary')
  })

  it('the drive loop stops itself if the flight is found paused at the top of a later iteration (defensive re-check)', async () => {
    const calls: FlightStageKey[] = []
    const adapters = allDone(calls)
    const d = deps(adapters)
    let pausedOnce = false
    // Simulate the flight being paused by another process exactly in the gap
    // between one stage settling and the next one starting — the store's own
    // "changed" event (fired synchronously by the save that marks `similarity`
    // done) is the only hook available in-process to land exactly there.
    const listener = (e: { kind: string }) => {
      if (pausedOnce || e.kind !== 'changed') return
      const m = store.get('fl-1')
      if (m?.status === 'running' && m.stages.find((s) => s.key === 'similarity')?.status === 'done') {
        pausedOnce = true
        void pauseFlight('fl-1', d)
      }
    }
    store.onEvent(listener)
    const { manifest, completion } = startFlight(args(), d)
    await completion
    store.offEvent(listener)
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('paused')
    // similarity settled done; scout never started — the loop noticed the
    // pause at the top of its next iteration instead of starting scout.
    expect(final.stages.find((s) => s.key === 'similarity')!.status).toBe('done')
    expect(final.stages.find((s) => s.key === 'scout')!.status).toBe('pending')
    expect(calls).toEqual(['similarity'])
  })

  it('the drive loop also stops itself if the flight is found aborted at the top of a later iteration (defensive re-check)', async () => {
    const calls: FlightStageKey[] = []
    const adapters = allDone(calls)
    const d = deps(adapters)
    let abortedOnce = false
    // Same defensive-recheck scenario as the paused case above, but landing
    // an abortFlight() in the gap between one stage settling and the next
    // one starting — the loop's top-of-iteration guard must catch 'aborted'
    // too, not just 'paused'.
    const listener = (e: { kind: string }) => {
      if (abortedOnce || e.kind !== 'changed') return
      const m = store.get('fl-1')
      if (m?.status === 'running' && m.stages.find((s) => s.key === 'similarity')?.status === 'done') {
        abortedOnce = true
        void abortFlight('fl-1', d)
      }
    }
    store.onEvent(listener)
    const { manifest, completion } = startFlight(args(), d)
    await completion
    store.offEvent(listener)
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('aborted')
    // similarity settled done; scout never started — the loop noticed the
    // abort at the top of its next iteration instead of starting scout.
    expect(final.stages.find((s) => s.key === 'similarity')!.status).toBe('done')
    expect(final.stages.find((s) => s.key === 'scout')!.status).toBe('pending')
    expect(calls).toEqual(['similarity'])
  })

  it('aborts the stage context signal so in-flight agent work stops promptly', async () => {
    let sawAbort = false
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = {
      teardown: () => null,
      run: (ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true
            resolve({ kind: 'failed', error: 'cancelled' })
          })
          void pauseFlight('fl-1', d)
        }),
    }
    const { completion } = startFlight(args(), d)
    await completion
    expect(sawAbort).toBe(true)
  })

  it('pausing a parked checkpoint clears it back to pending; resume re-issues it', async () => {
    const adapters = allDone()
    adapters.docs = {
      teardown: () => null,
      run: async () => ({
        kind: 'checkpoint',
        checkpoint: { kind: 'prd-source', message: 'docs?', options: ['continue'] },
      }),
    }
    const d = deps(adapters)
    const { manifest, completion } = startFlight(args(), d)
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('waiting-for-approval')

    const paused = await pauseFlight(manifest.flightId, d)
    expect(paused.status).toBe('paused')
    expect(paused.stages.find((s) => s.key === 'docs')!).toMatchObject({ status: 'pending' })
    expect(paused.stages.find((s) => s.key === 'docs')!.checkpoint).toBeUndefined()

    const resumed = resumeFlight(manifest.flightId, d)
    await resumed.completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('waiting-for-approval')
    expect(final.stages.find((s) => s.key === 'docs')!.checkpoint?.kind).toBe('prd-source')
  })

  it('stops the open stage job with "pause" and records it in the stage log', async () => {
    const reasons: string[] = []
    let seenFlightId: string | undefined
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = {
      run: () => new Promise(() => {}), // hangs
      teardown: (ctx) => ({
        id: 'job-under-test',
        stop: async (reason) => {
          reasons.push(reason)
          // ctx.manifest() re-reads the record fresh from the store — confirm
          // it resolves to the live (still-present) flight, not a stale value.
          seenFlightId = ctx.manifest().flightId
          ctx.appendLog('winding down\n')
        },
      }),
    }
    startFlight(args(), d)
    await new Promise((r) => setTimeout(r, 10))
    const paused = await pauseFlight('fl-1', d)
    expect(reasons).toEqual(['pause'])
    expect(seenFlightId).toBe('fl-1')
    // The teardown ctx is LIVE, not the inert stub it used to be. That matters:
    // a cancelled portify workflow that left no trace in the record was
    // indistinguishable from one that vanished on its own. `interruptStage`
    // writes the header line; whatever the job says lands under it.
    const scout = store.get('fl-1')!.stages.find((s) => s.key === 'scout')!
    // Stamped like every other system line the stage writes (`[teardown@<ts>]`).
    expect(scout.log).toMatch(/\[teardown@[^\]]+\] stopping job-under-test \(pause\)/)
    expect(scout.log).toContain('winding down')
    // …and the RETURNED record carries it too. The snapshot pauseFlight builds is
    // taken before the teardown runs, so returning it unchanged would hand the
    // caller a record that does not mention what was stopped.
    const returned = paused.stages.find((s) => s.key === 'scout')!
    expect(returned.log).toContain('winding down')
  })

  it('resolves only after the job has actually stopped', async () => {
    // The reason pause is awaited at all: the route replies off the back of it,
    // so "we signalled it" is not a promise worth making. No sleeps — the order
    // is asserted from the job's own completion.
    const order: string[] = []
    let releaseStop: () => void = () => {}
    const stopped = new Promise<void>((r) => (releaseStop = r))
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = {
      run: () => new Promise(() => {}),
      teardown: () => ({
        id: 'slow-job',
        stop: async () => {
          await stopped
          order.push('job-stopped')
        },
      }),
    }
    startFlight(args(), d)
    await new Promise((r) => setTimeout(r, 10))

    const pausing = pauseFlight('fl-1', d).then(() => { order.push('pause-returned') })
    releaseStop()
    await pausing
    expect(order).toEqual(['job-stopped', 'pause-returned'])
  })

  it('swallows a teardown that throws — a broken stop must not fail the pause', async () => {
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = {
      run: () => new Promise(() => {}), // hangs, interrupted by pause
      teardown: () => ({
        id: 'exploding-job',
        stop: async () => { throw new Error('subsystem unreachable') },
      }),
    }
    const { manifest } = startFlight(args(), d)
    await new Promise((r) => setTimeout(r, 10))
    // The flight still parks: the user asked to stop, and a teardown that cannot
    // reach its subsystem does not change that answer.
    const paused = await pauseFlight(manifest.flightId, d)
    expect(paused.status).toBe('paused')
    expect(paused.pauseReason).toBe('user')
  })

  it('swallows a teardown whose ctx.manifest() read fails (record deleted out-of-band)', async () => {
    let caught: unknown
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = {
      run: () => new Promise(() => {}), // hangs, interrupted by pause
      teardown: (ctx) => ({
        id: 'vanishing-job',
        stop: async () => {
          // The record disappears between the pause kicking off the teardown and
          // the job reading it back.
          store.remove('fl-1')
          try {
            ctx.manifest()
          } catch (e) {
            caught = e
          }
        },
      }),
    }
    const { manifest } = startFlight(args(), d)
    await new Promise((r) => setTimeout(r, 10))
    await expect(pauseFlight(manifest.flightId, d)).resolves.toMatchObject({ status: 'paused' })
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(`flight not found: ${manifest.flightId}`)
  })

  it('pauses cleanly when the open stage has no adapter registered at all', async () => {
    // A configuration hole rather than a stage decision — the drive itself fails
    // such a stage with "no adapter for stage x". The teardown path must not
    // throw on the way past it, or a pause would 500 on a flight that is already
    // broken.
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = { teardown: () => null, run: () => new Promise(() => {}) }
    startFlight(args(), d)
    await new Promise((r) => setTimeout(r, 10))
    delete adapters.scout
    await expect(pauseFlight('fl-1', d)).resolves.toMatchObject({ status: 'paused' })
  })

  it('stops nothing when the open stage owns no job', async () => {
    // The null case: a stage that never spawned, whose spawn already exited, or
    // that is parked on an external hand-off someone else is executing.
    let asked = 0
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = {
      run: () => new Promise(() => {}),
      teardown: () => { asked += 1; return null },
    }
    startFlight(args(), d)
    await new Promise((r) => setTimeout(r, 10))
    await pauseFlight('fl-1', d)
    expect(asked).toBe(1)
    // No teardown header written for a stage with nothing to stop.
    expect(store.get('fl-1')!.stages.find((s) => s.key === 'scout')!.log ?? '').not.toContain('[teardown]')
  })

  it('refuses to pause a non-active flight', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    await expect(pauseFlight(manifest.flightId, deps(allDone()))).rejects.toThrow(/not active/)
  })

  it('resume clears pauseReason', async () => {
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = { run: () => new Promise(() => {}) }
    const { manifest } = startFlight(args(), d)
    await new Promise((r) => setTimeout(r, 10))
    pauseFlight(manifest.flightId, d)
    const resumed = resumeFlight(manifest.flightId, deps(allDone()))
    await resumed.completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    expect(final.pauseReason).toBeUndefined()
  })

  it('a stale, superseded drive loop settling late does not corrupt a record a newer drive already finished', async () => {
    const adapters = allDone()
    const d = deps(adapters)
    let releaseStale: () => void = () => {}
    const staleGate = new Promise<void>((r) => (releaseStale = r))
    let scoutRuns = 0
    adapters.scout = {
      run: async () => {
        scoutRuns += 1
        if (scoutRuns === 1) {
          // The FIRST (stale) drive's stage settles late — after pause/resume
          // has already handed the flight to a second, newer drive loop, and
          // that second loop has itself already run to completion.
          await staleGate
          return { kind: 'done' } satisfies StageOutcome
        }
        return { kind: 'done' } satisfies StageOutcome
      },
    }
    const { manifest, completion: staleCompletion } = startFlight(args(), d)
    await new Promise((r) => setTimeout(r, 10))

    pauseFlight(manifest.flightId, d) // aborts the stale drive's controller; scout flips back to pending
    const { completion: freshCompletion } = resumeFlight(manifest.flightId, d) // registers a NEW controller for the same flightId
    await freshCompletion // the fresh drive re-runs scout (2nd invocation, resolves immediately) through to done
    expect(store.get(manifest.flightId)!.status).toBe('done')

    releaseStale() // now let the stale drive's original scout invocation settle
    await staleCompletion // must resolve cleanly — its own cleanup must not throw or hang

    // The stale drive's late 'done' redundantly re-marks scout done (a no-op
    // in effect) but must not resurrect/park the already-finished flight, and
    // its finally-block cleanup (registry entry already replaced, then
    // already deleted, by the fresh drive) must complete without error.
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    expect(final.stages.every((s) => s.status === 'done')).toBe(true)
  })
})

describe('frozen repos + intent (R57/R75)', () => {
  it('JUMP with a DIFFERENT repo set is rejected — mid-pipeline re-entry keeps the freeze', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(() =>
      startFlight({ ...args('/repo/b'), mode: 'jump', fromStage: 'scout' }, deps(allDone())),
    ).toThrow(FlightFrozenError)
    expect(store.get(manifest.flightId)!.repoPaths).toEqual(['/repo/a'])
  })

  it('JUMP with a DIFFERENT description is rejected — intent stays frozen mid-pipeline', async () => {
    const { completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(() =>
      startFlight({ ...args(), description: 'something else entirely', mode: 'jump', fromStage: 'scout' }, deps(allDone())),
    ).toThrow(FlightFrozenError)
  })

  it('REDO with different repos + intent is ACCEPTED — a full restart replaces the stored inputs (R75)', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    const redone = startFlight(
      { ...args('/repo/b'), description: 'a new intent', mode: 'redo' },
      deps(allDone()),
    )
    expect(redone.manifest.flightId).toBe(manifest.flightId) // same record, replaced inputs
    expect(redone.manifest.repoPaths).toEqual(['/repo/b'])
    expect(redone.manifest.description).toBe('a new intent')
    await redone.completion
  })

  it('redo with EMPTY repos/description reuses the stored values (the CLI/dialog omission path)', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    const redone = startFlight(
      { feature: 'checkout', repoPaths: [], description: '', opts: OPTS, mode: 'redo' },
      deps(allDone()),
    )
    expect(redone.manifest.flightId).toBe(manifest.flightId)
    expect(redone.manifest.repoPaths).toEqual(['/repo/a'])
    expect(redone.manifest.description).toBe('checkout flow')
    await redone.completion
  })

  it('a mode-carrying call for a feature with NO record still requires real inputs', async () => {
    expect(() =>
      startFlight({ feature: 'ghost', repoPaths: [], description: '', opts: OPTS, mode: 'redo' }, deps(allDone())),
    ).toThrow(FlightStageEntryError)
  })
})

describe('redoFlight', () => {
  it('restarts the record from stage 1 with its own stored args', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    const redone = redoFlight(manifest.flightId, deps(allDone()))
    await redone.completion
    const final = store.get(manifest.flightId)!
    expect(final.flightId).toBe(manifest.flightId) // same record, never a second manifest
    expect(final.status).toBe('done')
    expect(final.description).toBe('checkout flow')
  })

  it('refuses on an active flight', async () => {
    const adapters = allDone()
    adapters.scout = { run: () => new Promise(() => {}) }
    const { manifest } = startFlight(args(), deps(adapters))
    await new Promise((r) => setTimeout(r, 10))
    expect(() => redoFlight(manifest.flightId, deps(allDone()))).toThrow(/pause or abort/)
  })

  it('refuses to redo an unknown flight id', () => {
    expect(() => redoFlight('nope', deps(allDone()))).toThrow(/flight not found: nope/)
  })
})
