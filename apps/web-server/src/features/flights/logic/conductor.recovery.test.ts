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

describe('failure + resume', () => {
  it('parks the flight paused on a failed stage and resumes from that stage', async () => {
    let attempts = 0
    const adapters = allDone()
    adapters['env-capture'] = {
      run: async () => {
        attempts += 1
        return attempts === 1 ? { kind: 'failed', error: 'missing .env' } : { kind: 'done' }
      },
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion

    const paused = store.get(manifest.flightId)!
    expect(paused.status).toBe('paused')
    expect(paused.error).toBe('missing .env')
    const failed = paused.stages.find((s) => s.key === 'env-capture')!
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('missing .env')
    // Earlier stages keep their verdicts — resume never restarts from zero.
    expect(paused.stages.find((s) => s.key === 'scaffold')!.status).toBe('done')

    const resumed = resumeFlight(manifest.flightId, deps(adapters))
    await resumed.completion
    expect(attempts).toBe(2)
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    expect(final.error).toBeUndefined()
    expect(final.stages.every((s) => s.status === 'done')).toBe(true)
  })

  it('refuses to resume a flight that is not paused', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(() => resumeFlight(manifest.flightId, deps(allDone()))).toThrow(/not paused/)
  })

  it('fails a stage with no adapter and stays resumable', async () => {
    const adapters = allDone()
    delete adapters.portify
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const parked = store.get(manifest.flightId)!
    expect(parked.status).toBe('paused')
    expect(parked.stages.find((s) => s.key === 'portify')!.error).toMatch(/no adapter/)
  })
})

describe('skipped outcome', () => {
  it('marks a stage skipped and continues to the next stage', async () => {
    const calls: FlightStageKey[] = []
    const adapters = allDone(calls)
    adapters.docs = { run: async () => ({ kind: 'skipped', reason: 'no docs requested' }) }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    const docs = final.stages.find((s) => s.key === 'docs')!
    expect(docs.status).toBe('skipped')
    expect(docs.skipReason).toBe('no docs requested')
    expect(docs.checkpoint).toBeUndefined()
    expect(calls).toContain('prd-summary')
  })
})

