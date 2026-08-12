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

import { envCaptureStage } from './env-capture'

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

describe('env-capture stage', () => {
  const bootInject = (calls: InjectCall[] = []): FlightInject =>
    makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET' && call.url.startsWith('/api/runs/boot-1')) {
        return { statusCode: 200, body: { manifest: { status: 'running', services: [{ name: 'app', status: 'ready' }] } } }
      }
      if (call.method === 'POST' && call.url === '/api/runs/boot-1/abort') return { statusCode: 204, body: {} }
      return undefined
    }, calls)

  function withScout(m: FlightManifest, envFiles: string[]): FlightManifest {
    return {
      ...m,
      stages: m.stages.map((s) => (s.key === 'scout' ? { ...s, status: 'done' as const, evidence: { configSource: 'x', envFiles } } : s)),
    }
  }

  it('captures detected env files then proves the config with a dry-run boot (and tears it down)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const envFile = path.join(repoDir, '.env')
    fs.writeFileSync(envFile, 'API_KEY=secret\n')
    const calls: InjectCall[] = []
    const outcome = await envCaptureStage(deps({ inject: bootInject(calls) })).run(ctxFor(withScout(manifest(), [envFile])).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { captured: 1, boot: { runId: 'boot-1' } } })
    expect(calls.some((c) => c.url === '/api/runs/boot-1/abort')).toBe(true)
  })

  it('pins the boot runId as live progress the moment the run exists', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const harness = ctxFor(withScout(manifest(), []))
    await envCaptureStage(deps({ inject: bootInject() })).run(harness.ctx)
    // Reachable by id from outside this stage — which is the point. Until it was
    // pinned, the boot run lived only in a local, so the only thing that could
    // ever stop it was this function's own `finally`.
    expect(harness.progressLog).toContainEqual({ runId: 'boot-1' })
  })

  it('pins the runId before the poll, so a boot that FAILS still leaves it reachable', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') {
        return { statusCode: 200, body: { manifest: { status: 'failed', services: [{ name: 'app', status: 'timeout' }] } } }
      }
      return { statusCode: 204, body: {} }
    })
    const harness = ctxFor(withScout(manifest(), []))
    const outcome = await envCaptureStage(deps({ inject })).run(harness.ctx)
    // Ordering is the contract: published on the way in, not on the way out, so
    // every failure arm inherits it.
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect(harness.progressLog).toContainEqual({ runId: 'boot-1' })
  })

  it('parks on missing-env when a detected env file does not exist (yolo does NOT skip this)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const missing = path.join(repoDir, '.env')
    const m = withScout(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } }), [missing])
    const outcome = await envCaptureStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'missing-env', data: { missing: [missing] } } })
  })

  it('materializes user-supplied values at the missing path, then captures and boots', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const missing = path.join(repoDir, '.env')
    const adapter = envCaptureStage(deps({ inject: bootInject() }))
    const { ctx, setStage } = ctxFor(withScout(manifest(), [missing]))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('env-capture', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { values: { API_KEY: 'abc' } })
    expect(outcome.kind).toBe('done')
    expect(fs.readFileSync(missing, 'utf-8')).toBe('API_KEY=abc\n')
  })

  it('fails the stage when the boot verify fails — verdict + structured errorDetail', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') {
        return {
          statusCode: 200,
          body: {
            manifest: {
              status: 'failed',
              services: [{ name: 'app', status: 'timeout' }],
              bootFailure: { service: 'app', safeName: 'app', reason: 'health-timeout', detail: 'x', logPath: '/tmp/app.log' },
            },
          },
        }
      }
      return { statusCode: 204, body: {} }
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('never passed its health check'),
      errorDetail: { service: 'app', reason: 'health-timeout', logPath: '/tmp/app.log' },
    })
  })

  it('a crashed service reads as a crash — and the stage error carries the service-log tail', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const logPath = path.join(tmpDir, 'svc-app.log')
    fs.writeFileSync(logPath, "Starting daemon\nUnrecognized VM option 'MaxPermSize=512m'\nError: Could not create the Java Virtual Machine.\n")
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') {
        return {
          statusCode: 200,
          body: {
            manifest: {
              status: 'failed',
              services: [{ name: 'app', status: 'timeout' }],
              bootFailure: { service: 'app', safeName: 'app', reason: 'process-exited', detail: 'x', logPath },
            },
          },
        }
      }
      return { statusCode: 204, body: {} }
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('crashed during boot'),
      errorDetail: {
        service: 'app',
        reason: 'process-exited',
        logPath,
        logTail: expect.stringContaining("Unrecognized VM option 'MaxPermSize=512m'"),
      },
    })
  })

  it('queues behind a repo collision and still boots', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') {
        const payload = call.payload as Record<string, unknown>
        if (payload.isolation === 'queue') return { statusCode: 201, body: { runId: 'boot-1' } }
        return { statusCode: 409, body: { type: 'repo_collision_requires_choice', conflictingFeature: 'other' } }
      }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'running', services: [] } } }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    }, calls)
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { boot: { runId: 'boot-1' } } })
    expect(calls.some((c) => (c.payload as Record<string, unknown>)?.isolation === 'queue')).toBe(true)
  })

  it('fails when the boot request itself is rejected', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 400, body: { error: 'bad request' } }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('boot request rejected') })
  })

  it('fails with "unknown" when the boot rejection carries no error field', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 400, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('unknown') })
  })

  it('boots cleanly when a queued run has not yet materialized any services', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    let polls = 0
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') {
        polls += 1
        // First poll: still queued with no services yet (must NOT settle).
        // Second poll: running with zero services (nothing to boot) — settles.
        return { statusCode: 200, body: { manifest: { status: polls === 1 ? 'queued' : 'running', services: [] } } }
      }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { boot: { runId: 'boot-1' } } })
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  it('keeps polling past a transient response with no manifest at all', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    let polls = 0
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') {
        polls += 1
        if (polls === 1) return { statusCode: 200, body: {} } // no manifest yet
        return { statusCode: 200, body: { manifest: { status: 'running', services: [] } } }
      }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done' })
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  it('a bootFailure with no logPath still yields the verdict, with empty log evidence', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') {
        return {
          statusCode: 200,
          body: {
            manifest: {
              status: 'failed',
              services: [{ name: 'app', status: 'timeout' }],
              bootFailure: { service: 'app', safeName: 'app', reason: 'health-timeout', detail: 'x' },
            },
          },
        }
      }
      return { statusCode: 204, body: {} }
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('never passed its health check'),
      errorDetail: { service: 'app', logPath: '', logTail: '' },
    })
  })

  it('boots cleanly when the feature has nothing to boot (remote-URL, zero services)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'running', services: [] } } }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { boot: { runId: 'boot-1' } } })
  })

  it('fails with a generic message when the run ends aborted with no bootFailure or timed-out service', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'aborted', services: [] } } }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('boot run boot-1 ended aborted') })
  })

  it('fails the stage when captureFeatureEnvFiles rejects (e.g. unknown feature)', async () => {
    // No createFeatureSkeleton call — "checkout" is not a known feature.
    const envFile = path.join(repoDir, '.env')
    fs.writeFileSync(envFile, 'API_KEY=secret\n')
    const outcome = await envCaptureStage(deps()).run(ctxFor(withScout(manifest(), [envFile])).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('feature not found') })
  })

  it('waive with none of the detected files present still settles done (zero captured)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const missing = path.join(repoDir, '.env')
    const adapter = envCaptureStage(deps({ inject: bootInject() }))
    const { ctx, setStage } = ctxFor(withScout(manifest(), [missing]))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('env-capture', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'waive' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { captured: 0 } })
  })

  it('fails with a health-check message when a service times out with no bootFailure detail', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'running', services: [{ name: 'app', status: 'timeout' }] } } }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('never passed its health check') })
  })

  it('tolerates a rejected abort call after boot verify settles (best-effort teardown)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject: FlightInject = async (call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, json: () => ({ runId: 'boot-1' }) }
      if (call.method === 'GET') return { statusCode: 200, json: () => ({ manifest: { status: 'running', services: [] } }) }
      if (call.url.endsWith('/abort')) throw new Error('abort endpoint exploded')
      return { statusCode: 500, json: () => ({ error: 'unstubbed' }) }
    }
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done' })
  })

  it('tolerates a manifest with no services field at all (not just an empty array)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'running' } } } // no services key
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { boot: { runId: 'boot-1', services: [] } } })
  })

  it('detectedFiles tolerates a flight with no scout evidence at all', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const outcome = await envCaptureStage(deps({ inject: bootInject() })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { captured: 0 } })
  })

  it('checkpoint response tolerates a stage with no checkpoint data at all', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const adapter = envCaptureStage(deps({ inject: bootInject() }))
    const { ctx } = ctxFor(withScout(manifest(), []))
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome).toMatchObject({ kind: 'done', evidence: { captured: 0 } })
  })

  it('checkpoint response with neither values nor waive re-runs from scratch', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const missing = path.join(repoDir, '.env')
    const adapter = envCaptureStage(deps())
    const { ctx, setStage } = ctxFor(withScout(manifest(), [missing]))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('env-capture', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'missing-env' } })
  })
})
