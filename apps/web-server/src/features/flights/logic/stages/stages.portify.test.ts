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
    ctx: {
      manifest: () => state.m,
      flightDir: path.join(logsDir, 'flights', state.m.flightId),
      signal: new AbortController().signal,
      appendLog: () => {},
      setProgress: (progress) => { progressLog.push(progress) },
      patchFlight: (patch) => {
        state.m = {
          ...state.m,
          ...patch,
          links: patch.links ? { ...state.m.links, ...patch.links } : state.m.links,
        }
      },
    },
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

  it('skips only when the portified mark already exists', async () => {
    markPortified()
    const outcome = await portifyStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('already portified') })
  })

  it('zero-edit fast path: saves without a checkpoint and verifies the mark', async () => {
    let status = 'verifying'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') { status = 'ready-to-save'; return { statusCode: 201, body: { workflowId: 'wf1' } } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '' } }
      if (call.url.endsWith('/save')) { status = 'saved'; markPortified(); return { statusCode: 200, body: {} } }
      return undefined
    })
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))
    expect(outcome).toMatchObject({ kind: 'done', evidence: { workflowId: 'wf1', edits: false } })
  })

  it('proposed edits park on portify-apply; apply saves and verifies', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '--- a/server.js\n+++ b/server.js' } }
      if (call.url.endsWith('/save')) { status = 'saved'; markPortified(); return { statusCode: 200, body: {} } }
      return undefined
    })
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const parked = await runPastGate(adapter, ctxObj)
    expect(parked).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-apply' } })
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'apply' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { edits: true } })
  })

  it('pins the workflowId as live progress at start — the drill-through works before the stage settles', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status: 'ready-to-save', diff: '--- a/server.js' } }
      return undefined
    })
    const ctxObj = ctxFor(manifest()); const { ctx, progressLog } = ctxObj
    const parked = await runPastGate(portifyStage(deps({ inject })), ctxObj)
    // Parked un-settled (no evidence yet) — progress already carries the id.
    expect(parked).toMatchObject({ kind: 'checkpoint' })
    expect(progressLog).toContainEqual({ workflowId: 'wf1' })
  })

  it('mirrors the workflow phase (status/attempt) into progress as it polls', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status: 'ready-to-save', attempt: 1, maxAttempts: 3, diff: '--- a/server.js' } }
      return undefined
    })
    const ctxObj = ctxFor(manifest()); const { ctx, progressLog } = ctxObj
    await runPastGate(portifyStage(deps({ inject })), ctxObj)
    // The flight view's attempt stepper + phase verb read this mirror; it is
    // republished only when the phase changes (one poll here → one publish).
    expect(progressLog).toContainEqual({ workflowId: 'wf1', status: 'ready-to-save', attempt: 1, maxAttempts: 3 })
    expect(progressLog.filter((p) => (p as { status?: string }).status === 'ready-to-save')).toHaveLength(1)
  })

  it('fails when the portify start request is rejected', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 400, body: { error: 'no repos' } }
      return undefined
    })
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('portify start rejected') })
  })

  it('fails with "unknown" when the start rejection carries no error field', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 500, body: {} }
      return undefined
    })
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('unknown') })
  })

  it('settles directly via saveAndVerify when the workflow is already saved on first poll', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status: 'saved', diff: '--- a/x\n+++ b/x' } }
      if (call.url.endsWith('/save')) { markPortified(); return { statusCode: 200, body: {} } }
      return undefined
    })
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))
    expect(outcome).toMatchObject({ kind: 'done', evidence: { workflowId: 'wf1', edits: true } })
  })

  it('fails when the workflow settles failed with a reason', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status: 'failed', error: 'agent crashed' } }
      return undefined
    })
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))
    expect(outcome).toMatchObject({ kind: 'failed', error: 'portify failed: agent crashed' })
  })

  it('fails when the workflow is aborted with no error message', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status: 'aborted' } }
      return undefined
    })
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))
    expect(outcome).toMatchObject({ kind: 'failed', error: 'portify aborted' })
  })

  it('fails when the save request itself is rejected — carrying the server\'s reason, not just the code', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status: 'ready-to-save', diff: '' } }
      if (call.url.endsWith('/save')) return { statusCode: 500, body: { error: 'disk full' } }
      return undefined
    })
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('portify save rejected') })
    // The WHY reaches the user — a bare "(409)" once hid "cannot save a
    // workflow in status \"aborted\"" after a restart orphaned the workflow.
    expect((outcome as { error?: string }).error).toContain('disk full')
  })

  it('yolo bypasses the gate and starts the workflow immediately', async () => {
    let status = 'verifying'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') { status = 'ready-to-save'; return { statusCode: 201, body: { workflowId: 'wf1' } } }
      if (call.method === 'GET' && call.url.startsWith('/api/portify/')) return { statusCode: 200, body: { status, diff: '' } }
      if (call.url.endsWith('/save')) { status = 'saved'; markPortified(); return { statusCode: 200, body: {} } }
      return undefined
    })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await portifyStage(deps({ inject })).run!(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { workflowId: 'wf1', edits: false } })
  })

  it('re-adopts a review parked across a server restart instead of starting a new workflow', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify') {
        return { statusCode: 200, body: [{ workflowId: 'wf9', feature: 'checkout', status: 'ready-to-save' }] }
      }
      if (call.method === 'GET' && call.url.startsWith('/api/portify/')) return { statusCode: 200, body: { status: 'ready-to-save', diff: '--- a/x' } }
      return undefined
    }, calls)
    const ctxObj = ctxFor(manifest()); const { ctx, progressLog } = ctxObj
    const parked = await runPastGate(portifyStage(deps({ inject })), ctxObj)
    expect(parked).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-apply', data: { workflowId: 'wf9' } } })
    // No new workflow was started; the drill-through pin points at the adopted one.
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/portify')).toBe(false)
    expect(progressLog).toContainEqual({ workflowId: 'wf9' })
  })

  it('settles the save-poll via a "failed" status (not just "saved") and still checks the overlay mark', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '' } }
      if (call.url.endsWith('/save')) { status = 'failed'; return { statusCode: 200, body: {} } }
      return undefined
    })
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))
    // The save-poll settling on "failed" still falls through to the harness's
    // own overlay-mark check (not the workflow's word for it) — no mark exists.
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('overlay mark is missing') })
  })

  it('settles the save-poll via an "aborted" status too and still checks the overlay mark', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '' } }
      if (call.url.endsWith('/save')) { status = 'aborted'; return { statusCode: 200, body: {} } }
      return undefined
    })
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('overlay mark is missing') })
  })

  it('fails when save succeeds but the overlay mark never lands', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '' } }
      if (call.url.endsWith('/save')) { status = 'saved'; return { statusCode: 200, body: {} } } // no markPortified()
      return undefined
    })
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(manifest()))
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('overlay mark is missing') })
  })

  it('yolo applies proposed edits without parking on the checkpoint', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '--- a/x\n+++ b/x' } }
      if (call.url.endsWith('/save')) { status = 'saved'; markPortified(); return { statusCode: 200, body: {} } }
      return undefined
    })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxFor(m))
    expect(outcome).toMatchObject({ kind: 'done', evidence: { edits: true } })
  })

  it('checkpoint response: cancel tolerates a rejected cancel-endpoint call (best-effort)', async () => {
    let status = 'ready-to-save'
    const inject: FlightInject = async (call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, json: () => ({ workflowId: 'wf1' }) }
      if (call.method === 'GET') return { statusCode: 200, json: () => ({ status, diff: '--- a/x\n+++ b/x' }) }
      if (call.url.endsWith('/cancel')) throw new Error('cancel endpoint exploded')
      return { statusCode: 500, json: () => ({ error: 'unstubbed' }) }
    }
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const parked = await runPastGate(adapter, ctxObj)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'cancel' })
    expect(outcome).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('not concurrency-ready') })
  })

  it('checkpoint response: cancel SKIPS the stage (flight proceeds without parallel readiness) and calls the cancel endpoint', async () => {
    const calls: InjectCall[] = []
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '--- a/x\n+++ b/x' } }
      if (call.url.endsWith('/cancel')) return { statusCode: 200, body: {} }
      return undefined
    }, calls)
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const parked = await runPastGate(adapter, ctxObj)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'cancel' })
    // Declining is a decision, not a failure — a failed stage was a dead end
    // (the only retry re-ran the same workflow the user just rejected). The
    // stage skips; the feature stays serial; the next flight retries portify.
    expect(outcome).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('not concurrency-ready') })
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(true)
  })

  it('checkpoint response: an unrecognized choice re-parks on the same checkpoint', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '--- a/x\n+++ b/x' } }
      return undefined
    })
    const adapter = portifyStage(deps({ inject }))
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    const parked = await runPastGate(adapter, ctxObj)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-apply' } })
  })

  it('checkpoint response with no stored workflowId re-runs from scratch', async () => {
    const adapter = portifyStage(deps())
    const ctxObj = ctxFor(manifest()); const { ctx, setStage } = ctxObj
    setStage('portify', {
      status: 'waiting-for-approval',
      checkpoint: { kind: 'portify-apply', message: 'x', options: ['apply', 'cancel'], data: {} },
    })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'apply' })
    // Falls through to run(), which re-parks the upfront gate — nothing to
    // save exists, so the decision starts over from the top.
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-gate' } })
  })
})
