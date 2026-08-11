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

describe('autopilot (R71/W4)', () => {
  type Kind = import('./types').FlightCheckpointKind

  const AUTO: Array<[Kind, string]> = [
    ['config-approval', 'approve'],
    ['prd-source', 'continue'],
    ['coverage-stuck', 'accept-partial'],
    ['portify-apply', 'apply'],
    ['run-failed', 'export-as-is'],
    ['export-mode', 'raw'],
  ]

  const parkThenDone = (kind: Kind, options: string[], responses: unknown[]): StageAdapter => ({
    run: async () => ({ kind: 'checkpoint', checkpoint: { kind, message: 'q?', options } }),
    onCheckpointResponse: async (_ctx, response) => {
      responses.push(response)
      return { kind: 'done' }
    },
  })

  it.each(AUTO)('auto-answers %s with "%s", records + logs it, and the flight completes', async (kind, choice) => {
    const responses: unknown[] = []
    const adapters = allDone()
    adapters.docs = parkThenDone(kind, [choice, 'other'], responses)
    const { manifest, completion } = startFlight(args(`/repo/auto-${kind}`), deps(adapters))
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    expect(responses).toEqual([{ choice }])
    const docs = final.stages.find((s) => s.key === 'docs')!
    expect(docs.checkpointResponse).toEqual({ choice })
    // The conductor stamps its own lines (`[autopilot@<iso>]`), so match the
    // tag and the message around the stamp rather than the raw literal.
    expect(docs.log).toMatch(
      new RegExp(`\\[autopilot@[^\\]]+\\] ${kind}: answered "${choice}"`),
    )
  })

  it('similarity-choice and missing-env always park — no safe default exists', async () => {
    const cases: Array<[Kind, string[]]> = [
      ['similarity-choice', ['rerun', 'enhance', 'new']],
      ['missing-env', ['retry', 'waive']],
    ]
    for (const [kind, options] of cases) {
      const adapters = allDone()
      adapters.docs = {
        run: async () => ({ kind: 'checkpoint', checkpoint: { kind, message: 'q?', options } }),
      }
      const { manifest, completion } = startFlight(
        { ...args(`/repo/park-${kind}`), feature: `f-${kind}` },
        deps(adapters),
      )
      await completion
      const final = store.get(manifest.flightId)!
      expect(final.status).toBe('waiting-for-approval')
      expect(final.stages.find((s) => s.key === 'docs')!.log ?? '').not.toContain('[autopilot]')
    }
  })

  it('prd-source with NO docs falls through to "collect-repo-docs" — the fork is not a stop under autopilot', async () => {
    const responses: unknown[] = []
    const adapters = allDone()
    adapters.docs = parkThenDone('prd-source', ['collect-repo-docs', 'infer-from-diff'], responses)
    const { manifest, completion } = startFlight(args('/repo/no-docs'), deps(adapters))
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('done')
    expect(responses).toEqual([{ choice: 'collect-repo-docs' }])
  })

  it('prd-source parks when no mapped choice is offered at all', async () => {
    const adapters = allDone()
    adapters.docs = {
      run: async () => ({
        kind: 'checkpoint',
        checkpoint: { kind: 'prd-source', message: 'no docs yet', options: ['infer-from-diff', 'retry'] },
      }),
    }
    const { manifest, completion } = startFlight(args('/repo/no-mapped'), deps(adapters))
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('waiting-for-approval')
  })

  it('a checkpoint carrying a failed prior attempt parks — autopilot never re-runs the collector that came back empty', async () => {
    const responses: unknown[] = []
    const adapters = allDone()
    adapters.docs = {
      run: async () => ({
        kind: 'checkpoint',
        checkpoint: {
          kind: 'prd-source',
          message: 'nothing found',
          options: ['collect-repo-docs', 'infer-from-diff'],
          data: { docs: [], linked: [], intent: 'x', lastAttempt: { mode: 'collect-repo-docs', outcome: 'empty' } },
        },
      }),
      onCheckpointResponse: async (_ctx, response) => {
        responses.push(response)
        return { kind: 'done' }
      },
    }
    const { manifest, completion } = startFlight(args('/repo/re-park'), deps(adapters))
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('waiting-for-approval')
    expect(responses).toEqual([])
  })

  it('opts.autopilot === false parks every checkpoint (opt-out)', async () => {
    const responses: unknown[] = []
    const adapters = allDone()
    adapters.docs = parkThenDone('config-approval', ['approve', 'redraft'], responses)
    const { manifest, completion } = startFlight(
      { ...args('/repo/opt-out'), opts: { ...OPTS, autopilot: false } },
      deps(adapters),
    )
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('waiting-for-approval')
    expect(responses).toEqual([])
  })

  it('R78: a step the user explicitly re-entered parks its FIRST checkpoint even under autopilot', async () => {
    const responses: unknown[] = []
    const adapters = allDone()
    adapters.docs = parkThenDone('prd-source', ['continue', 'collect-repo-docs'], responses)
    // First pass: autopilot answers prd-source and the flight completes.
    const { manifest, completion } = startFlight(args('/repo/re-entry'), deps(adapters))
    await completion
    expect(responses).toEqual([{ choice: 'continue' }])

    // The user picks Continue → from a step → Requirements: same autopilot
    // setting, but this checkpoint is theirs to answer.
    const redone = redoFlight(manifest.flightId, { ...deps(adapters), validateStageEntry: () => null }, { fromStage: 'docs' })
    await redone.completion
    const parked = store.get(manifest.flightId)!
    expect(parked.status).toBe('waiting-for-approval')
    expect(parked.stages.find((s) => s.key === 'docs')!.status).toBe('waiting-for-approval')
    expect(responses).toEqual([{ choice: 'continue' }]) // no second auto-answer
    // Protection is spent — the flag is gone once the user has been asked.
    expect(parked.askAtStage).toBeUndefined()

    // Answering it releases the flight; later checkpoints autopilot normally.
    const released = respondToFlightCheckpoint(manifest.flightId, { choice: 'continue' }, deps(adapters))
    await released.completion
    expect(store.get(manifest.flightId)!.status).toBe('done')
  })

  it('R78: setFlightAutopilot flips the preference on an existing flight, and the next checkpoint honours it', async () => {
    const responses: unknown[] = []
    const adapters = allDone()
    adapters.docs = parkThenDone('config-approval', ['approve', 'redraft'], responses)
    const { manifest, completion } = startFlight(
      { ...args('/repo/toggle'), opts: { ...OPTS, autopilot: false } },
      deps(adapters),
    )
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('waiting-for-approval')

    const flipped = setFlightAutopilot(manifest.flightId, true, deps(adapters))
    expect(flipped.opts.autopilot).toBe(true)
    // The parked checkpoint is deliberately NOT auto-answered under the user.
    expect(responses).toEqual([])
    // Releasing it by hand lets the drive continue; the next stage's checkpoint
    // now auto-answers because the flight reads the flipped preference.
    const released = respondToFlightCheckpoint(manifest.flightId, { choice: 'approve' }, deps(adapters))
    await released.completion
    expect(store.get(manifest.flightId)!.status).toBe('done')
  })

  it('yolo flights are exempt — a checkpoint an adapter parks under yolo reaches the human', async () => {
    const adapters = allDone()
    adapters.docs = {
      run: async () => ({
        kind: 'checkpoint',
        checkpoint: { kind: 'config-approval', message: 'q?', options: ['approve', 'redraft'] },
      }),
    }
    const { manifest, completion } = startFlight(
      { ...args('/repo/yolo'), opts: { ...OPTS, yolo: true } },
      deps(adapters),
    )
    await completion
    expect(store.get(manifest.flightId)!.status).toBe('waiting-for-approval')
  })

  it('a RE-parked checkpoint reaches the human — never auto-answered twice', async () => {
    const responses: unknown[] = []
    const adapters = allDone()
    adapters.docs = {
      run: async () => ({
        kind: 'checkpoint',
        checkpoint: { kind: 'config-approval', message: 'q?', options: ['approve', 'redraft'] },
      }),
      // The approve failed (config parse error) — same checkpoint re-parks.
      onCheckpointResponse: async (_ctx, response) => {
        responses.push(response)
        return {
          kind: 'checkpoint',
          checkpoint: { kind: 'config-approval', message: 'parse error — fix and approve', options: ['approve', 'redraft'], data: { error: 'bad cjs' } },
        }
      },
    }
    const { manifest, completion } = startFlight(args('/repo/re-park'), deps(adapters))
    await completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('waiting-for-approval')
    expect(responses).toEqual([{ choice: 'approve' }])
    const log = final.stages.find((s) => s.key === 'docs')!.log ?? ''
    expect(log.match(/\[autopilot@/g)?.length).toBe(1)
    expect(final.stages.find((s) => s.key === 'docs')!.checkpoint?.message).toContain('parse error')
  })
})

describe('live stage context', () => {
  it('setAgentActivity lands on the running stage and the last report wins', async () => {
    // The counterpart to the inert contexts interrupt/reset get: during a real
    // drive this call must reach the record, because it is the ONLY thing that
    // distinguishes a long-thinking agent from a hung one in the stage panel
    // (a stage gains a transcript row only per completed block — 3cde98f).
    const adapters = allDone()
    adapters.scout = {
      run: async (ctx) => {
        ctx.setAgentActivity({ phase: 'requesting', thinkingTokens: 0, chars: 0, tail: '' })
        ctx.setAgentActivity({ phase: 'writing', thinkingTokens: 240, chars: 11, tail: 'scouting...' })
        return { kind: 'done' }
      },
    }
    const started = startFlight(args(), deps(adapters))
    await started.completion

    const scout = store.get(started.manifest.flightId)!.stages.find((s) => s.key === 'scout')!
    expect(scout.agentActivity).toEqual({ phase: 'writing', thinkingTokens: 240, chars: 11, tail: 'scouting...' })
  })
})

describe('flight agent stickiness (R79: once codex, always codex)', () => {
  const withAgent = (agent: 'claude' | 'codex' | undefined): FlightOptions =>
    ({ ...OPTS, ...(agent ? { agent } : {}) })

  it('jump keeps the stored agent even when the caller passes a different one', async () => {
    const d: FlightConductorDeps = { ...deps(allDone()), validateStageEntry: () => null }
    const first = startFlight({ ...args(), opts: withAgent('codex') }, d)
    await first.completion

    const jumped = startFlight({ ...args(), opts: withAgent('claude'), mode: 'jump' as const, fromStage: 'docs' as const }, d)
    await jumped.completion
    expect(store.get(jumped.manifest.flightId)!.opts.agent).toBe('codex')
  })

  it('redo accepts a new agent; omitting it keeps the stored one', async () => {
    const d = deps(allDone())
    const first = startFlight({ ...args(), opts: withAgent('codex') }, d)
    await first.completion

    const kept = startFlight({ ...args(), opts: withAgent(undefined), mode: 'redo' as const }, d)
    await kept.completion
    expect(store.get(kept.manifest.flightId)!.opts.agent).toBe('codex')

    const changed = startFlight({ ...args(), opts: withAgent('claude'), mode: 'redo' as const }, d)
    await changed.completion
    expect(store.get(changed.manifest.flightId)!.opts.agent).toBe('claude')
  })
})
