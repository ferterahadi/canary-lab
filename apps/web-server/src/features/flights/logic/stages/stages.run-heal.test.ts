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

  it("forwards the flight's stored stage plan on the run start payload", async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0, services: [] } } }
      return undefined
    }, calls)
    const models = { heal: { model: 'opus', effort: 'high' as const }, commit: { model: 'haiku', effort: null } }
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, models } })
    const outcome = await runStage(deps({ inject })).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done' })
    const start = calls.find((c) => c.method === 'POST' && c.url === '/api/runs')
    expect(start?.payload).toMatchObject({ feature: 'checkout', models })
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
    const outcome = await runStage(deps({ inject })).run(ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })).ctx)
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
    expect(parked.checkpoint.message).toContain('failed after 4 repair cycles.')
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
    expect(clean).toMatchObject({ kind: 'skipped', reason: 'nothing needed repairing' })
  })

  it('heal skips when the flight has no run to mirror', async () => {
    const outcome = await healStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'no run to mirror' })
  })

  it('heal skips when healCycles is entirely absent from the manifest (not just zero)', async () => {
    const inject = makeInject(() => ({ statusCode: 200, body: { manifest: { status: 'passed', services: [] } } }))
    const withRun = manifest({ links: { runId: 'run-1' } })
    const outcome = await healStage(deps({ inject })).run(ctxFor(withRun).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'nothing needed repairing' })
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

  // The other half of "pause kills the run": Continue must then RE-RUN the
  // step. Re-attaching to the run our own pause aborted would replay that abort
  // as the verdict and park the user on the run-failed checkpoint instead.
  it('run() starts fresh when the linked run was ABORTED (Continue after a pause)', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-paused') {
        return { statusCode: 200, body: { manifest: { status: 'aborted', healCycles: 2, services: [] } } }
      }
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-new' } }
      if (call.method === 'GET' && call.url === '/api/runs/run-new') {
        return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0, services: [] } } }
      }
      return undefined
    })
    const { ctx, current } = ctxFor(manifest({ links: { runId: 'run-paused' } }))
    const outcome = await runStage(deps({ inject })).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-new', status: 'passed' } })
    expect(current().links?.runId).toBe('run-new')
  })

  describe('teardown (stop the linked run)', () => {
    // Pause stops the run just as abort does: while a run is healing an agent
    // is editing the user's repo, and a pause that left it writing was the one
    // promise the UI could not keep.
    it('aborts the linked run on a PAUSE, not only on an abort', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject((call) => {
        if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'healing', services: [] } } }
        if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
        return undefined
      }, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest({ links: { runId: 'run-1' } }))
      await adapter.teardown(ctx)!.stop('pause')
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/runs/run-1/abort')).toBe(true)
    })

    it('owns no job at all when the flight never linked a run', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject(() => undefined, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest())
      // Null, not a job that no-ops: there is nothing to name in the teardown log.
      expect(adapter.teardown(ctx)).toBeNull()
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
      await adapter.teardown(ctx)!.stop('abort')
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
      await adapter.teardown(ctx)!.stop('abort')
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
      await adapter.teardown(ctx)!.stop('abort')
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/runs/run-1/abort')).toBe(true)
    })
  })
})

