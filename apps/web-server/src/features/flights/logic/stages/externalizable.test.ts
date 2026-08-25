import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FLIGHT_STAGE_KEYS, type FlightCheckpointKind, type FlightManifest, type FlightStageKey } from '../types'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { EXTERNAL_WORK_OPTIONS, externalizable } from './externalizable'
import { stageContextStub } from './__fixtures__/stage-context'

// The wrapper needs no repo and no agent spawn, but it DOES write the task prompt
// into the flight dir (so an oversized hand-off degrades to a path), so each test
// gets a real throwaway dir rather than writing under /tmp/flights.

let tmpDir: string

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-externalizable-')) })
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

function manifest(over: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'fl-x',
    feature: 'checkout',
    repoPaths: ['/repo/app'],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'running',
    currentStage: 'scout',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

/** A manifest whose `stageKey` step is parked on a checkpoint of `kind`. */
function parkedOn(stageKey: FlightStageKey, kind: FlightCheckpointKind, over: Partial<FlightManifest> = {}): FlightManifest {
  const base = manifest(over)
  return {
    ...base,
    stages: base.stages.map((s) => (s.key === stageKey ? { ...s, checkpoint: { kind, message: 'parked' } } : s)),
  }
}

function ctxFor(m: FlightManifest, flightDir?: string): { ctx: StageContext; logs: string[] } {
  const logs: string[] = []
  return {
    logs,
    ctx: stageContextStub({
      manifest: () => m,
      flightDir: flightDir ?? path.join(tmpDir, 'flights', 'fl-x'),
      appendLog: (chunk) => { logs.push(chunk) },
      patchFlight: () => {},
    }),
  }
}

/** Records which of the inner adapter's methods the wrapper reached. */
function innerAdapter(over: Partial<StageAdapter> = {}): { inner: StageAdapter; calls: string[] } {
  const calls: string[] = []
  const inner: StageAdapter = {
    run: async () => { calls.push('run'); return { kind: 'done', evidence: 'inner-ran' } },
    ...over,
  }
  return { inner, calls }
}

const spec = {
  handOff: () => ({ prompt: 'do the scout step' }),
  consume: async (_ctx: StageContext, result: unknown): Promise<StageOutcome> => ({ kind: 'done', evidence: result }),
}

describe('externalizable — choosing the executor', () => {
  it('runs the inner adapter when stageProducer is absent (the GUI-started default)', async () => {
    const { inner, calls } = innerAdapter()
    const { ctx } = ctxFor(manifest())
    expect(await externalizable('scout', inner, spec).run(ctx)).toEqual({ kind: 'done', evidence: 'inner-ran' })
    expect(calls).toEqual(['run'])
  })

  it('runs the inner adapter when stageProducer is explicitly internal', async () => {
    const { inner, calls } = innerAdapter()
    const { ctx } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'internal' } }))
    await externalizable('scout', inner, spec).run(ctx)
    expect(calls).toEqual(['run'])
  })

  it('parks on an external-work checkpoint carrying the prompt when stageProducer is external', async () => {
    const { inner, calls } = innerAdapter()
    const { ctx, logs } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    const outcome = await externalizable('scout', inner, spec).run(ctx)
    expect(calls).toEqual([])
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'external-work', options: [...EXTERNAL_WORK_OPTIONS], data: { stage: 'scout', prompt: 'do the scout step' } },
    })
    expect(logs.join('')).toContain('handed off to the external client')
  })

  it('omits the context key entirely when the spec supplies none', async () => {
    const { inner } = innerAdapter()
    const { ctx } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    const outcome = await externalizable('scout', inner, spec).run(ctx)
    const data = (outcome as { checkpoint: { data: Record<string, unknown> } }).checkpoint.data
    expect('context' in data).toBe(false)
  })

  // The MCP flight view drops checkpoint data over its inline budget, and for a
  // work hand-off the data IS the task — so the prompt is also spilled to disk and
  // the view can fall back to the path instead of "omitted, see the web UI".
  it('spills the prompt to a file in the flight dir and carries its path', async () => {
    const { inner } = innerAdapter()
    const { ctx } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    const outcome = await externalizable('scout', inner, spec).run(ctx)
    const data = (outcome as { checkpoint: { data: { promptPath: string } } }).checkpoint.data
    expect(data.promptPath).toBe(path.join(tmpDir, 'flights', 'fl-x', 'scout', 'external-task.md'))
    expect(fs.readFileSync(data.promptPath, 'utf8')).toBe('do the scout step')
  })

  it('still hands off when the prompt file cannot be written', async () => {
    // flightDir's parent is a FILE, so mkdirSync throws ENOTDIR. The inline prompt
    // must survive — only the oversized-payload fallback is lost.
    const blocker = path.join(tmpDir, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const { inner } = innerAdapter()
    const { ctx } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }), path.join(blocker, 'fl-x'))
    const outcome = await externalizable('scout', inner, spec).run(ctx)
    const data = (outcome as { checkpoint: { data: Record<string, unknown> } }).checkpoint.data
    expect(data.prompt).toBe('do the scout step')
    expect('promptPath' in data).toBe(false)
  })

  it('carries the spec context and message when supplied', async () => {
    const { inner } = innerAdapter()
    const { ctx } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    const adapter = externalizable('docs', inner, {
      ...spec,
      message: 'custom hand-off line',
      handOff: () => ({ prompt: 'p', context: { docs: ['a.md'] } }),
    })
    expect(await adapter.run(ctx)).toMatchObject({
      checkpoint: { message: 'custom hand-off line', data: { stage: 'docs', context: { docs: ['a.md'] } } },
    })
  })
})

