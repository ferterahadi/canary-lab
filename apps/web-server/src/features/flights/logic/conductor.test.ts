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
  FlightConflictError,
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

    // A disjoint repo set is not blocked.
    const other = startFlight(args('/repo/b'), deps(allDone()))
    await other.completion
    expect(store.get(other.manifest.flightId)!.status).toBe('done')
  })

  it('does not block a new flight once the prior one is paused (resume is a choice, not a lock)', async () => {
    const adapters = allDone()
    adapters.scaffold = { run: async () => ({ kind: 'failed', error: 'boom' }) }
    const first = startFlight(args(), deps(adapters))
    await first.completion
    expect(store.get(first.manifest.flightId)!.status).toBe('paused')

    const second = startFlight(args(), deps(allDone()))
    await second.completion
    expect(store.get(second.manifest.flightId)!.status).toBe('done')
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
    const second = startFlight(args('/repo/other'), deps(allDone()))
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
