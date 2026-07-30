import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FLIGHT_STAGE_KEYS, type FlightCheckpointKind, type FlightManifest, type FlightStageKey } from '../types'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { EXTERNAL_WORK_OPTIONS, externalizable } from './externalizable'

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
    ctx: {
      manifest: () => m,
      flightDir: flightDir ?? path.join(tmpDir, 'flights', 'fl-x'),
      signal: new AbortController().signal,
      appendLog: (chunk) => { logs.push(chunk) },
      setProgress: () => {},
      patchFlight: () => {},
    },
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
  it('forwards interrupt and reset to the inner adapter', async () => {
    const calls: string[] = []
    const inner: StageAdapter = {
      run: async () => ({ kind: 'done' }),
      interrupt: async (_ctx, kind) => { calls.push(`interrupt:${kind}`) },
      reset: async () => { calls.push('reset') },
    }
    const { ctx } = ctxFor(manifest())
    const adapter = externalizable('scout', inner, spec)
    await adapter.interrupt!(ctx, 'pause')
    await adapter.reset!(ctx)
    expect(calls).toEqual(['interrupt:pause', 'reset'])
  })

  it('leaves both hooks absent when the inner adapter has neither', () => {
    const { inner } = innerAdapter()
    const adapter = externalizable('scout', inner, spec)
    expect('interrupt' in adapter).toBe(false)
    expect('reset' in adapter).toBe(false)
  })
})