describe('externalizable — releasing the checkpoint', () => {
  it('consumes the client result when the parked checkpoint is its own', async () => {
    const { inner, calls } = innerAdapter()
    const { ctx } = ctxFor(parkedOn('scout', 'external-work'))
    const outcome = await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, { choice: 'submit', data: { configSource: 'x' } })
    expect(outcome).toEqual({ kind: 'done', evidence: { configSource: 'x' } })
    expect(calls).toEqual([])
  })

  it('hands the step back to the local agent on run-internally', async () => {
    const { inner, calls } = innerAdapter()
    const { ctx, logs } = ctxFor(parkedOn('scout', 'external-work'))
    const outcome = await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, { choice: 'run-internally' })
    expect(outcome).toEqual({ kind: 'done', evidence: 'inner-ran' })
    expect(calls).toEqual(['run'])
    expect(logs.join('')).toContain('handed the step back')
  })

  // The regression this guards: scout owns a legacy config-approval responder. A
  // wrapper that claimed every response would swallow it and silently break the
  // release path for flights parked before the checkpoint moved to scaffold.
  it('delegates to the inner responder when the parked checkpoint belongs to the inner stage', async () => {
    const { inner, calls } = innerAdapter({
      onCheckpointResponse: async () => { calls.push('inner-response'); return { kind: 'done', evidence: 'inner-handled' } },
    })
    const { ctx } = ctxFor(parkedOn('scout', 'config-approval'))
    const outcome = await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, { choice: 'approve' })
    expect(outcome).toEqual({ kind: 'done', evidence: 'inner-handled' })
    expect(calls).toEqual(['inner-response'])
  })

  it('falls back to re-running the stage when the inner adapter has no responder', async () => {
    const { inner, calls } = innerAdapter()
    const { ctx } = ctxFor(parkedOn('scout', 'config-approval'))
    await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, { choice: 'approve' })
    expect(calls).toEqual(['run'])
  })

  it('re-runs the stage when nothing is parked at all', async () => {
    const { inner, calls } = innerAdapter()
    const { ctx } = ctxFor(manifest())
    await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, {})
    expect(calls).toEqual(['run'])
  })

  it('reads the checkpoint of ITS OWN stage, not whichever stage is parked', async () => {
    // docs is parked on external-work; the scout wrapper must not claim it.
    const { inner, calls } = innerAdapter()
    const { ctx } = ctxFor(parkedOn('docs', 'external-work'))
    await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, { choice: 'submit', data: 'nope' })
    expect(calls).toEqual(['run'])
  })
})

describe('externalizable — pass-through of teardown hooks', () => {
  it('forwards teardown and reset to the inner adapter', async () => {
    const calls: string[] = []
    const inner: StageAdapter = {
      run: async () => ({ kind: 'done' }),
      teardown: () => ({ id: 'inner-job', stop: async (reason) => { calls.push(`stop:${reason}`) } }),
      reset: async () => { calls.push('reset') },
    }
    const { ctx } = ctxFor(manifest())
    const adapter = externalizable('scout', inner, spec)
    await adapter.teardown(ctx)!.stop('pause')
    await adapter.reset!(ctx)
    expect(calls).toEqual(['stop:pause', 'reset'])
  })

  it('forwards the inner adapter\'s null when it owns nothing', () => {
    // A wrapped stage parked on its external hand-off owns no local work — but the
    // ANSWER still has to come from the inner adapter, not from the wrapper
    // assuming one. Whoever executes the step, the artifacts are the same.
    const inner: StageAdapter = { run: async () => ({ kind: 'done' }), teardown: () => null }
    const { ctx } = ctxFor(manifest())
    expect(externalizable('scout', inner, spec).teardown(ctx)).toBeNull()
  })

  it('leaves reset absent when the inner adapter has none, but never teardown', () => {
    const { inner } = innerAdapter()
    const adapter = externalizable('scout', inner, spec)
    // teardown is REQUIRED, so the wrapper always carries it — forgetting to
    // forward it is now a compile error rather than a stage that silently stops
    // stopping the moment it is wrapped.
    expect(typeof adapter.teardown).toBe('function')
    expect('reset' in adapter).toBe(false)
  })
})

