import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FlightRunStore, type FlightStore } from './store'
import {
  startFlight,
  resumeFlight,
  respondToFlightCheckpoint,
  abortFlight,
  pauseFlight,
  redoFlight,
  deleteFlight,
  enqueueFlight,
  drainQueuedFlights,
  reopenStages,
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

describe('startFlight', () => {
  it('advances every stage in order and settles done', async () => {
    const calls: FlightStageKey[] = []
    const { manifest, completion } = startFlight(args(), deps(allDone(calls)))
    expect(manifest.status).toBe('running')
    expect(manifest.stages).toHaveLength(FLIGHT_STAGE_KEYS.length)
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    expect(final.currentStage).toBeNull()
    expect(final.endedAt).toBe(now())
    expect(final.stages.every((s) => s.status === 'done')).toBe(true)
    expect(calls).toEqual([...FLIGHT_STAGE_KEYS])
  })

  it('surfaces the flight group on the index entry (R69: ledger/pill group pre-scaffold)', async () => {
    const grouped = startFlight(
      { ...args(), opts: { ...OPTS, group: 'Auth' } },
      deps(allDone()),
    )
    await grouped.completion
    expect(store.list().find((e) => e.flightId === grouped.manifest.flightId)?.group).toBe('Auth')

    // A flight with no group leaves the field off entirely (not '' / undefined key).
    const plain = startFlight({ ...args('/repo/plain'), feature: 'plain' }, deps(allDone()))
    await plain.completion
    const plainEntry = store.list().find((e) => e.flightId === plain.manifest.flightId)!
    expect('group' in plainEntry).toBe(false)
  })

  it('persists stage evidence computed by the adapter', async () => {
    const adapters = allDone()
    adapters.similarity = { run: async () => ({ kind: 'done', evidence: { scanned: 3 } }) }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.stages.find((s) => s.key === 'similarity')?.evidence).toEqual({ scanned: 3 })
  })

  it('rejects a second flight whose repo set intersects an active one (single-flight, 409)', async () => {
    const adapters = allDone()
    // Park the first flight on a checkpoint so it stays active.
    adapters.scout = {
      run: async () => ({
        kind: 'checkpoint',
        checkpoint: { kind: 'config-approval', message: 'approve?' },
      }),
    }
    const first = startFlight(args('/repo/a'), deps(adapters))
    await first.completion
    expect(store.get(first.manifest.flightId)!.status).toBe('waiting-for-approval')

    let err: unknown
    try {
      startFlight({ ...args('/repo/a'), feature: 'other' }, deps(allDone()))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(FlightConflictError)
    expect((err as FlightConflictError).statusCode).toBe(409)
    expect((err as FlightConflictError).existingFlightId).toBe(first.manifest.flightId)

    // A disjoint repo set (and a different feature) is not blocked.
    const other = startFlight({ ...args('/repo/b'), feature: 'unrelated' }, deps(allDone()))
    await other.completion
    expect(store.get(other.manifest.flightId)!.status).toBe('done')
  })

  it('a paused feature re-invoked without a mode gets the continue/redo/jump choice (409), and continue resumes the SAME record', async () => {
    const adapters = allDone()
    adapters.scaffold = { run: async () => ({ kind: 'failed', error: 'boom' }) }
    const first = startFlight(args(), deps(adapters))
    await first.completion
    expect(store.get(first.manifest.flightId)!.status).toBe('paused')

    let err: unknown
    try {
      startFlight(args(), deps(allDone()))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(FlightExistsError)
    expect((err as FlightExistsError).statusCode).toBe(409)
    expect((err as FlightExistsError).options).toEqual(['continue', 'redo', 'jump'])
    expect((err as FlightExistsError).existingFlightId).toBe(first.manifest.flightId)

    const second = startFlight({ ...args(), mode: 'continue' as const }, deps(allDone()))
    await second.completion
    // Same record resumed — never a second manifest for the feature.
    expect(second.manifest.flightId).toBe(first.manifest.flightId)
    expect(store.list().filter((e) => e.feature === args().feature)).toHaveLength(1)
    expect(store.get(first.manifest.flightId)!.status).toBe('done')
  })

  it('redo restarts the SAME record from stage 1 and discards prior stage evidence', async () => {
    const adapters = allDone()
    adapters.similarity = { run: async () => ({ kind: 'done', evidence: { scanned: 3 } }) }
    const first = startFlight(args(), deps(adapters))
    await first.completion
    expect(store.get(first.manifest.flightId)!.status).toBe('done')
    expect(store.get(first.manifest.flightId)!.stages[0].evidence).toEqual({ scanned: 3 })

    const redone = startFlight({ ...args(), mode: 'redo' as const }, deps(allDone()))
    await redone.completion
    expect(redone.manifest.flightId).toBe(first.manifest.flightId)
    const final = store.get(first.manifest.flightId)!
    expect(final.status).toBe('done')
    expect(final.stages[0].evidence).toBeUndefined()
    expect(store.list().filter((e) => e.feature === args().feature)).toHaveLength(1)
  })

  it('jump starts at fromStage with earlier stages skipped, gated by validateStageEntry', async () => {
    const calls: FlightStageKey[] = []
    const adapters = allDone(calls)
    // Rejecting validator blocks the jump with the named prerequisite.
    let err: unknown
    try {
      startFlight({ ...args(), fromStage: 'run' as const }, {
        ...deps(adapters),
        validateStageEntry: () => 'no specs authored yet',
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(FlightStageEntryError)
    expect((err as FlightStageEntryError).statusCode).toBe(400)
    expect((err as FlightStageEntryError).message).toBe('no specs authored yet')

    // Accepting validator: earlier stages are pre-skipped, run starts at fromStage.
    const { manifest, completion } = startFlight({ ...args(), fromStage: 'run' as const }, {
      ...deps(adapters),
      validateStageEntry: () => null,
    })
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    for (const s of final.stages) {
      if (FLIGHT_STAGE_KEYS.indexOf(s.key) < FLIGHT_STAGE_KEYS.indexOf('run')) {
        expect(s.status).toBe('skipped')
        expect(s.skipReason).toBe('stage-entry')
      }
    }
    expect(calls).toEqual(['run', 'heal', 'evaluation-export'])
  })

  it('a jump to evaluation-export keeps the validated runId; other jumps reset links', async () => {
    const adapters = allDone()
    adapters.run = { run: async (ctx) => { ctx.patchFlight({ links: { runId: 'run-42' } }); return { kind: 'done' } } }
    let exportSawRunId: string | undefined
    adapters['evaluation-export'] = {
      run: async (ctx) => { exportSawRunId = ctx.manifest().links?.runId; return { kind: 'done' } },
    }
    const first = startFlight(args(), deps(adapters))
    await first.completion
    expect(store.get(first.manifest.flightId)!.links?.runId).toBe('run-42')

    // The prerequisite the validator approved (links.runId) must survive the
    // jump's stage-record reset — the export stage reads it as its input.
    exportSawRunId = undefined
    const jumped = startFlight({ ...args(), mode: 'jump' as const, fromStage: 'evaluation-export' as const }, {
      ...deps(adapters),
      validateStageEntry: () => null,
    })
    await jumped.completion
    expect(exportSawRunId).toBe('run-42')
    expect(store.get(jumped.manifest.flightId)!.status).toBe('done')

    // A jump anywhere earlier regenerates the run — links reset as before.
    const rerun = startFlight({ ...args(), mode: 'jump' as const, fromStage: 'run' as const }, {
      ...deps(adapters),
      validateStageEntry: () => null,
    })
    expect(rerun.manifest.links).toBeUndefined()
    await rerun.completion
  })

  it('rejects fromStage when no validator is wired (stage entry unsupported)', () => {
    expect(() =>
      startFlight({ ...args(), fromStage: 'docs' as const }, deps(allDone())),
    ).toThrow(/stage entry is not supported/)
  })
})

describe('checkpoints', () => {
  it('pauses on a checkpoint and resumes through onCheckpointResponse', async () => {
    const seen: string[] = []
    const adapters = allDone()
    adapters.scout = {
      run: async () => ({
        kind: 'checkpoint',
        checkpoint: { kind: 'config-approval', message: 'approve config?', data: { config: 'cjs' } },
      }),
      onCheckpointResponse: async (_ctx, response) => {
        seen.push(response.choice ?? '')
        return { kind: 'done', evidence: { approved: true } }
      },
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion

    const parked = store.get(manifest.flightId)!
    expect(parked.status).toBe('waiting-for-approval')
    const stage = parked.stages.find((s) => s.key === 'scout')!
    expect(stage.status).toBe('waiting-for-approval')
    expect(stage.checkpoint?.kind).toBe('config-approval')

    const resumed = respondToFlightCheckpoint(manifest.flightId, { choice: 'approve' }, deps(adapters))
    await resumed.completion
    expect(seen).toEqual(['approve'])
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    const scout = final.stages.find((s) => s.key === 'scout')!
    expect(scout.status).toBe('done')
    expect(scout.evidence).toEqual({ approved: true })
    expect(scout.checkpointResponse).toEqual({ choice: 'approve' })
  })

  it('re-runs the stage on respond when the adapter has no onCheckpointResponse', async () => {
    let runs = 0
    const adapters = allDone()
    adapters.docs = {
      run: async () => {
        runs += 1
        return runs === 1
          ? { kind: 'checkpoint', checkpoint: { kind: 'prd-source', message: 'drop a PRD?' } }
          : { kind: 'done' }
      },
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const resumed = respondToFlightCheckpoint(manifest.flightId, { choice: 'infer' }, deps(adapters))
    await resumed.completion
    expect(runs).toBe(2)
    expect(store.get(manifest.flightId)!.status).toBe('done')
  })

  it('refuses a response when no checkpoint is open', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(() => respondToFlightCheckpoint(manifest.flightId, { choice: 'x' }, deps(allDone()))).toThrow(
      /not waiting for approval/,
    )
  })

  it('refuses a response for an unknown flight id', () => {
    expect(() => respondToFlightCheckpoint('nope', { choice: 'x' }, deps(allDone()))).toThrow(
      /flight not found: nope/,
    )
  })

  it('refuses a response when the manifest is waiting-for-approval but no stage is (corrupt state)', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    const current = store.get(manifest.flightId)!
    store.save({ ...current, status: 'waiting-for-approval' })
    expect(() => respondToFlightCheckpoint(manifest.flightId, { choice: 'x' }, deps(allDone()))).toThrow(
      /has no stage waiting for approval/,
    )
  })
})

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

describe('jump', () => {
  it('jumps forward without evidence (no evidence field is written)', async () => {
    const calls: FlightStageKey[] = []
    const adapters = allDone(calls)
    adapters.similarity = {
      run: async () => {
        calls.push('similarity')
        return { kind: 'jump', to: 'run', skipReason: 'no evidence to report' }
      },
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const final = store.get(manifest.flightId)!
    const similarity = final.stages.find((s) => s.key === 'similarity')!
    expect(similarity.status).toBe('done')
    expect(similarity.evidence).toBeUndefined()
  })

  it('skips the stages between a jump and its target (similarity rerun → run)', async () => {
    const calls: FlightStageKey[] = []
    const adapters = allDone(calls)
    adapters.similarity = {
      run: async (ctx) => {
        calls.push('similarity')
        ctx.patchFlight({ feature: 'existing-checkout' })
        return { kind: 'jump', to: 'run', skipReason: 'rerun of existing feature', evidence: { match: 'existing-checkout' } }
      },
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    expect(final.feature).toBe('existing-checkout')
    expect(final.stages.find((s) => s.key === 'similarity')!.status).toBe('done')
    for (const key of ['scout', 'scaffold', 'env-capture', 'docs', 'prd-summary', 'specs-coverage', 'portify'] as const) {
      const s = final.stages.find((x) => x.key === key)!
      expect(s.status).toBe('skipped')
      expect(s.skipReason).toBe('rerun of existing feature')
    }
    expect(calls).toEqual(['similarity', 'run', 'heal', 'evaluation-export'])
  })

  it('treats a backwards jump as a machine bug and parks the flight', async () => {
    const adapters = allDone()
    adapters.docs = { run: async () => ({ kind: 'jump', to: 'scout', skipReason: 'nope' }) }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('paused')
    expect(final.stages.find((s) => s.key === 'docs')!.error).toMatch(/illegal jump/)
  })
})

describe('abortFlight', () => {
  it('refuses to abort an unknown flight id', () => {
    expect(() => abortFlight('nope', deps(allDone()))).toThrow(/flight not found: nope/)
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

describe('pauseFlight', () => {
  it('parks an active flight resumable with pauseReason user; the open stage flips to pending', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = {
      run: async () => {
        const parked = pauseFlight('fl-1', d)
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
      run: async (ctx) => {
        calls.push(ctx.manifest().currentStage as FlightStageKey)
        pauseFlight('fl-1', d)
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

  it('aborts the stage context signal so in-flight agent work stops promptly', async () => {
    let sawAbort = false
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = {
      run: (ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true
            resolve({ kind: 'failed', error: 'cancelled' })
          })
          pauseFlight('fl-1', d)
        }),
    }
    const { completion } = startFlight(args(), d)
    await completion
    expect(sawAbort).toBe(true)
  })

  it('pausing a parked checkpoint clears it back to pending; resume re-issues it', async () => {
    const adapters = allDone()
    adapters.docs = {
      run: async () => ({
        kind: 'checkpoint',
        checkpoint: { kind: 'prd-source', message: 'docs?', options: ['continue'] },
      }),
    }
    const d = deps(adapters)
    const { manifest, completion } = startFlight(args(), d)
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('waiting-for-approval')

    const paused = pauseFlight(manifest.flightId, d)
    expect(paused.status).toBe('paused')
    expect(paused.stages.find((s) => s.key === 'docs')!).toMatchObject({ status: 'pending' })
    expect(paused.stages.find((s) => s.key === 'docs')!.checkpoint).toBeUndefined()

    const resumed = resumeFlight(manifest.flightId, d)
    await resumed.completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('waiting-for-approval')
    expect(final.stages.find((s) => s.key === 'docs')!.checkpoint?.kind).toBe('prd-source')
  })

  it('calls the open stage adapter interrupt hook with "pause" (best-effort)', async () => {
    const interrupts: string[] = []
    const adapters = allDone()
    const d = deps(adapters)
    adapters.scout = {
      run: () => new Promise(() => {}), // hangs
      interrupt: async (_ctx, kind) => {
        interrupts.push(kind)
      },
    }
    startFlight(args(), d)
    await new Promise((r) => setTimeout(r, 10))
    pauseFlight('fl-1', d)
    await new Promise((r) => setTimeout(r, 10))
    expect(interrupts).toEqual(['pause'])
  })

  it('refuses to pause a non-active flight', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(() => pauseFlight(manifest.flightId, deps(allDone()))).toThrow(/not active/)
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
})

describe('rewind outcome', () => {
  it('re-opens the target stage and everything up to the current one, then re-runs from the target', async () => {
    const calls: FlightStageKey[] = []
    const adapters = allDone(calls)
    let scaffoldRuns = 0
    adapters.scaffold = {
      run: async (ctx) => {
        calls.push(ctx.manifest().currentStage as FlightStageKey)
        scaffoldRuns += 1
        if (scaffoldRuns === 1) return { kind: 'rewind', to: 'scout', reason: 'redraft' }
        return { kind: 'done' }
      },
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    // scout ran twice: once forward, once after the rewind.
    expect(calls.filter((k) => k === 'scout')).toHaveLength(2)
    expect(scaffoldRuns).toBe(2)
  })

  it('a forward rewind target is illegal and parks the flight failed-stage', async () => {
    const adapters = allDone()
    adapters.scout = {
      run: async () => ({ kind: 'rewind', to: 'run', reason: 'nope' }),
    }
    const { manifest, completion } = startFlight(args(), deps(adapters))
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('paused')
    expect(final.pauseReason).toBe('stage-failed')
    expect(final.stages.find((s) => s.key === 'scout')!).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('illegal rewind'),
    })
  })
})

describe('frozen repos + intent (R57)', () => {
  it('redo with a DIFFERENT repo set is rejected — repos are frozen on the record', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(() =>
      startFlight({ ...args('/repo/b'), mode: 'redo' }, deps(allDone())),
    ).toThrow(FlightFrozenError)
    expect(store.get(manifest.flightId)!.repoPaths).toEqual(['/repo/a'])
  })

  it('redo with a DIFFERENT description is rejected — intent is frozen on the record', async () => {
    const { completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(() =>
      startFlight({ ...args(), description: 'something else entirely', mode: 'redo' }, deps(allDone())),
    ).toThrow(FlightFrozenError)
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

describe('deleteFlight', () => {
  it('removes a settled record so the feature can start fresh', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    deleteFlight(manifest.flightId, deps(allDone()))
    expect(store.get(manifest.flightId)).toBeNull()
    expect(store.latestForFeature('checkout')).toBeNull()
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
})

describe('reopenStages', () => {
  it('flips the named stages and everything after them to pending on a settled flight', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    const reopened = reopenStages(manifest.flightId, ['docs', 'prd-summary', 'specs-coverage'], deps(allDone()))!
    expect(reopened.status).toBe('paused')
    expect(reopened.pauseReason).toBe('user')
    expect(reopened.currentStage).toBe('docs')
    for (const key of ['similarity', 'scout', 'scaffold', 'env-capture'] as const) {
      expect(reopened.stages.find((s) => s.key === key)!.status).toBe('done')
    }
    for (const key of ['docs', 'prd-summary', 'specs-coverage', 'portify', 'run', 'heal', 'evaluation-export'] as const) {
      expect(reopened.stages.find((s) => s.key === key)!.status).toBe('pending')
    }
    expect(reopened.links).toBeUndefined()
  })

  it('is a no-op on an active flight (the running conductor owns it)', async () => {
    const adapters = allDone()
    adapters.scout = { run: () => new Promise(() => {}) }
    const { manifest } = startFlight(args(), deps(adapters))
    await new Promise((r) => setTimeout(r, 10))
    expect(reopenStages(manifest.flightId, ['docs'], deps(allDone()))).toBeNull()
  })

  it('is a no-op on an unknown flight or empty key set', async () => {
    expect(reopenStages('nope', ['docs'], deps(allDone()))).toBeNull()
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(reopenStages(manifest.flightId, [], deps(allDone()))).toBeNull()
  })
})