describe('run — external producer (heal engagement hand-off)', () => {
  const externalManifest = (over: Partial<FlightManifest> = {}) =>
    manifest({
      opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' },
      currentStage: 'run',
      ...over,
    })

  const parkOf = (outcome: StageOutcome) => {
    expect(outcome.kind).toBe('checkpoint')
    const cp = (outcome as Extract<StageOutcome, { kind: 'checkpoint' }>).checkpoint
    return { kind: cp.kind, message: cp.message, data: (cp.data ?? {}) as Record<string, unknown> }
  }

  const externalPark = (runId = 'run-ext') => ({
    checkpoint: {
      kind: 'external-work' as const,
      message: 'x',
      data: { handOffId: 'live-id', context: { runId } },
    },
  })

  it('starts the run UNCLAIMED in external-heal mode and parks immediately — no verdict poll', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-ext' } }
      return undefined
    }, calls)
    const { ctx, current } = ctxFor(externalManifest({
      externalAgentSession: {
        clientKind: 'claude',
        sessionId: 'claude-session-1',
        conversationName: 'heal checkout',
      },
    }))
    const cp = parkOf(await runStage(deps({ inject })).run(ctx))
    expect(cp.kind).toBe('external-work')
    expect(cp.data.stage).toBe('run')
    expect(cp.data.context).toMatchObject({ runId: 'run-ext' })
    // The rendered hand-off template — the repair rule leads, the loop follows.
    expect(String(cp.data.prompt)).toMatch(/fix app\/service code, not tests/i)
    expect(String(cp.data.prompt)).toContain('claim_heal(runId: "run-ext"')
    // claimable:false — a synthetic flight claim would block the real client's.
    const start = calls.find((c) => c.method === 'POST' && c.url === '/api/runs')
    expect(start?.payload).toMatchObject({
      healAgent: {
        kind: 'external',
        sessionId: 'claude-session-1',
        clientKind: 'claude',
        conversationName: 'heal checkout',
        claimable: false,
      },
    })
    expect(current().links?.runId).toBe('run-ext')
    // Parked, not polled: the only calls are the start (plus none for wf status).
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0)
  })

  it('a submit while the run is still active re-parks the SAME engagement', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') return { statusCode: 200, body: { manifest: { status: 'healing', healCycles: 1 } } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest({ links: { runId: 'run-ext' } }))
    setStage('run', externalPark())
    const cp = parkOf(await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' }))
    expect(cp.kind).toBe('external-work')
    expect(String(cp.data.lastRejection)).toContain('still "healing"')
    expect(cp.data.handOffId).toBe('live-id')
  })

  it('a submit on a PASSED run settles with the manifest verdict and counts — never the client word', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') {
        return {
          statusCode: 200,
          body: {
            manifest: { status: 'passed', healCycles: 2 },
            summary: { complete: true, total: 3, passed: 3, passedNames: ['a', 'b', 'c'], failed: [] },
          },
        }
      }
      return undefined
    })
    const { ctx, setStage, current } = ctxFor(externalManifest({ links: { runId: 'run-ext' } }))
    setStage('run', externalPark())
    const outcome = await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-ext', status: 'passed', healCycles: 2 } })
    expect(current().runVerdict).toBe('passed')
  })

  it('a submit on a FAILED run parks the run-failed question (yolo settles as-is)', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') return { statusCode: 200, body: { manifest: { status: 'failed', healCycles: 3 } } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest({ links: { runId: 'run-ext' } }))
    setStage('run', externalPark())
    const failed = await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit', token: 'live-id' })
    expect(failed).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'run-failed' } })

    const yolo = ctxFor(externalManifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, stageProducer: 'external' }, links: { runId: 'run-ext' } }))
    yolo.setStage('run', externalPark())
    const asIs = await runStage(deps({ inject })).onCheckpointResponse!(yolo.ctx, { choice: 'submit', token: 'live-id' })
    expect(asIs).toMatchObject({ kind: 'done', evidence: { status: 'failed' } })
  })

  it('rerun after a failed external run re-enters the external posture', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') return { statusCode: 200, body: { manifest: { status: 'failed', healCycles: 1 } } }
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-ext-2' } }
      return undefined
    }, calls)
    const { ctx, setStage } = ctxFor(externalManifest({ links: { runId: 'run-ext' } }))
    setStage('run', { checkpoint: { kind: 'run-failed', message: 'q', options: ['rerun', 'export-as-is'] } })
    const cp = parkOf(await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'rerun' }))
    expect(cp.kind).toBe('external-work')
    expect((calls.find((c) => c.method === 'POST' && c.url === '/api/runs')?.payload as { healAgent?: unknown }).healAgent).toMatchObject({ claimable: false })
  })

  it('run-internally on an ACTIVE run aborts it and starts a fresh internal run', async () => {
    const calls: InjectCall[] = []
    let aborted = false
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') {
        return { statusCode: 200, body: { manifest: { status: aborted ? 'aborted' : 'healing', healCycles: 1 } } }
      }
      if (call.method === 'POST' && call.url === '/api/runs/run-ext/abort') { aborted = true; return { statusCode: 200, body: {} } }
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-int' } }
      if (call.method === 'GET' && call.url === '/api/runs/run-int') return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0 } } }
      return undefined
    }, calls)
    const { ctx, setStage } = ctxFor(externalManifest({ links: { runId: 'run-ext' } }))
    setStage('run', externalPark())
    const outcome = await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'run-internally' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-int', status: 'passed' } })
    expect(calls.some((c) => c.url === '/api/runs/run-ext/abort')).toBe(true)
    // The fresh start is INTERNAL — no healAgent body, workspace auto-heal applies.
    const start = calls.find((c) => c.method === 'POST' && c.url === '/api/runs')
    expect((start?.payload as { healAgent?: unknown }).healAgent).toBeUndefined()
  })

  it('run-internally on a TERMINAL failed run restarts heal locally via the handoff route', async () => {
    const calls: InjectCall[] = []
    let handed = false
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') {
        return { statusCode: 200, body: { manifest: { status: handed ? 'passed' : 'failed', healCycles: 2 } } }
      }
      if (call.method === 'POST' && call.url === '/api/runs/run-ext/heal-agent/handoff') { handed = true; return { statusCode: 202, body: { accepted: true, to: 'auto' } } }
      return undefined
    }, calls)
    const { ctx, setStage } = ctxFor(externalManifest({ links: { runId: 'run-ext' } }))
    setStage('run', externalPark())
    const outcome = await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'run-internally' })
    // Remaining-test mode on the SAME run — cheaper than a fresh suite.
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-ext', status: 'passed' } })
    expect(calls.find((c) => c.url.endsWith('/heal-agent/handoff'))?.payload).toMatchObject({ to: 'auto' })
  })

  it('run-internally falls back to a fresh internal run when the local handoff is unavailable', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') return { statusCode: 200, body: { manifest: { status: 'failed', healCycles: 2 } } }
      if (call.method === 'POST' && call.url === '/api/runs/run-ext/heal-agent/handoff') return { statusCode: 409, body: { reason: 'restart-local-heal-unavailable' } }
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-int' } }
      if (call.method === 'GET' && call.url === '/api/runs/run-int') return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0 } } }
      return undefined
    }, calls)
    const { ctx, setStage } = ctxFor(externalManifest({ links: { runId: 'run-ext' } }))
    setStage('run', externalPark())
    const outcome = await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'run-internally' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-int' } })
  })

  it('run-internally with no run yet just starts an internal run', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-int' } }
      if (call.method === 'GET' && call.url === '/api/runs/run-int') return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0 } } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('run', { checkpoint: { kind: 'external-work', message: 'x', data: { context: {} } } })
    expect(await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'run-internally' })).toMatchObject({
      kind: 'done',
      evidence: { runId: 'run-int' },
    })
  })

  it('discards a submit answering a superseded hand-off', async () => {
    const { ctx, setStage } = ctxFor(externalManifest({ links: { runId: 'run-ext' } }))
    setStage('run', externalPark())
    expect(await runStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', token: 'stale-id' })).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { data: { lastRejection: 'stale_submission', handOffId: 'live-id' } },
    })
  })

  it('fails a submit when the hand-off lost its run id everywhere', async () => {
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('run', { checkpoint: { kind: 'external-work', message: 'x', data: { context: {} } } })
    expect(await runStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit' })).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('lost its run id'),
    })
  })

  it('resume re-issues the hand-off for a still-active external run instead of polling it', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') return { statusCode: 200, body: { manifest: { status: 'healing', healCycles: 1 } } }
      return undefined
    })
    const { ctx } = ctxFor(externalManifest({ links: { runId: 'run-ext' } }))
    const cp = parkOf(await runStage(deps({ inject })).run(ctx))
    expect(cp.kind).toBe('external-work')
    expect(cp.data.context).toMatchObject({ runId: 'run-ext' })
  })

  it('resume settles straight from a run that reached its verdict while parked', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 1 } } }
      return undefined
    })
    const { ctx } = ctxFor(externalManifest({ links: { runId: 'run-ext' } }))
    expect(await runStage(deps({ inject })).run(ctx)).toMatchObject({ kind: 'done', evidence: { status: 'passed' } })
  })

  it('heal mirror reports an externally-healed run exactly like an internal one', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 2, healMode: 'external' } } }
      return undefined
    })
    const { ctx } = ctxFor(externalManifest({ links: { runId: 'run-ext' } }))
    expect(await healStage(deps({ inject })).run(ctx)).toMatchObject({
      kind: 'done',
      evidence: { runId: 'run-ext', healCycles: 2, healMode: 'external', finalStatus: 'passed' },
    })
  })
})

