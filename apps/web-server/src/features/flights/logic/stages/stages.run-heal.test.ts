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

import { runStage, healStage } from './run'

import type { FlightInject, FlightStageDeps } from './context'

import type { StageContext, StageOutcome } from '../conductor'

import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'

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

describe('run + heal stages', () => {
  const runInject = (finalStatus: string, healCycles = 0): FlightInject =>
    makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: finalStatus, healCycles, services: [] } } }
      return undefined
    })

  it('waits for the terminal verdict and records it on the flight', async () => {
    const { ctx, current } = ctxFor(manifest())
    const outcome = await runStage(deps({ inject: runInject('passed', 2) })).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-1', status: 'passed', healCycles: 2 } })
    expect(current().runVerdict).toBe('passed')
    expect(current().links?.runId).toBe('run-1')
  })

  // R82: the score rides in the evidence so the flight stage's one-sentence
  // state line can report the outcome. Read off the summary artifact the verdict
  // poll already fetched — NEVER derived, because a test missing from every
  // result list is not-run, and `total - failed` would count it as passed.
  it('carries the run score in its evidence, read off the summary', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-1' } }
      if (call.method === 'GET') {
        return {
          statusCode: 200,
          body: {
            manifest: { status: 'failed', healCycles: 1, services: [] },
            summary: { complete: true, total: 23, passed: 2, failed: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }] },
          },
        }
      }
      return undefined
    })
    const outcome = await runStage(deps({ inject })).run(ctxFor(manifest({ opts: { env: 'local', yolo: true } })).ctx)
    expect(outcome).toMatchObject({
      kind: 'done',
      evidence: { runId: 'run-1', status: 'failed', counts: { passed: 2, total: 23, failed: 4 } },
    })
  })

  it('omits the score entirely when the run has no summary', async () => {
    const outcome = await runStage(deps({ inject: runInject('passed', 0) })).run(ctxFor(manifest()).ctx)
    // No zeros — "0 of 0 failed" would read as a clean run that never ran.
    expect((outcome as { evidence?: Record<string, unknown> }).evidence).not.toHaveProperty('counts')
  })

  it('reports zero failures when a green summary carries no failed list at all', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-1' } }
      if (call.method === 'GET') {
        return {
          statusCode: 200,
          // A fully green run may omit `failed` rather than send `[]`.
          body: { manifest: { status: 'passed', healCycles: 0, services: [] }, summary: { complete: true, total: 8, passed: 8 } },
        }
      }
      return undefined
    })
    const outcome = await runStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { counts: { passed: 8, total: 8, failed: 0 } } })
  })

  it('a non-green run parks on run-failed; export-as-is settles with status preserved', async () => {
    const adapter = runStage(deps({ inject: runInject('failed', 3) }))
    const { ctx, setStage, current } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    expect(parked).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'run-failed', options: ['rerun', 'export-as-is'] } })
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    expect(current().runVerdict).toBe('failed')
    setStage('run', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'export-as-is' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { status: 'failed' } })
  })

  it('states the give-up reason in the run-failed prompt when auto-heal explains itself', async () => {
    // `healEnd.message` is why auto-heal stopped; the decision footer has to
    // read it out of the checkpoint rather than fetching the run again.
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-1' } }
      if (call.method === 'GET') {
        return {
          statusCode: 200,
          body: { manifest: { status: 'failed', healCycles: 4, services: [], healEnd: { reason: 'max-cycles', message: 'Gave up after 4 cycles — the same test kept failing.' } } },
        }
      }
      return undefined
    })

    const parked = await runStage(deps({ inject })).run(ctxFor(manifest()).ctx)

    if (parked.kind !== 'checkpoint') throw new Error('expected run-failed checkpoint')
    expect(parked.checkpoint.message).toContain('Gave up after 4 cycles — the same test kept failing.')
    expect(parked.checkpoint.message).toContain('ended failed after 4 heal cycle(s).')
  })

  it('yolo exports a failed run as-is without parking', async () => {
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await runStage(deps({ inject: runInject('failed', 1) })).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { status: 'failed' } })
  })

  it('heal mirrors the run: done with cycles, skipped without', async () => {
    const withRun = manifest({ links: { runId: 'run-1' } })
    const healed = await healStage(deps({ inject: runInject('passed', 2) })).run(ctxFor(withRun).ctx)
    expect(healed).toMatchObject({ kind: 'done', evidence: { healCycles: 2 } })
    const clean = await healStage(deps({ inject: runInject('passed', 0) })).run(ctxFor(withRun).ctx)
    expect(clean).toMatchObject({ kind: 'skipped', reason: 'run needed no heal' })
  })

  it('heal skips when the flight has no run to mirror', async () => {
    const outcome = await healStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'no run to mirror' })
  })

  it('heal skips when healCycles is entirely absent from the manifest (not just zero)', async () => {
    const inject = makeInject(() => ({ statusCode: 200, body: { manifest: { status: 'passed', services: [] } } }))
    const withRun = manifest({ links: { runId: 'run-1' } })
    const outcome = await healStage(deps({ inject })).run(ctxFor(withRun).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'run needed no heal' })
  })

  it('heal skips when the linked run has no manifest', async () => {
    const inject = makeInject(() => ({ statusCode: 200, body: {} }))
    const withRun = manifest({ links: { runId: 'run-1' } })
    const outcome = await healStage(deps({ inject })).run(ctxFor(withRun).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'run run-1 has no manifest' })
  })

  it('queues behind a repo collision and still starts the run', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') {
        const payload = call.payload as Record<string, unknown>
        if (payload.isolation === 'queue') return { statusCode: 201, body: { runId: 'run-1' } }
        return { statusCode: 409, body: { type: 'repo_collision_requires_choice', conflictingFeature: 'other' } }
      }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0, services: [] } } }
      return undefined
    }, calls)
    const outcome = await runStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-1', status: 'passed' } })
    expect(calls.some((c) => (c.payload as Record<string, unknown>)?.isolation === 'queue')).toBe(true)
  })

  it('fails when the run start request is rejected', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 400, body: { error: 'bad feature' } }
      return undefined
    })
    const outcome = await runStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('run start rejected') })
  })

  it('fails with "unknown" when the run start rejection carries no error field', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 400, body: {} }
      return undefined
    })
    const outcome = await runStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('unknown') })
  })

  it('checkpoint response: rerun actually restarts the run', async () => {
    const adapter = runStage(deps({ inject: runInject('failed', 1) }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('run', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'rerun' })
    // Same stubbed inject always ends "failed" — rerun parks again (proves it re-entered startAndWait).
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'run-failed' } })
  })

  it('checkpoint response: an unrecognized choice re-parks on the same checkpoint', async () => {
    const adapter = runStage(deps({ inject: runInject('failed', 1) }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('run', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'run-failed' } })
  })

  it('run() re-attaches to an already-linked runId instead of starting a new run (resume after restart)', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-existing') {
        return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 1, services: [] } } }
      }
      return undefined // a POST /api/runs here would mean it double-started
    }, calls)
    const m = manifest({ links: { runId: 'run-existing' } })
    const outcome = await runStage(deps({ inject })).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-existing', status: 'passed', healCycles: 1 } })
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('run() falls through to starting fresh when the previously-linked run no longer exists', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-vanished') return { statusCode: 200, body: {} } // no manifest
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-new' } }
      if (call.method === 'GET' && call.url === '/api/runs/run-new') {
        return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0, services: [] } } }
      }
      return undefined
    })
    const m = manifest({ links: { runId: 'run-vanished' } })
    const { ctx, current } = ctxFor(m)
    const outcome = await runStage(deps({ inject })).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-new', status: 'passed' } })
    expect(current().links?.runId).toBe('run-new')
  })

  describe('interrupt (abort hook)', () => {
    it('does nothing on a non-abort interrupt (pause keeps the run alive)', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject(() => undefined, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest({ links: { runId: 'run-1' } }))
      await adapter.interrupt!(ctx, 'pause')
      expect(calls).toHaveLength(0)
    })

    it('does nothing on abort when the flight never linked a run', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject(() => undefined, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest())
      await adapter.interrupt!(ctx, 'abort')
      expect(calls).toHaveLength(0)
    })

    it('does nothing on abort when the linked run has already vanished', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject((call) => {
        if (call.method === 'GET') return { statusCode: 200, body: {} } // no manifest
        return undefined
      }, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest({ links: { runId: 'run-1' } }))
      await adapter.interrupt!(ctx, 'abort')
      expect(calls.some((c) => c.url.endsWith('/abort'))).toBe(false)
    })

    it('does nothing on abort when the linked run is already terminal', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject((call) => {
        if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'passed', services: [] } } }
        return undefined
      }, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest({ links: { runId: 'run-1' } }))
      await adapter.interrupt!(ctx, 'abort')
      expect(calls.some((c) => c.url.endsWith('/abort'))).toBe(false)
    })

    it('aborts the linked run when it is still active', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject((call) => {
        if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'running', services: [] } } }
        if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
        return undefined
      }, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest({ links: { runId: 'run-1' } }))
      await adapter.interrupt!(ctx, 'abort')
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/runs/run-1/abort')).toBe(true)
    })
  })
})
