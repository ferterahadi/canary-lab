import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import fs from 'fs'
import { runGit } from '../../../../shared/git-repo'

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

  it('teardown cancels the workflow named by the progress pin', async () => {
    // The pin is written at START precisely so a pause landing during the long
    // editing phase can still reach the workflow.
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify/w-9') return { statusCode: 200, body: { status: 'editing' } }
      return { statusCode: 200, body: {} }
    }, calls)
    const m = manifest({
      stages: FLIGHT_STAGE_KEYS.map((key) => (key === 'portify'
        ? { key, status: 'running' as const, progress: { workflowId: 'w-9' } }
        : { key, status: 'pending' as const })),
    })
    await portifyStage(deps({ inject })).teardown(ctxFor(m).ctx)!.stop('pause')
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/portify/w-9/cancel')).toBe(true)
  })

  it('skips only when the portified mark already exists', async () => {
    markPortified()
    const outcome = await portifyStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('already done') })
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
    expect(outcome).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('you declined') })
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
    expect(outcome).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('you declined') })
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

  // Regression: an EXTERNAL portify pins `status:'editing'` and never advances
  // `attempt`, so the stage's liveness key froze for the whole hand-off and the
  // 30-minute IDLE budget abandoned clients that were still working. The key now
  // folds in a worktree fingerprint, and the file count reaches the UI.
  it('tracks a live external editing session from the worktree, not from status', async () => {
    // A real worktree with an uncommitted edit — the fingerprint reads THIS.
    const worktree = path.join(tmpDir, 'scratch-wt')
    fs.mkdirSync(worktree, { recursive: true })
    fs.writeFileSync(path.join(worktree, 'server.js'), 'const PORT = 3000\n')
    await runGit(worktree, ['init', '-q'])
    await runGit(worktree, ['config', 'user.email', 't@t'])
    await runGit(worktree, ['config', 'user.name', 'test'])
    await runGit(worktree, ['add', '-A'])
    await runGit(worktree, ['commit', '-q', '-m', 'init', '--no-verify'])
    fs.writeFileSync(path.join(worktree, 'server.js'), 'const PORT = process.env.PORT\n')

    let reads = 0
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf-ext' } }
      if (call.url === '/api/portify/wf-ext') {
        reads += 1
        // First read: the client is mid-edit. Second: it submitted and verified.
        return reads === 1
          ? { statusCode: 200, body: { status: 'editing', producer: 'external', attempt: 1, repos: [{ worktreePath: worktree }] } }
          : { statusCode: 200, body: { status: 'ready-to-save', producer: 'external', attempt: 1, diff: 'diff --git a/server.js b/server.js\n', verification: { ok: true } } }
      }
      return undefined
    })

    const ctxObj = ctxFor(manifest())
    const outcome = await runPastGate(portifyStage(deps({ inject })), ctxObj)
    // Parks for the human review, having followed the external edit window.
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-apply' } })

    // Canary COUNTED the edit itself rather than taking the client's word: this is
    // what both keeps the idle budget alive and gives the UI something to show.
    const edited = ctxObj.progressLog.find((p) => (p as { editedFiles?: number }).editedFiles !== undefined)
    expect(edited).toMatchObject({ workflowId: 'wf-ext', status: 'editing', editedFiles: 1 })
  })

  it('re-publishes on a moving fingerprint even when status and attempt are unchanged', async () => {
    // The exact case that used to starve: two consecutive polls both report
    // `editing`/attempt 1, so the phase key is identical — only the worktree moved.
    const worktree = path.join(tmpDir, 'scratch-wt2')
    fs.mkdirSync(worktree, { recursive: true })
    fs.writeFileSync(path.join(worktree, 'server.js'), 'const PORT = 3000\n')
    await runGit(worktree, ['init', '-q'])
    await runGit(worktree, ['config', 'user.email', 't@t'])
    await runGit(worktree, ['config', 'user.name', 'test'])
    await runGit(worktree, ['add', '-A'])
    await runGit(worktree, ['commit', '-q', '-m', 'init', '--no-verify'])

    let reads = 0
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf-move' } }
      if (call.url === '/api/portify/wf-move') {
        reads += 1
        if (reads === 1) {
          fs.writeFileSync(path.join(worktree, 'server.js'), 'const PORT = process.env.PORT\n')
          return { statusCode: 200, body: { status: 'editing', producer: 'external', attempt: 1, repos: [{ worktreePath: worktree }] } }
        }
        if (reads === 2) {
          // Same status AND same attempt — but the client touched another file.
          fs.writeFileSync(path.join(worktree, 'ports.js'), 'module.exports = {}\n')
          return { statusCode: 200, body: { status: 'editing', producer: 'external', attempt: 1, repos: [{ worktreePath: worktree }] } }
        }
        return { statusCode: 200, body: { status: 'ready-to-save', producer: 'external', attempt: 1, diff: 'd\n', verification: { ok: true } } }
      }
      return undefined
    })

    const ctxObj = ctxFor(manifest())
    await runPastGate(portifyStage(deps({ inject })), ctxObj)
    const counts = ctxObj.progressLog
      .map((p) => (p as { editedFiles?: number }).editedFiles)
      .filter((n): n is number => n !== undefined)
    // Two distinct publishes proving the key moved on evidence alone.
    expect(counts).toEqual([1, 2])
    // Three polls at the stage's 3s interval — past the default 5s test budget.
  }, 20_000)

  it('does not fingerprint an INTERNAL editing window — status/attempt already move there', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf-int' } }
      if (call.url === '/api/portify/wf-int') {
        return { statusCode: 200, body: { status: 'ready-to-save', attempt: 2, diff: 'd\n', verification: { ok: true } } }
      }
      return undefined
    })
    const ctxObj = ctxFor(manifest())
    await runPastGate(portifyStage(deps({ inject })), ctxObj)
    expect(ctxObj.progressLog.every((p) => (p as { editedFiles?: number }).editedFiles === undefined)).toBe(true)
  })

})

