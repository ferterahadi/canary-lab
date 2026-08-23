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

  it('re-invoking an existing record with fromStage but no explicit mode implies "jump"', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('done')

    // No `mode` passed — fromStage alone implies 'jump'. fromStage 'similarity'
    // needs no validator (stage 1 is a plain entry), so this exercises the
    // implied-jump path end to end on the SAME record.
    const rerun = startFlight({ ...args(), fromStage: 'similarity' as const }, deps(allDone()))
    expect(rerun.manifest.flightId).toBe(manifest.flightId)
    await rerun.completion
    expect(store.get(manifest.flightId)!.status).toBe('done')
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

  it('a jump to evaluation-export adopts a standalone run when the record has none', async () => {
    const adapters = allDone()
    let exportSawRunId: string | undefined
    adapters['evaluation-export'] = {
      run: async (ctx) => { exportSawRunId = ctx.manifest().links?.runId; return { kind: 'done' } },
    }
    const first = startFlight(args(), deps(adapters))
    await first.completion
    // The pipeline produced no run of its own, so the jump's only prerequisite
    // is the standalone passed run the resolver finds on disk.
    expect(store.get(first.manifest.flightId)!.links?.runId).toBeUndefined()

    const jumped = startFlight({ ...args(), mode: 'jump' as const, fromStage: 'evaluation-export' as const }, {
      ...deps(adapters),
      validateStageEntry: () => null,
      resolveStageEntryLinks: () => ({ runId: 'standalone-7' }),
    })
    await jumped.completion

    expect(exportSawRunId).toBe('standalone-7')
  })

  it('rejects fromStage when no validator is wired (stage entry unsupported)', () => {
    expect(() =>
      startFlight({ ...args(), fromStage: 'docs' as const }, deps(allDone())),
    ).toThrow(/stage entry is not supported/)
  })

  it('rejects an unknown fromStage key before consulting the validator', () => {
    expect(() =>
      startFlight(
        { ...args(), fromStage: 'not-a-real-stage' as unknown as FlightStageKey },
        deps(allDone()),
      ),
    ).toThrow(/unknown stage: not-a-real-stage/)
  })

  it('fromStage "similarity" is a plain stage-1 start — no validator required', async () => {
    const { manifest, completion } = startFlight(
      { ...args(), fromStage: 'similarity' as const },
      deps(allDone()), // no validateStageEntry wired at all
    )
    expect(manifest.currentStage).toBe('similarity')
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('done')
  })

  it('rejects a re-invoke of an active flight for the SAME feature even with a disjoint repo set', async () => {
    const adapters = allDone()
    adapters.scout = {
      run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'config-approval', message: 'approve?' } }),
    }
    const first = startFlight(args('/repo/a'), deps(adapters))
    await first.completion
    expect(store.get(first.manifest.flightId)!.status).toBe('waiting-for-approval')

    // /repo/b does not intersect /repo/a, so the repo-keyed lock (activeForRepos)
    // does not fire — the feature-keyed check is what must catch this.
    let err: unknown
    try {
      startFlight(args('/repo/b'), deps(allDone()))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(FlightConflictError)
    expect((err as FlightConflictError).existingFlightId).toBe(first.manifest.flightId)
    expect((err as FlightConflictError).repoPaths).toEqual(['/repo/a'])
  })

  it('mode "continue" on a record that is not paused re-raises the three-way choice', async () => {
    const { completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(store.list().find((e) => e.feature === 'checkout')!.status).toBe('done')
    expect(() => startFlight({ ...args(), mode: 'continue' as const }, deps(allDone()))).toThrow(
      FlightExistsError,
    )
  })

  it('mode "jump" without a fromStage is rejected', async () => {
    const { completion } = startFlight(args(), deps(allDone()))
    await completion
    expect(() => startFlight({ ...args(), mode: 'jump' as const }, deps(allDone()))).toThrow(
      /jump requires fromStage/,
    )
  })

  it('a fresh record (no existing flight) still requires a real description', () => {
    expect(() =>
      startFlight(
        { feature: 'brand-new', repoPaths: ['/repo/new'], description: '   ', opts: OPTS },
        deps(allDone()),
      ),
    ).toThrow(/a description is required to start one/)
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
      /no longer waiting for an answer/,
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

// `stageProducer` decides whether the hand-off-capable stages (scout, docs,
// specs-coverage) are executed by a locally spawned CLI or by the MCP client
// driving the flight. It is sticky for the same reason `agent` is: the surviving
// stage artifacts were produced by one executor, and the later stages read them.
describe('startFlight — stageProducer stickiness', () => {
  const externalArgs = (over: Partial<FlightOptions> = {}) => ({
    ...args(),
    opts: { ...OPTS, stageProducer: 'external' as const, ...over },
  })

  it('stores stageProducer on a fresh start', async () => {
    const { manifest, completion } = startFlight(externalArgs(), deps(allDone()))
    await completion
    expect(store.get(manifest.flightId)!.opts.stageProducer).toBe('external')
  })

  it('a jump KEEPS the stored producer even when the caller sends a different one', async () => {
    const first = startFlight(externalArgs(), deps(allDone()))
    await first.completion
    const jumped = startFlight(
      { ...args(), opts: { ...OPTS, stageProducer: 'internal' as const }, mode: 'jump' as const, fromStage: 'run' as const },
      { ...deps(allDone()), validateStageEntry: () => null },
    )
    await jumped.completion
    // Mid-pipeline re-entry must not switch executor: scout/docs/specs artifacts
    // on this record came from the external client.
    expect(store.get(jumped.manifest.flightId)!.opts.stageProducer).toBe('external')
  })

  it('a full redo MAY change the producer, since every artifact is discarded', async () => {
    const first = startFlight(externalArgs(), deps(allDone()))
    await first.completion
    const redone = startFlight(
      { ...args(), opts: { ...OPTS, stageProducer: 'internal' as const }, mode: 'redo' as const },
      deps(allDone()),
    )
    await redone.completion
    expect(store.get(redone.manifest.flightId)!.opts.stageProducer).toBe('internal')
  })

  it('a redo that OMITS the producer keeps the stored one', async () => {
    const first = startFlight(externalArgs(), deps(allDone()))
    await first.completion
    const redone = startFlight({ ...args(), mode: 'redo' as const }, deps(allDone()))
    await redone.completion
    expect(store.get(redone.manifest.flightId)!.opts.stageProducer).toBe('external')
  })

  it('leaves the key absent entirely for an internal flight — the GUI default', async () => {
    const { manifest, completion } = startFlight(args(), deps(allDone()))
    await completion
    expect('stageProducer' in store.get(manifest.flightId)!.opts).toBe(false)
  })
})