describe('adapter throws', () => {
  it('treats a thrown/rejected adapter as a failed outcome and pauses the flight', async () => {
    const adapters = allDone()
    adapters.scaffold = {
      run: async () => {
        throw new Error('adapter blew up')
      },
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('paused')
    expect(final.error).toBe('adapter blew up')
    expect(final.stages.find((s) => s.key === 'scaffold')!.status).toBe('failed')
  })

  it('stringifies a non-Error throw from an adapter', async () => {
    const adapters = allDone()
    adapters.scaffold = {
      run: async () => {
        throw 'plain string boom'
      },
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.error).toBe('plain string boom')
  })
})

describe('machine bug (outer catch)', () => {
  it('fails the flight hard when the manifest disappears mid-drive', async () => {
    const adapters = allDone()
    adapters.scaffold = {
      run: async () => {
        store.remove('fl-1')
        return { kind: 'done' }
      },
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    expect(store.get(manifest.flightId)).toBeNull()
  })

  it('records a non-Error thrown by the machine itself as a string', async () => {
    let throwOnce = true
    const badStore: FlightStore = {
      list: (...a) => store.list(...a),
      get: (id: string) => {
        const m = store.get(id)
        if (throwOnce && m && m.status === 'running' && m.currentStage === 'scaffold') {
          throwOnce = false
          throw 'machine bug string'
        }
        return m
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
    const adapters = allDone()
    const { manifest, completion } = startFlight(args(), { store: badStore, adapters, now, newFlightId: ids })
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('failed')
    expect(final.error).toBe('machine bug string')
  })

  it('records a real Error thrown by the machine itself via its message', async () => {
    let throwOnce = true
    const badStore: FlightStore = {
      list: (...a) => store.list(...a),
      get: (id: string) => {
        const m = store.get(id)
        if (throwOnce && m && m.status === 'running' && m.currentStage === 'scaffold') {
          throwOnce = false
          throw new Error('machine bug object')
        }
        return m
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
    const adapters = allDone()
    const { manifest, completion } = startFlight(args(), { store: badStore, adapters, now, newFlightId: ids })
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('failed')
    expect(final.error).toBe('machine bug object')
  })
})

describe('crash recovery', () => {
  it('reconcileInterrupted flips a dead running flight to paused and its running stage to pending', async () => {
    // Simulate a flight a dead process left mid-stage.
    const { manifest } = startFlight(args(), {
      store,
      now,
      newFlightId: ids,
      adapters: { similarity: { run: () => new Promise(() => {}) } }, // hangs forever
    })
    const live = store.get(manifest.flightId)!
    expect(live.status).toBe('running')
    expect(live.stages[0].status).toBe('running')

    const fresh = new FlightRunStore(tmpDir) // "new process"
    fresh.reconcileInterrupted(() => '2026-01-02T00:00:00Z')
    const recovered = fresh.get(manifest.flightId)!
    expect(recovered.status).toBe('paused')
    expect(recovered.stages[0].status).toBe('pending')
    expect(recovered.error).toMatch(/Interrupted by server restart/)

    // The recovered flight resumes from the interrupted stage.
    const resumed = resumeFlight(manifest.flightId, { store: fresh, now, adapters: allDone() })
    await resumed.completion
    expect(fresh.get(manifest.flightId)!.status).toBe('done')
  })

  it('a paused flight releases the single-flight lock', async () => {
    const { manifest } = startFlight(args(), {
      store,
      now,
      newFlightId: ids,
      adapters: { similarity: { run: () => new Promise(() => {}) } },
    })
    expect(store.activeForRepos(['/repo/a'])?.flightId).toBe(manifest.flightId)
    store.reconcileInterrupted(now)
    expect(store.activeForRepos(['/repo/a'])).toBeNull()
    expect(store.latestForRepos(['/repo/a'])?.flightId).toBe(manifest.flightId)
  })
})

describe('resume replays the in-flight answer (R78: resume is seamless, never a re-ask)', () => {
  it('a stage paused MID-EXECUTION of its answer re-runs with the same answer — the fork is not re-asked', async () => {
    const runCalls: string[] = []
    const responses: Array<Record<string, unknown>> = []
    const adapters = allDone()
    adapters.docs = {
      run: async () => {
        runCalls.push('run')
        return {
          kind: 'checkpoint',
          checkpoint: { kind: 'prd-source', message: 'where from?', options: ['collect-repo-docs', 'infer-from-diff'] },
        }
      },
      onCheckpointResponse: async (ctx, response) => {
        responses.push(response as Record<string, unknown>)
        if (responses.length === 1) {
          // Simulate the collector agent: park until the pause aborts us, then
          // die the way a SIGTERMed spawn does.
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) return resolve()
            ctx.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          throw new Error('collector cancelled by pause')
        }
        return { kind: 'done', evidence: { source: 'agent-repo-docs' } }
      },
    }
    const d = deps(adapters)
    const first = startFlight(args(), d)
    await first.completion
    const flightId = first.manifest.flightId
    expect(store.get(flightId)!.status).toBe('waiting-for-approval')

    const responded = respondToFlightCheckpoint(flightId, { choice: 'collect-repo-docs' }, d)
    pauseFlight(flightId, d) // aborts the in-flight collector
    await responded.completion
    expect(store.get(flightId)!.status).toBe('paused')

    const resumed = resumeFlight(flightId, d)
    await resumed.completion

    // The answer replayed; run() (the fork) was never re-entered.
    expect(responses).toHaveLength(2)
    expect(responses[1]).toMatchObject({ choice: 'collect-repo-docs' })
    expect(runCalls).toEqual(['run'])
    expect(store.get(flightId)!.status).toBe('done')
  })

  it('an answer that was already SPENT (stage re-parked, then paused while waiting) is not replayed — resume re-asks', async () => {
    const runCalls: string[] = []
    const responses: string[] = []
    const adapters = allDone()
    adapters.docs = {
      run: async () => {
        runCalls.push('run')
        return {
          kind: 'checkpoint',
          // A kind with no autopilot default, so every park reaches the test.
          checkpoint: { kind: 'similarity-choice', message: 'pick', options: ['a', 'b'] },
        }
      },
      onCheckpointResponse: async (_ctx, response) => {
        responses.push(String(response.choice))
        // The answer "fails" — same checkpoint parks again.
        return {
          kind: 'checkpoint',
          checkpoint: { kind: 'similarity-choice', message: 'pick again', options: ['a', 'b'] },
        }
      },
    }
    const d = deps(adapters)
    const first = startFlight(args(), d)
    await first.completion
    const flightId = first.manifest.flightId

    const responded = respondToFlightCheckpoint(flightId, { choice: 'a' }, d)
    await responded.completion // consumed → re-parked, waiting again
    expect(store.get(flightId)!.status).toBe('waiting-for-approval')

    pauseFlight(flightId, d) // paused while PARKED — the old answer is spent
    const resumed = resumeFlight(flightId, d)
    await resumed.completion

    // Resume re-ran the stage (re-asking), it did NOT replay the stale 'a'.
    expect(responses).toEqual(['a'])
    expect(runCalls).toEqual(['run', 'run'])
    expect(store.get(flightId)!.status).toBe('waiting-for-approval')
  })
})