describe('portify — external producer', () => {
  beforeEach(() => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
  })

  const externalManifest = (over: Partial<FlightManifest> = {}) =>
    manifest({
      opts: { env: 'local', coverageTarget: 100, yolo: true, stageProducer: 'external' },
      currentStage: 'portify',
      ...over,
    })

  const markPortified = (): void => {
    const dir = path.join(featuresDir, 'checkout', 'portify')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, featureName: 'checkout', agent: 'claude', repos: [{ name: 'app' }], capturedAt: 'x' }))
  }

  const parkOf = (outcome: StageOutcome) => {
    expect(outcome.kind).toBe('checkpoint')
    const cp = (outcome as Extract<StageOutcome, { kind: 'checkpoint' }>).checkpoint
    return { kind: cp.kind, message: cp.message, data: (cp.data ?? {}) as Record<string, unknown> }
  }

  const externalPark = (workflowId = 'wf-1', over: Record<string, unknown> = {}) => ({
    checkpoint: {
      kind: 'external-work' as const,
      message: 'x',
      data: { handOffId: 'live-id', context: { workflowId }, ...over },
    },
  })

  it('yolo + external starts an EXTERNAL workflow and parks the whole engagement — no stage-side poll', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify') return { statusCode: 200, body: [] }
      if (call.method === 'POST' && call.url === '/api/portify') {
        return { statusCode: 201, body: { workflowId: 'wf-1', targets: [{ name: 'app', editPath: '/wt/app' }], configPath: '/cfg/feature.config.cjs', instructions: 'Port-ify the listeners.' } }
      }
      return undefined
    }, calls)
    const { ctx, progressLog } = ctxFor(externalManifest())
    const cp = parkOf(await portifyStage(deps({ inject })).run(ctx))
    expect(cp.kind).toBe('external-work')
    expect(cp.data.stage).toBe('portify')
    // The runner's own task instructions, workflowId + edit targets alongside.
    expect(cp.data.prompt).toBe('Port-ify the listeners.')
    expect(cp.data.context).toMatchObject({ workflowId: 'wf-1', configPath: '/cfg/feature.config.cjs' })
    expect(cp.message).toContain('Do NOT call save_portify')
    // Producer + flight identity rode the start request.
    const start = calls.find((c) => c.method === 'POST' && c.url === '/api/portify')
    expect(start?.payload).toMatchObject({ producer: 'external', sessionId: 'flight:fl-test' })
    // The id is pinned for drill-through/teardown, and nothing polled the workflow.
    expect(progressLog).toContainEqual({ workflowId: 'wf-1' })
    expect(calls.some((c) => c.method === 'GET' && c.url === '/api/portify/wf-1')).toBe(false)
  })

  it('the gate answered "run" under an external producer starts the external workflow', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') {
        // No instructions/targets/configPath — a degraded start still parks
        // (the workflowId is the load-bearing part; the client can get_portify).
        return { statusCode: 201, body: { workflowId: 'wf-1' } }
      }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    setStage('portify', { checkpoint: { kind: 'portify-gate', message: 'q', options: ['run', 'skip'] } })
    const cp = parkOf(await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'run' }))
    expect(cp.kind).toBe('external-work')
    expect(cp.data.prompt).toBe('')
    expect(cp.data.context).toEqual({ workflowId: 'wf-1' })
  })

  it('a submit while the workflow is still editing re-parks the SAME engagement with the live status', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify/wf-1') return { statusCode: 200, body: { status: 'editing', producer: 'external' } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('portify', externalPark())
    const cp = parkOf(await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' }))
    expect(cp.kind).toBe('external-work')
    expect(String(cp.data.lastRejection)).toContain('still "editing"')
    expect(cp.data.handOffId).toBe('live-id')
  })

  it('a submit at ready-to-save parks the portify-apply review (non-yolo)', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify/wf-1') return { statusCode: 200, body: { status: 'ready-to-save', diff: '+ port' } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    setStage('portify', externalPark())
    const outcome = await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' })
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-apply', data: { workflowId: 'wf-1', diff: '+ port' } } })
  })

  it('a submit at ready-to-save with zero edits saves and settles on the overlay mark (yolo saves too)', async () => {
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('portify', externalPark())
    // The consume's read sees ready-to-save with no diff; the save poll that
    // follows sees 'saved' — sequenced on call count.
    let reads = 0
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify/wf-1') {
        reads += 1
        return { statusCode: 200, body: reads === 1 ? { status: 'ready-to-save', diff: '' } : { status: 'saved' } }
      }
      if (call.method === 'POST' && call.url === '/api/portify/wf-1/save') { markPortified(); return { statusCode: 200, body: {} } }
      return undefined
    })
    const outcome = await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { workflowId: 'wf-1', edits: false } })
  })

  it('a workflow the client saved ITSELF settles on the overlay mark alone', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify/wf-1') return { statusCode: 200, body: { status: 'saved', diff: '+ port' } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('portify', externalPark())
    // No mark → the claim of "saved" does not pass.
    const missing = await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' })
    expect(missing).toMatchObject({ kind: 'failed', error: expect.stringContaining('overlay mark is missing') })
    markPortified()
    const { ctx: ctx2, setStage: setStage2 } = ctxFor(externalManifest())
    setStage2('portify', externalPark())
    const done = await portifyStage(deps({ inject })).onCheckpointResponse!(ctx2, { choice: 'submit', token: 'live-id' })
    expect(done).toMatchObject({ kind: 'done', evidence: { workflowId: 'wf-1', edits: true } })
  })

  it('a failed workflow fails the stage', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify/wf-1') return { statusCode: 200, body: { status: 'failed', error: 'boom' } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('portify', externalPark())
    expect(await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' })).toMatchObject({
      kind: 'failed',
      error: 'portify failed: boom',
    })
  })

  it('discards a submit answering a superseded hand-off', async () => {
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('portify', externalPark())
    expect(await portifyStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', token: 'stale-id' })).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { data: { lastRejection: 'stale_submission', handOffId: 'live-id' } },
    })
  })

  it('fails when the hand-off lost its workflow id', async () => {
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('portify', externalPark('wf-1', { context: {} }))
    expect(await portifyStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' })).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('lost its workflow id'),
    })
  })

  it('run-internally cancels the external workflow and runs the internal one', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify/wf-1/cancel') return { statusCode: 200, body: {} }
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf-2' } }
      if (call.method === 'GET' && call.url === '/api/portify/wf-2') return { statusCode: 200, body: { status: 'ready-to-save', diff: '+ p' } }
      return undefined
    }, calls)
    const { ctx, setStage } = ctxFor(externalManifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    setStage('portify', externalPark())
    const outcome = await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'run-internally' })
    // The internal workflow parks the normal review; the external one was cancelled
    // and the fresh start carried NO producer flag.
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-apply', data: { workflowId: 'wf-2' } } })
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/portify/wf-1/cancel')).toBe(true)
    const start = calls.find((c) => c.method === 'POST' && c.url === '/api/portify')
    expect((start?.payload as { producer?: string }).producer).toBeUndefined()
  })

  it('a revise on the review re-opens the EXTERNAL window and re-parks the engagement', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify/wf-1/revise') return { statusCode: 200, body: { instructions: 'Revised task — ports only.' } }
      return undefined
    }, calls)
    const { ctx, setStage } = ctxFor(externalManifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    setStage('portify', { checkpoint: { kind: 'portify-apply', message: 'save?', data: { workflowId: 'wf-1', diff: '+ p' } } })
    const cp = parkOf(await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'revise', feedback: 'use env-driven ports' }))
    expect(cp.kind).toBe('external-work')
    expect(cp.data.prompt).toBe('Revised task — ports only.')
    expect(cp.message).toContain('requested changes')
    // The route was asked for the EXTERNAL reopen, not the local revise agent.
    expect(calls.find((c) => c.url.endsWith('/revise'))?.payload).toMatchObject({ external: true, feedback: 'use env-driven ports' })
  })
  it('a rejected external start fails the stage with the server reason (or "unknown" without one)', async () => {
    const rejected = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify') return { statusCode: 200, body: [] }
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 500, body: { error: 'nope' } }
      return undefined
    })
    expect(await portifyStage(deps({ inject: rejected })).run(ctxFor(externalManifest()).ctx)).toMatchObject({
      kind: 'failed',
      error: 'portify start rejected (500): nope',
    })

    const idless = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify') return { statusCode: 200, body: [] }
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: {} }
      return undefined
    })
    expect(await portifyStage(deps({ inject: idless })).run(ctxFor(externalManifest()).ctx)).toMatchObject({
      kind: 'failed',
      error: 'portify start rejected (201): unknown',
    })
  })

  it('run-internally without a recorded workflow id skips the cancel and starts internally', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf-2' } }
      if (call.method === 'GET' && call.url === '/api/portify/wf-2') return { statusCode: 200, body: { status: 'ready-to-save', diff: '+ p' } }
      return undefined
    }, calls)
    const { ctx, setStage } = ctxFor(externalManifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    setStage('portify', externalPark('wf-1', { context: {} }))
    const outcome = await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'run-internally' })
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-apply' } })
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false)
  })

  it('run-internally survives a rejecting cancel (best-effort, never a sink)', async () => {
    const inject: FlightInject = async (call) => {
      if (call.method === 'POST' && call.url === '/api/portify/wf-1/cancel') throw new Error('cancel boom')
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, json: () => ({ workflowId: 'wf-2' }) }
      if (call.method === 'GET' && call.url === '/api/portify/wf-2') return { statusCode: 200, json: () => ({ status: 'ready-to-save', diff: '+ p' }) }
      throw new Error(`unstubbed ${call.method} ${call.url}`)
    }
    const { ctx, setStage } = ctxFor(externalManifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    setStage('portify', externalPark())
    const outcome = await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'run-internally' })
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-apply' } })
  })

  it('a yolo submit at ready-to-save WITH edits saves without the zero-edit log', async () => {
    let reads = 0
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify/wf-1') {
        reads += 1
        return { statusCode: 200, body: reads === 1 ? { status: 'ready-to-save', diff: '+ port' } : { status: 'saved' } }
      }
      if (call.method === 'POST' && call.url === '/api/portify/wf-1/save') { markPortified(); return { statusCode: 200, body: {} } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('portify', externalPark())
    expect(await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' })).toMatchObject({
      kind: 'done',
      evidence: { workflowId: 'wf-1', edits: true },
    })
  })

  it('a client-saved workflow with NO diff settles as a zero-edit save', async () => {
    markPortified()
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify/wf-1') return { statusCode: 200, body: { status: 'saved' } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('portify', externalPark())
    expect(await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' })).toMatchObject({
      kind: 'done',
      evidence: { workflowId: 'wf-1', edits: false },
    })
  })

  it('an aborted workflow (no error detail) fails the stage plainly', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify/wf-1') return { statusCode: 200, body: { status: 'aborted' } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('portify', externalPark())
    expect(await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' })).toMatchObject({
      kind: 'failed',
      error: 'portify aborted',
    })
  })

  it('a submit before the workflow reports any status re-parks as "starting"', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/portify/wf-1') return { statusCode: 200, body: {} }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('portify', externalPark())
    const cp = parkOf(await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' }))
    expect(String(cp.data.lastRejection)).toContain('still "starting"')
  })

  it('a revise whose reopen returns no instructions re-parks with the feedback as the task', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify/wf-1/revise') return { statusCode: 200, body: {} }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }))
    setStage('portify', { checkpoint: { kind: 'portify-apply', message: 'save?', data: { workflowId: 'wf-1', diff: '+ p' } } })
    const cp = parkOf(await portifyStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'revise', feedback: 'use env ports' }))
    expect(cp.kind).toBe('external-work')
    expect(cp.data.prompt).toBe('use env ports')
  })
})

