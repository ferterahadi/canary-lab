import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

// Transparent pass-through by default — every other test in this file spawns
// real processes (fake npx/claude binaries on PATH). Only the one test below
// that needs to control child-process event ordering deterministically
// installs an override via setMockSpawn.
const { getMockSpawn, setMockSpawn } = vi.hoisted(() => {
  let impl: ((...args: unknown[]) => unknown) | null = null
  return {
    getMockSpawn: () => impl,
    setMockSpawn: (fn: ((...args: unknown[]) => unknown) | null) => { impl = fn },
  }
})

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      const impl = getMockSpawn()
      return impl ? impl(...args) : (actual.spawn as (...a: unknown[]) => unknown)(...args)
    },
  }
})

import { portifyStage } from './portify'

import type { FlightInject, FlightStageDeps } from './context'

import type { StageContext, StageOutcome } from '../conductor'

import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'

import { createFeatureSkeleton } from '../../../config/logic/feature-authoring'
import { stageContextStub } from './__fixtures__/stage-context'

let tmpDir: string

let featuresDir: string

let logsDir: string

let repoDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-stages-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  repoDir = path.join(tmpDir, 'product-repo')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(repoDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

type InjectCall = { method: string; url: string; payload?: unknown }

type InjectImpl = (call: InjectCall) => { statusCode: number; body: unknown } | undefined

function makeInject(impl: InjectImpl, calls: InjectCall[] = []): FlightInject {
  return async (opts) => {
    calls.push(opts)
    const out = impl(opts) ?? { statusCode: 500, body: { error: `unstubbed ${opts.method} ${opts.url}` } }
    return { statusCode: out.statusCode, json: () => out.body }
  }
}

function deps(over: Partial<FlightStageDeps> = {}): FlightStageDeps {
  return {
    featuresDir,
    logsDir,
    projectRoot: tmpDir,
    inject: makeInject(() => undefined),
    ...over,
  }
}

function manifest(over: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'fl-test',
    feature: 'checkout',
    repoPaths: [repoDir],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'running',
    currentStage: 'similarity',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function ctxFor(m: FlightManifest): { ctx: StageContext; current: () => FlightManifest; setStage: (key: FlightStageKey, patch: Partial<FlightStage>) => void; progressLog: unknown[] } {
  const state = { m }
  const progressLog: unknown[] = []
  const setStage = (key: FlightStageKey, patch: Partial<FlightStage>): void => {
    state.m = { ...state.m, stages: state.m.stages.map((s) => (s.key === key ? { ...s, ...patch } : s)) }
  }
  return {
    progressLog,
    ctx: stageContextStub({
      manifest: () => state.m,
      flightDir: path.join(logsDir, 'flights', state.m.flightId),
      setProgress: (progress) => { progressLog.push(progress) },
      patchFlight: (patch) => {
        state.m = {
          ...state.m,
          ...patch,
          links: patch.links ? { ...state.m.links, ...patch.links } : state.m.links,
        }
      },
    }),
    current: () => state.m,
    setStage,
  }
}

describe('portify stage', () => {
  beforeEach(() => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
  })

  function markPortified(): void {
    const dir = path.join(featuresDir, 'checkout', 'portify')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, featureName: 'checkout', agent: 'claude', repos: [{ name: 'app' }], capturedAt: 'x' }))
  }

  // Every non-yolo run() parks the upfront portify-gate first. Answer it
  // 'run' to reach the workflow flow a test actually exercises; non-gate
  // outcomes (already-portified skip, adopted review) pass through untouched.
  async function runPastGate(
    adapter: ReturnType<typeof portifyStage>,
    ctxObj: ReturnType<typeof ctxFor>,
  ): Promise<StageOutcome> {
    const gate = await adapter.run!(ctxObj.ctx)
    if (gate.kind !== 'checkpoint' || gate.checkpoint.kind !== 'portify-gate') return gate
    ctxObj.setStage('portify', { status: 'waiting-for-approval', checkpoint: gate.checkpoint })
    return adapter.onCheckpointResponse!(ctxObj.ctx, { choice: 'run' })
  }

  it('revise posts the feedback and re-parks the checkpoint with the NEW diff', async () => {
    let diff = 'old-diff'
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET' && call.url.startsWith('/api/portify/')) return { statusCode: 200, body: { status: 'ready-to-save', diff } }
      if (call.url.endsWith('/revise')) { diff = 'revised-diff'; return { statusCode: 200, body: {} } }
      return undefined
    }, calls)
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const parked = await runPastGate(adapter, ctxObj)
    expect(parked).toMatchObject({ kind: 'checkpoint', checkpoint: { options: ['apply', 'revise', 'cancel'] } })
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })

    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'revise', feedback: 'use env vars, not args' })
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'portify-apply', data: { workflowId: 'wf1', diff: 'revised-diff' } },
    })
    const revise = calls.find((c) => c.url.endsWith('/revise'))
    expect(revise?.payload).toEqual({ feedback: 'use env vars, not args' })
  })

  it('revise without feedback text re-parks asking for it — no revise request fires', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET' && call.url.startsWith('/api/portify/')) return { statusCode: 200, body: { status: 'ready-to-save', diff: '--- a/x' } }
      return undefined
    }, calls)
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const parked = await runPastGate(adapter, ctxObj)
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })

    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'revise' })
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { message: expect.stringContaining('needs feedback text') } })
    expect(calls.some((c) => c.url.endsWith('/revise'))).toBe(false)
  })

  it('a rejected revise (e.g. post-restart, worktree gone) re-parks with the reason — the verified diff stays saveable', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET' && call.url.startsWith('/api/portify/')) return { statusCode: 200, body: { status: 'ready-to-save', diff: '--- a/x' } }
      if (call.url.endsWith('/revise')) return { statusCode: 409, body: { error: 'worktree is no longer available — the server may have restarted; start a new workflow' } }
      return undefined
    })
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const parked = await runPastGate(adapter, ctxObj)
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })

    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'revise', feedback: 'tweak it' })
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { message: expect.stringContaining('Revise unavailable — worktree is no longer available') },
    })
  })

  it('a revise whose re-verify FAILED re-parks with the verdict up front (save is blocked server-side)', async () => {
    let revised = false
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET' && call.url.startsWith('/api/portify/')) {
        return revised
          ? { statusCode: 200, body: { status: 'ready-to-save', diff: '--- a/y', verification: { ok: false, failureDetail: 'port 3000 still bound\nstack...' } } }
          : { statusCode: 200, body: { status: 'ready-to-save', diff: '--- a/x' } }
      }
      if (call.url.endsWith('/revise')) { revised = true; return { statusCode: 200, body: {} } }
      return undefined
    })
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const parked = await runPastGate(adapter, ctxObj)
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })

    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'revise', feedback: 'bad idea' })
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { message: expect.stringContaining('FAILED the double-boot re-verify — port 3000 still bound') },
    })
  })

  it('reports a bare status code when the rejection body carries no reason', async () => {
    // Both a reasonless JSON body and a body that is not JSON at all must still
    // produce a clean message rather than "rejected (500): undefined".
    for (const body of [{}, 'not json at all']) {
      const inject = makeInject((call) => {
        if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
        if (call.method === 'GET') return { statusCode: 200, body: { status: 'ready-to-save', diff: '' } }
        if (call.url.endsWith('/save')) return { statusCode: 500, body }
        return undefined
      })
      const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))
      expect(outcome).toEqual({ kind: 'failed', error: 'portify save rejected (500)' })
    }
  })

  it('a rejected revise with no reason still re-parks on save-or-discard', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET' && call.url.startsWith('/api/portify/')) return { statusCode: 200, body: { status: 'ready-to-save', diff: '--- a/x' } }
      if (call.url.endsWith('/revise')) return { statusCode: 409, body: {} }
      return undefined
    })
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const parked = await runPastGate(adapter, ctxObj)
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })

    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'revise', feedback: 'tweak it' })

    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { message: expect.stringContaining('Revise unavailable. Save or discard.') },
    })
  })

  it('a failed re-verify with no failure detail still leads with the verdict', async () => {
    let revised = false
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET' && call.url.startsWith('/api/portify/')) {
        return revised
          ? { statusCode: 200, body: { status: 'ready-to-save', diff: '--- a/y', verification: { ok: false } } }
          : { statusCode: 200, body: { status: 'ready-to-save', diff: '--- a/x' } }
      }
      if (call.url.endsWith('/revise')) { revised = true; return { statusCode: 200, body: {} } }
      return undefined
    })
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const parked = await runPastGate(adapter, ctxObj)
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })

    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'revise', feedback: 'bad idea' })

    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { message: expect.stringContaining('FAILED the double-boot re-verify. Saving is blocked') },
    })
  })

  it('extends its deadline off the phase key while a workflow is still moving', async () => {
    // The wall-clock cap is idle time, not total: a workflow that keeps
    // changing status/attempt must stay alive (a 45m two-attempt portify was
    // once killed by a 30m fixed cap and orphaned mid-success).
    const phases = [
      {}, // just created — the route has not written a status yet
      { status: 'planning' },
      { status: 'verifying', attempt: 1, maxAttempts: 3 },
      { status: 'verifying', attempt: 1, maxAttempts: 3 }, // unchanged — must not re-publish
      { status: 'verifying', attempt: 2, maxAttempts: 3 },
      { status: 'ready-to-save', attempt: 2, maxAttempts: 3, diff: '' },
    ]
    let i = 0
    let saved = false
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.url.endsWith('/save')) { saved = true; markPortified(); return { statusCode: 200, body: {} } }
      // The parked-review scan hits the LIST endpoint — it must not consume a phase.
      if (call.method === 'GET' && call.url === '/api/portify') return { statusCode: 200, body: [] }
      if (call.method === 'GET' && call.url === '/api/portify/wf1') {
        if (saved) return { statusCode: 200, body: { status: 'saved' } }
        return { statusCode: 200, body: phases[Math.min(i++, phases.length - 1)] }
      }
      return undefined
    })
    const ctxObj = ctxFor(manifest())

    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxObj)

    expect(outcome).toMatchObject({ kind: 'done', evidence: { workflowId: 'wf1', edits: false } })
    // Each distinct phase was mirrored once, in order — that mirror IS the key.
    // The bare first entry is the stage pinning the workflowId so the flight
    // view can drill into the live workflow before any phase is known.
    expect(ctxObj.progressLog).toEqual([
      { workflowId: 'wf1' }, // the pin
      { workflowId: 'wf1' }, // the status-less first read mirrors the id alone
      { workflowId: 'wf1', status: 'planning' },
      { workflowId: 'wf1', status: 'verifying', attempt: 1, maxAttempts: 3 },
      { workflowId: 'wf1', status: 'verifying', attempt: 2, maxAttempts: 3 },
      { workflowId: 'wf1', status: 'ready-to-save', attempt: 2, maxAttempts: 3 },
    ])
  }, 30_000)

  it('reports a bare status code when the rejection body is not readable as JSON', async () => {
    // A proxy/HTML error page: `json()` throws rather than returning a shape,
    // and the stage still has to produce a usable message.
    const inject: FlightInject = async (opts) => {
      if (opts.method === 'POST' && opts.url === '/api/portify') {
        return { statusCode: 201, json: () => ({ workflowId: 'wf1' }) }
      }
      if (opts.url.endsWith('/save')) {
        return { statusCode: 502, json: () => { throw new SyntaxError('Unexpected token < in JSON') } }
      }
      if (opts.method === 'GET' && opts.url === '/api/portify') return { statusCode: 200, json: () => [] }
      return { statusCode: 200, json: () => ({ status: 'ready-to-save', diff: '' }) }
    }

    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))

    expect(outcome).toEqual({ kind: 'failed', error: 'portify save rejected (502)' })
  })

  it('a replayed "apply" on a DEAD workflow falls back to a fresh run instead of failing forever', async () => {
    // Resume replays the stored checkpointResponse; when the stored answer
    // targets a workflow a restart aborted (pre-capture records), the save can
    // never succeed — the stage must re-run, not re-fail on every resume.
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.url === '/api/portify/wf-dead/save') {
        return { statusCode: 409, body: { error: 'cannot save a workflow in status "aborted"' } }
      }
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf2' } }
      if (call.method === 'GET' && call.url.startsWith('/api/portify/')) return { statusCode: 200, body: { status: 'ready-to-save', diff: '--- a/x' } }
      return undefined
    }, calls)
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    setStage('portify', {
      status: 'waiting-for-approval',
      checkpoint: { kind: 'portify-apply', message: 'save?', options: ['apply', 'revise', 'cancel'], data: { workflowId: 'wf-dead', diff: 'd' } },
    })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'apply' })
    // The fresh run() re-parks the upfront gate (nothing has been started
    // yet); answering 'run' starts a NEW workflow that parks its own review.
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-gate' } })
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/portify')).toBe(false)
    if (outcome.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: outcome.checkpoint })
    const parked = await adapter.onCheckpointResponse!(ctx, { choice: 'run' })
    expect(parked).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-apply', data: { workflowId: 'wf2' } } })
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/portify')).toBe(true)
  })

  it('portify-gate: parks BEFORE any workflow cost; skip settles the stage serial with zero requests', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject(() => undefined, calls)
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const gate = await adapter.run!(ctx)
    expect(gate).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-gate', options: ['run', 'skip'] } })
    // Nothing was started to ask the question (the list probe for adoptable
    // reviews is the only allowed request).
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    if (gate.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: gate.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'skip' })
    expect(outcome).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('parallel readiness skipped') })
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('portify-gate: a stale replayed choice from an older park re-asks instead of acting', async () => {
    const adapter = portifyStage(deps({ inject: makeInject(() => undefined) }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const gate = await adapter.run!(ctx)
    if (gate.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: gate.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'apply' })
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-gate' } })
  })
})
