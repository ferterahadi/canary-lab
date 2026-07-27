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

describe('restart wipe (R78)', () => {
  const SIDECARS = ['scout', 'docs', 'prd-summary', 'specs-coverage', 'coverage-map']

  function recordingAdapters(events: string[]): StageAdapters {
    return Object.fromEntries(
      FLIGHT_STAGE_KEYS.map((k) => [
        k,
        {
          run: async () => {
            events.push(`run:${k}`)
            return { kind: 'done' } as StageOutcome
          },
          reset: async () => {
            events.push(`reset:${k}`)
          },
        },
      ]),
    ) as StageAdapters
  }

  function plantSidecars(flightId: string): string {
    const flightDir = store.flightDir(flightId)
    for (const dir of SIDECARS) {
      fs.mkdirSync(path.join(flightDir, dir), { recursive: true })
      fs.writeFileSync(path.join(flightDir, dir, 'agent-session.json'), '{}')
    }
    return flightDir
  }

  it('redo resets every stage in order and deletes sidecar dirs before any stage runs', async () => {
    const events: string[] = []
    const d = deps(recordingAdapters(events))
    const first = startFlight(args(), d)
    await first.completion
    const flightDir = plantSidecars(first.manifest.flightId)

    events.length = 0
    const redone = redoFlight(first.manifest.flightId, d)
    await redone.completion

    // Every stage's reset ran, in stage order, all before the first stage ran.
    expect(events.slice(0, FLIGHT_STAGE_KEYS.length)).toEqual(FLIGHT_STAGE_KEYS.map((k) => `reset:${k}`))
    expect(events[FLIGHT_STAGE_KEYS.length]).toBe('run:similarity')
    for (const dir of SIDECARS) {
      expect(fs.existsSync(path.join(flightDir, dir)), dir).toBe(false)
    }
  })

  it('jump resets the entry stage and every later stage — never the ones before it', async () => {
    const events: string[] = []
    const d: FlightConductorDeps = { ...deps(recordingAdapters(events)), validateStageEntry: () => null }
    const first = startFlight(args(), d)
    await first.completion
    const flightDir = plantSidecars(first.manifest.flightId)

    events.length = 0
    const jumped = startFlight({ ...args(), mode: 'jump' as const, fromStage: 'docs' as const }, d)
    await jumped.completion

    const fromDocs = FLIGHT_STAGE_KEYS.slice(FLIGHT_STAGE_KEYS.indexOf('docs'))
    expect(events.filter((e) => e.startsWith('reset:'))).toEqual(fromDocs.map((k) => `reset:${k}`))
    // Earlier stages keep their sidecars (their transcripts are still true).
    expect(fs.existsSync(path.join(flightDir, 'scout'))).toBe(true)
    for (const dir of ['docs', 'prd-summary', 'specs-coverage', 'coverage-map']) {
      expect(fs.existsSync(path.join(flightDir, dir)), dir).toBe(false)
    }
    // …and their MANIFEST records too: a jump on an existing flight must NOT
    // demote the earlier steps to `stage-entry` skipped — they ran on THIS
    // record, so their `done` status (and evidence/log the UI reads for their
    // history) stays intact. Only a brand-new flight pre-skips them.
    const jumpedFinal = store.get(jumped.manifest.flightId)!
    for (const key of FLIGHT_STAGE_KEYS.slice(0, FLIGHT_STAGE_KEYS.indexOf('docs'))) {
      const s = jumpedFinal.stages.find((x) => x.key === key)!
      expect(s.status, key).toBe('done')
      expect(s.skipReason, key).toBeUndefined()
    }
  })

  it('a jump preserves the earlier stages\' evidence — not just their status', async () => {
    const adapters = allDone()
    adapters.similarity = { run: async () => ({ kind: 'done', evidence: { scanned: 2 } }) }
    const d: FlightConductorDeps = { ...deps(adapters), validateStageEntry: () => null }
    const first = startFlight(args(), d)
    await first.completion
    expect(store.get(first.manifest.flightId)!.stages.find((s) => s.key === 'similarity')!.evidence)
      .toEqual({ scanned: 2 })

    const jumped = startFlight({ ...args(), mode: 'jump' as const, fromStage: 'docs' as const }, d)
    await jumped.completion
    // The pre-jump Repo-scan evidence survives the restart untouched.
    expect(store.get(jumped.manifest.flightId)!.stages.find((s) => s.key === 'similarity')!.evidence)
      .toEqual({ scanned: 2 })
  })

  it('reset reads the PRIOR record — the old links survive into its ctx', async () => {
    let seenRunId: string | undefined
    const adapters = allDone()
    adapters.run = {
      run: async () => ({ kind: 'done' }),
      reset: async (ctx) => {
        seenRunId = ctx.manifest().links?.runId
      },
    }
    const first = startFlight(args(), deps(adapters))
    await first.completion
    store.save({ ...store.get(first.manifest.flightId)!, links: { runId: 'r-123' } })

    const redone = redoFlight(first.manifest.flightId, deps(adapters))
    await redone.completion
    expect(seenRunId).toBe('r-123')
  })

  it('gives a reset an inert context — logging, progress, and patches are no-ops', async () => {
    // The wipe runs outside a drive, so a reset that narrates its work must not
    // write to the record it is about to replace.
    const adapters = allDone()
    let called = 0
    adapters.docs = {
      run: async () => ({ kind: 'done' }),
      reset: async (ctx) => {
        called++
        expect(ctx.flightDir).toContain('flights')
        expect(ctx.signal.aborted).toBe(false)
        ctx.appendLog('[docs] wiping\n')
        ctx.setProgress({ anything: true } as never)
        ctx.patchFlight({ runVerdict: 'failed' })
      },
    }
    const first = startFlight(args(), deps(adapters))
    await first.completion

    const redone = redoFlight(first.manifest.flightId, deps(adapters))
    await redone.completion

    expect(called).toBe(1)
    // None of the inert calls leaked into the restarted record.
    expect(store.get(redone.manifest.flightId)!.runVerdict).toBeUndefined()
  })

  it('a redo with feedback but no target stage attaches the note to the first stage', async () => {
    const first = startFlight(args(), deps(allDone()))
    await first.completion

    const redone = redoFlight(first.manifest.flightId, deps(allDone()), { feedback: '  start over properly  ' })
    await redone.completion

    // Both the note target and the ask-here marker default to stage one.
    expect(redone.manifest.feedback).toEqual({ stage: FLIGHT_STAGE_KEYS[0], note: 'start over properly' })
    expect(redone.manifest.askAtStage).toBe(FLIGHT_STAGE_KEYS[0])
  })

  it('a jump over a stage the prior record never recorded marks it skipped', async () => {
    // Records written before a stage existed lack its row; the jump has to
    // synthesise a stage-entry skip rather than leave a hole in the rail.
    const first = startFlight(args(), deps(allDone()))
    await first.completion
    const prior = store.get(first.manifest.flightId)!
    store.save({ ...prior, stages: prior.stages.filter((s) => s.key !== 'scaffold') })

    const redone = redoFlight(
      first.manifest.flightId,
      { ...deps(allDone()), validateStageEntry: () => null },
      { fromStage: 'docs' },
    )
    await redone.completion

    const scaffold = redone.manifest.stages.find((s) => s.key === 'scaffold')!
    expect(scaffold).toMatchObject({ status: 'skipped', skipReason: 'stage-entry' })
  })

  it('resume replays nothing when the record has no open stage left', async () => {
    const first = startFlight(args(), deps(allDone()))
    await first.completion
    // Every stage settled, but parked — there is no stage whose answer could
    // be replayed, so resume must not read one off index -1.
    const done = store.get(first.manifest.flightId)!
    store.save({ ...done, status: 'paused', pauseReason: 'user' })

    const resumed = resumeFlight(first.manifest.flightId, deps(allDone()))
    await resumed.completion

    expect(store.get(first.manifest.flightId)!.status).toBe('done')
  })

  it('a throwing reset never blocks the restart (best-effort, like interrupt)', async () => {
    const adapters = allDone()
    adapters.docs = {
      run: async () => ({ kind: 'done' }),
      reset: async () => {
        throw new Error('boom')
      },
    }
    const first = startFlight(args(), deps(adapters))
    await first.completion

    const redone = redoFlight(first.manifest.flightId, deps(adapters))
    await redone.completion
    expect(store.get(redone.manifest.flightId)!.status).toBe('done')
  })

  it('resume never resets — it continues from the last state', async () => {
    const events: string[] = []
    const adapters = recordingAdapters(events)
    let docsAttempts = 0
    adapters.docs = {
      run: async () => {
        docsAttempts += 1
        return docsAttempts === 1 ? { kind: 'failed', error: 'flaky' } : { kind: 'done' }
      },
      reset: async () => {
        events.push('reset:docs')
      },
    }
    const first = startFlight(args(), deps(adapters))
    await first.completion
    expect(store.get(first.manifest.flightId)!.status).toBe('paused')
    const flightDir = plantSidecars(first.manifest.flightId)

    events.length = 0
    const resumed = resumeFlight(first.manifest.flightId, deps(adapters))
    await resumed.completion
    expect(store.get(first.manifest.flightId)!.status).toBe('done')
    expect(events.filter((e) => e.startsWith('reset:'))).toEqual([])
    for (const dir of SIDECARS) {
      expect(fs.existsSync(path.join(flightDir, dir)), dir).toBe(true)
    }
  })
})