describe('rejectStaleSubmit — a submit must answer the hand-off it was given', () => {
  /** A manifest parked on a real external-work hand-off, id and all. */
  function handedOff(id: string, extra: Record<string, unknown> = {}): FlightManifest {
    const base = manifest()
    return {
      ...base,
      status: 'waiting-for-approval',
      stages: base.stages.map((s) => (s.key === 'scout'
        ? {
            ...s,
            status: 'waiting-for-approval' as const,
            checkpoint: {
              kind: 'external-work' as const,
              message: 'do the scout step',
              options: [...EXTERNAL_WORK_OPTIONS],
              data: { stage: 'scout', prompt: 'do the scout step', handOffId: id, ...extra },
            },
          }
        : s)),
    }
  }

  it('mints an id on every hand-off so a submit can be matched to its ask', async () => {
    const { inner } = innerAdapter()
    const { ctx } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    const first = await externalizable('scout', inner, spec).run(ctx) as { checkpoint: { data: { handOffId: string } } }
    const second = await externalizable('scout', inner, spec).run(ctx) as { checkpoint: { data: { handOffId: string } } }
    expect(first.checkpoint.data.handOffId).toMatch(/^[0-9a-f]{8}$/)
    // Distinct per ask — otherwise a resumed step could not tell the two apart.
    expect(second.checkpoint.data.handOffId).not.toBe(first.checkpoint.data.handOffId)
  })

  it('consumes a submit carrying the matching id', async () => {
    const { inner } = innerAdapter()
    const { ctx } = ctxFor(handedOff('aaaaaaaa'))
    const outcome = await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, {
      choice: 'submit', data: { configSource: 'x' }, token: 'aaaaaaaa',
    })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { configSource: 'x' } })
  })

  it('DISCARDS a submit answering a superseded hand-off, and re-parks the current ask', async () => {
    const { inner } = innerAdapter()
    const { ctx, logs } = ctxFor(handedOff('bbbbbbbb'))
    const outcome = await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, {
      choice: 'submit', data: { configSource: 'stale work' }, token: 'aaaaaaaa',
    }) as { kind: string; checkpoint: { data: Record<string, unknown> } }

    expect(outcome.kind).toBe('checkpoint')
    // The stale result never reaches consume — that is the whole guarantee. Canary
    // validates files on disk, so a stale-but-valid submit would otherwise settle
    // the stage against an ask the user had already changed.
    expect(outcome.checkpoint.data).toMatchObject({ lastRejection: 'stale_submission' })
    // The id is NOT rotated: whoever holds this hand-off now must keep the token
    // they were given.
    expect(outcome.checkpoint.data.handOffId).toBe('bbbbbbbb')
    expect(logs.join('')).toContain('discarded a submit answering a superseded hand-off')
  })

  it('does not stack a second rejection marker when a stale submit repeats', async () => {
    const { inner } = innerAdapter()
    const { ctx } = ctxFor(handedOff('bbbbbbbb', { lastRejection: 'stale_submission' }))
    const outcome = await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, {
      choice: 'submit', token: 'wrong',
    }) as { checkpoint: { data: Record<string, unknown>; message: string } }
    expect(outcome.checkpoint.data.lastRejection).toBe('stale_submission')
    // The ask itself is untouched — the marker lives on data, not spliced into the
    // message, so it cannot accumulate prefixes.
    expect(outcome.checkpoint.message).toBe('do the scout step')
  })

  it('accepts a submit for a hand-off parked BEFORE this gate existed', async () => {
    // Compatibility window: a checkpoint already on disk carries no id. Refusing it
    // would strand a flight mid-hand-off across the upgrade — an unanswerable step
    // is worse than the race this closes.
    const { inner } = innerAdapter()
    const base = manifest()
    const legacy: FlightManifest = {
      ...base,
      stages: base.stages.map((s) => (s.key === 'scout'
        ? {
            ...s,
            checkpoint: {
              kind: 'external-work' as const,
              message: 'legacy',
              options: [...EXTERNAL_WORK_OPTIONS],
              data: { stage: 'scout', prompt: 'legacy' },
            },
          }
        : s)),
    }
    const { ctx } = ctxFor(legacy)
    const outcome = await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, {
      choice: 'submit', data: 'from before the upgrade',
    })
    expect(outcome).toMatchObject({ kind: 'done', evidence: 'from before the upgrade' })
  })

  it('ignores the token on any answer that is not a submit', async () => {
    // Only a submit carries a result that could settle the stage, so only a submit
    // needs matching. Gating other answers would break checkpoints that happen to
    // be parked on a stage which ALSO hands off.
    const { inner } = innerAdapter()
    const { ctx } = ctxFor(handedOff('bbbbbbbb'))
    const outcome = await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, {
      choice: 'approve', data: 'not a submit',
    })
    expect(outcome).toMatchObject({ kind: 'done', evidence: 'not a submit' })
  })

  it('never gates run-internally — a client must always be able to hand the step back', async () => {
    // Even a superseded client: "I cannot do this" stays valid whenever it arrives.
    const { inner, calls } = innerAdapter()
    const { ctx } = ctxFor(handedOff('bbbbbbbb'))
    await externalizable('scout', inner, spec).onCheckpointResponse!(ctx, {
      choice: 'run-internally', token: 'stale-or-absent',
    })
    expect(calls).toEqual(['run'])
  })
})