describe('run stage — re-attach and take-back arms', () => {
  it('run() re-attaches to a still-ACTIVE internal run and polls it to the verdict', async () => {
    let reads = 0
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-live') {
        reads += 1
        return { statusCode: 200, body: { manifest: { status: reads === 1 ? 'healing' : 'passed', healCycles: 1, services: [] } } }
      }
      return undefined
    })
    const outcome = await runStage(deps({ inject })).run(ctxFor(manifest({ links: { runId: 'run-live' } })).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-live', status: 'passed' } })
  })

  it('rerun with the previous run still ACTIVE re-attaches per producer (internal polls, external re-parks)', async () => {
    let reads = 0
    const internalInject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-live') {
        reads += 1
        return { statusCode: 200, body: { manifest: { status: reads === 1 ? 'running' : 'passed', healCycles: 0, services: [] } } }
      }
      return undefined
    })
    const internal = ctxFor(manifest({ links: { runId: 'run-live' } }))
    internal.setStage('run', { checkpoint: { kind: 'run-failed', message: 'q', options: ['rerun', 'export-as-is'] } })
    expect(await runStage(deps({ inject: internalInject })).onCheckpointResponse!(internal.ctx, { choice: 'rerun' })).toMatchObject({
      kind: 'done',
      evidence: { status: 'passed' },
    })

    const externalInject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-live') return { statusCode: 200, body: { manifest: { status: 'running', healCycles: 0, services: [] } } }
      return undefined
    })
    const external = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' }, links: { runId: 'run-live' } }))
    external.setStage('run', { checkpoint: { kind: 'run-failed', message: 'q', options: ['rerun', 'export-as-is'] } })
    const out = await runStage(deps({ inject: externalInject })).onCheckpointResponse!(external.ctx, { choice: 'rerun' })
    expect(out).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'external-work' } })
  })

  it('run-internally on an ABORTED terminal run hands heal to the local agent', async () => {
    let handed = false
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') {
        return { statusCode: 200, body: { manifest: { status: handed ? 'passed' : 'aborted', healCycles: 1, services: [] } } }
      }
      if (call.method === 'POST' && call.url === '/api/runs/run-ext/heal-agent/handoff') { handed = true; return { statusCode: 202, body: { accepted: true } } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' }, links: { runId: 'run-ext' } }))
    setStage('run', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { runId: 'run-ext' } } } })
    expect(await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'run-internally' })).toMatchObject({
      kind: 'done',
      evidence: { runId: 'run-ext', status: 'passed' },
    })
  })

  it('run-internally when the handed-off run has VANISHED just starts an internal run', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-gone') return { statusCode: 200, body: {} }
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-int' } }
      if (call.method === 'GET' && call.url === '/api/runs/run-int') return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0, services: [] } } }
      return undefined
    })
    const { ctx, setStage } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' }, links: { runId: 'run-gone' } }))
    setStage('run', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { runId: 'run-gone' } } } })
    expect(await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'run-internally' })).toMatchObject({
      kind: 'done',
      evidence: { runId: 'run-int' },
    })
  })

  it('a submit on a run with no manifest fails instead of guessing', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') return { statusCode: 200, body: {} }
      return undefined
    })
    const { ctx, setStage } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' }, links: { runId: 'run-ext' } }))
    setStage('run', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { runId: 'run-ext' } } } })
    expect(await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'submit' })).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('has no manifest'),
    })
  })

  it('run-internally survives a rejecting abort + poll (best-effort teardown, never a sink)', async () => {
    let reads = 0
    const inject: FlightInject = async (call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-ext') {
        reads += 1
        if (reads === 1) return { statusCode: 200, json: () => ({ manifest: { status: 'healing', healCycles: 1, services: [] } }) }
        // The post-abort poll read rejects — the .catch keeps the takeover going.
        throw new Error('poll read boom')
      }
      if (call.method === 'POST' && call.url === '/api/runs/run-ext/abort') throw new Error('abort boom')
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, json: () => ({ runId: 'run-int' }) }
      if (call.method === 'GET' && call.url === '/api/runs/run-int') return { statusCode: 200, json: () => ({ manifest: { status: 'passed', healCycles: 0, services: [] } }) }
      throw new Error(`unstubbed ${call.method} ${call.url}`)
    }
    const { ctx, setStage } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' }, links: { runId: 'run-ext' } }))
    setStage('run', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { runId: 'run-ext' } } } })
    expect(await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'run-internally' })).toMatchObject({
      kind: 'done',
      evidence: { runId: 'run-int' },
    })
  })
})
