import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { robustnessStage, robustnessStageEvidence } from './robustness'
import type { FlightInject, FlightStageDeps } from './context'
import type { StageContext } from '../conductor'
import { FLIGHT_STAGE_KEYS, type FlightManifest } from '../types'
import type { RobustnessJobManifest } from '../../../../../../../shared/robustness/jobs'
import { ROBUSTNESS_ENVELOPE_FORMAT } from '../../../../../../../shared/robustness/types'
import { stageContextStub } from './__fixtures__/stage-context'

// The adapter is glue between the flight and the Robustness Lab route: it
// decides whether there is anything to perturb (a GREEN run, a suite with a
// declared port slot), starts one matrix, pins the job on the flight at START,
// and settles on the job record. Everything it reads comes through `inject`,
// so a scripted inject is the whole world here.

let tmpDir: string
let featuresDir: string
let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-robustness-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
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

function deps(inject: FlightInject): FlightStageDeps {
  return { featuresDir, logsDir, projectRoot: tmpDir, inject }
}

/** The suite under test: one repo whose start command declares a port slot
 *  (so the shim has something to front) unless `ports` says otherwise. */
function writeFeature(ports = "[{ name: 'api', env: 'PORT' }]"): void {
  const dir = path.join(featuresDir, 'checkout')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: {
       name: 'checkout', description: 'checkout flow', envs: ['local'], featureDir: __dirname,
       repos: [{ name: 'app', localPath: '/tmp/app', startCommands: [{ name: 'api', command: 'npm run dev', ports: ${ports} }] }],
     } }`,
  )
}

function manifest(links?: FlightManifest['links']): FlightManifest {
  return {
    flightId: 'fl-test',
    feature: 'checkout',
    repoPaths: ['/tmp/app'],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: true },
    status: 'running',
    currentStage: 'robustness',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...(links ? { links } : {}),
  }
}

function ctxFor(m: FlightManifest): { ctx: StageContext; current: () => FlightManifest; progress: unknown[]; log: string[] } {
  const state = { m }
  const progress: unknown[] = []
  const log: string[] = []
  return {
    progress,
    log,
    ctx: stageContextStub({
      manifest: () => state.m,
      flightDir: path.join(logsDir, 'flights', 'fl-test'),
      appendLog: (line) => { log.push(line) },
      setProgress: (p) => { progress.push(p) },
      patchFlight: (patch) => {
        state.m = { ...state.m, ...patch, links: patch.links ? { ...state.m.links, ...patch.links } : state.m.links }
      },
    }),
    current: () => state.m,
  }
}

function job(over: Partial<RobustnessJobManifest> = {}): RobustnessJobManifest {
  return {
    jobId: 'rj-1',
    feature: 'checkout',
    runId: 'run-1',
    envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 300 } },
    status: 'done',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:05:00Z',
    cells: { planned: 4, done: 4 },
    findings: [],
    skipped: [],
    log: 'matrix from run run-1: 2 spec files × 2 atoms (latency, duplicate) = 4 cells\n',
    ...over,
  }
}

const finding = (status: 'confirmed' | 'unconfirmed', test: string): RobustnessJobManifest['findings'][number] => ({
  cell: { specFile: 'e2e/a.spec.ts', atom: 'latency' },
  failedTests: [test],
  runId: 'cell-1',
  requirements: [],
  status,
  envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 300 } },
})

const passedRun = { statusCode: 200, body: { manifest: { status: 'passed', env: 'local' } } }

/** The route script for a start that settles on its first read. */
function labThatSettles(jobRecord: RobustnessJobManifest, calls: InjectCall[] = []): FlightInject {
  return makeInject((call) => {
    if (call.method === 'GET' && call.url === '/api/runs/run-1') return passedRun
    if (call.method === 'POST' && call.url === '/api/features/checkout/robustness') return { statusCode: 202, body: { jobId: jobRecord.jobId } }
    if (call.method === 'GET' && call.url === `/api/robustness/${jobRecord.jobId}`) return { statusCode: 200, body: jobRecord }
    return undefined
  }, calls)
}

describe('robustnessStageEvidence', () => {
  it('lists findings by status and never sums a pass count — a clean cell leaves no record', () => {
    const record = job({
      findings: [finding('confirmed', 'checkout'), finding('confirmed', 'browse'), finding('unconfirmed', 'admin')],
      skipped: [{ cell: { specFile: 'e2e/b.spec.ts', atom: 'duplicate' }, reason: 'no summary' }],
    })
    const evidence = robustnessStageEvidence(record)
    expect(evidence).toEqual({ jobId: 'rj-1', runId: 'run-1', cells: { planned: 4, done: 4 }, findings: 3, confirmed: 2, unconfirmed: 1, skipped: 1 })
    expect(JSON.stringify(evidence)).not.toMatch(/passed/)
  })
})

describe('robustness stage — what there is to perturb', () => {
  it('fails when the flight has no run to perturb', async () => {
    writeFeature()
    const outcome = await robustnessStage(deps(makeInject(() => undefined))).run(ctxFor(manifest()).ctx)
    expect(outcome).toEqual({ kind: 'failed', error: 'no run to perturb — Test run must settle first' })
  })

  it('fails when the linked run has no record any more', async () => {
    writeFeature()
    const inject = makeInject((call) => (call.url === '/api/runs/run-1' ? { statusCode: 404, body: { error: 'nope' } } : undefined))
    const outcome = await robustnessStage(deps(inject)).run(ctxFor(manifest({ runId: 'run-1' })).ctx)
    expect(outcome).toEqual({ kind: 'failed', error: 'run run-1 has no record — nothing to perturb' })
  })

  it('SKIPS — with the verdict as the reason — when the run did not pass: only green tests are perturbed', async () => {
    writeFeature()
    const calls: InjectCall[] = []
    const inject = makeInject((call) => (call.url === '/api/runs/run-1' ? { statusCode: 200, body: { manifest: { status: 'failed' } } } : undefined), calls)
    const outcome = await robustnessStage(deps(inject)).run(ctxFor(manifest({ runId: 'run-1' })).ctx)
    expect(outcome).toEqual({ kind: 'skipped', reason: 'the test run did not pass (failed) — only green tests are perturbed' })
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('SKIPS when no start command declares a port slot — nothing for the shim to front — and names the remedy', async () => {
    writeFeature('[]')
    const inject = makeInject((call) => (call.url === '/api/runs/run-1' ? passedRun : undefined))
    const outcome = await robustnessStage(deps(inject)).run(ctxFor(manifest({ runId: 'run-1' })).ctx)
    expect(outcome).toEqual({
      kind: 'skipped',
      reason: 'no service takes its port from settings, so nothing can be fronted by a proxy — run Parallel setup first',
    })
  })

  it('skips the same way when the suite config has vanished', async () => {
    const inject = makeInject((call) => (call.url === '/api/runs/run-1' ? passedRun : undefined))
    const outcome = await robustnessStage(deps(inject)).run(ctxFor(manifest({ runId: 'run-1' })).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped' })
  })
})

describe('robustness stage — running the matrix', () => {
  it('starts the matrix over the flight\'s run, pins the job on the flight at START, and settles done with the job\'s evidence', async () => {
    writeFeature()
    const calls: InjectCall[] = []
    const record = job({ findings: [finding('confirmed', 'checkout')] })
    const { ctx, current, log, progress } = ctxFor(manifest({ runId: 'run-1' }))
    const outcome = await robustnessStage(deps(labThatSettles(record, calls))).run(ctx)

    expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', url: '/api/features/checkout/robustness', payload: { runId: 'run-1' } })
    expect(current().links).toEqual({ runId: 'run-1', robustnessJobId: 'rj-1' })
    expect(log).toEqual(['[robustness] job rj-1 started over run run-1\n'])
    expect(outcome).toEqual({ kind: 'done', evidence: { jobId: 'rj-1', runId: 'run-1', cells: { planned: 4, done: 4 }, findings: 1, confirmed: 1, unconfirmed: 0, skipped: 0 } })
    // The settled read is published as progress too, so the rail's live line
    // and the settled evidence never disagree.
    expect(progress).toEqual([robustnessStageEvidence(record)])
  })

  it('fails with the route\'s reason when the lab refuses the start', async () => {
    writeFeature()
    const inject = makeInject((call) => {
      if (call.url === '/api/runs/run-1') return passedRun
      if (call.method === 'POST') return { statusCode: 409, body: { error: 'a robustness job is already running for checkout' } }
      return undefined
    })
    const { ctx, current } = ctxFor(manifest({ runId: 'run-1' }))
    const outcome = await robustnessStage(deps(inject)).run(ctx)
    expect(outcome).toEqual({ kind: 'failed', error: 'robustness lab rejected (409): a robustness job is already running for checkout' })
    expect(current().links?.robustnessJobId).toBeUndefined()
  })

  it('fails with "unknown" when the refusal carries no body to quote', async () => {
    writeFeature()
    const inject = makeInject((call) => {
      if (call.url === '/api/runs/run-1') return passedRun
      if (call.method === 'POST') return { statusCode: 500, body: {} }
      return undefined
    })
    const outcome = await robustnessStage(deps(inject)).run(ctxFor(manifest({ runId: 'run-1' })).ctx)
    expect(outcome).toEqual({ kind: 'failed', error: 'robustness lab rejected (500): unknown' })
  })

  it('publishes live counters on every change while the matrix runs, then settles on the final record', async () => {
    writeFeature()
    const reads = [
      job({ status: 'running', endedAt: undefined, cells: { planned: 4, done: 1 } }),
      job({ status: 'running', endedAt: undefined, cells: { planned: 4, done: 1 } }),
      job({ findings: [finding('unconfirmed', 'browse')] }),
    ]
    const inject = makeInject((call) => {
      if (call.url === '/api/runs/run-1') return passedRun
      if (call.method === 'POST') return { statusCode: 202, body: { jobId: 'rj-1' } }
      if (call.url === '/api/robustness/rj-1') return { statusCode: 200, body: reads.length > 1 ? reads.shift() : reads[0] }
      return undefined
    })
    const { ctx, progress } = ctxFor(manifest({ runId: 'run-1' }))
    const outcome = await robustnessStage(deps(inject)).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { findings: 1, unconfirmed: 1, cells: { planned: 4, done: 4 } } })
    // Three reads, two distinct states: the unchanged middle read publishes nothing.
    expect(progress).toEqual([
      { jobId: 'rj-1', runId: 'run-1', cells: { planned: 4, done: 1 }, findings: 0, confirmed: 0, unconfirmed: 0, skipped: 0 },
      { jobId: 'rj-1', runId: 'run-1', cells: { planned: 4, done: 4 }, findings: 1, confirmed: 0, unconfirmed: 1, skipped: 0 },
    ])
  }, 15_000)

  it.each(['failed', 'aborted'] as const)('fails the stage with the record\'s own reason when the matrix ended %s', async (status) => {
    writeFeature()
    const record = job({ status, error: status === 'failed' ? 'shim never bound' : undefined })
    const outcome = await robustnessStage(deps(labThatSettles(record))).run(ctxFor(manifest({ runId: 'run-1' })).ctx)
    expect(outcome).toEqual({ kind: 'failed', error: `robustness matrix ${status}: ${status === 'failed' ? 'shim never bound' : 'no reason recorded'}` })
  })

  it('fails when the job record disappears while the stage waits on it', async () => {
    writeFeature()
    const inject = makeInject((call) => {
      if (call.url === '/api/runs/run-1') return passedRun
      if (call.method === 'POST') return { statusCode: 202, body: { jobId: 'rj-1' } }
      if (call.url === '/api/robustness/rj-1') return { statusCode: 404, body: { error: 'robustness job not found' } }
      return undefined
    })
    const outcome = await robustnessStage(deps(inject)).run(ctxFor(manifest({ runId: 'run-1' })).ctx)
    expect(outcome).toEqual({ kind: 'failed', error: 'robustness job rj-1 disappeared while the stage was waiting on it' })
  })
})

describe('robustness stage — resume re-attaches, never a second matrix', () => {
  it('re-attaches to the job the flight already pinned and settles on it without POSTing', async () => {
    writeFeature()
    const calls: InjectCall[] = []
    const record = job({ jobId: 'rj-prior' })
    const inject = makeInject((call) => (call.url === '/api/robustness/rj-prior' ? { statusCode: 200, body: record } : undefined), calls)
    const { ctx, log } = ctxFor(manifest({ runId: 'run-1', robustnessJobId: 'rj-prior' }))
    const outcome = await robustnessStage(deps(inject)).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { jobId: 'rj-prior' } })
    // The existence check and the settle poll both read the record; nothing is written.
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET'])
    expect(calls.every((c) => c.url === '/api/robustness/rj-prior')).toBe(true)
    expect(log).toEqual(['[robustness] re-attaching to job rj-prior\n'])
  })

  it.each(['failed', 'aborted'] as const)('starts afresh when the pinned job ended %s — a stopped matrix is not the answer', async (status) => {
    writeFeature()
    const calls: InjectCall[] = []
    const fresh = job({ jobId: 'rj-2' })
    const inject = makeInject((call) => {
      if (call.url === '/api/robustness/rj-prior') return { statusCode: 200, body: job({ jobId: 'rj-prior', status }) }
      if (call.url === '/api/runs/run-1') return passedRun
      if (call.method === 'POST') return { statusCode: 202, body: { jobId: 'rj-2' } }
      if (call.url === '/api/robustness/rj-2') return { statusCode: 200, body: fresh }
      return undefined
    }, calls)
    const { ctx, current } = ctxFor(manifest({ runId: 'run-1', robustnessJobId: 'rj-prior' }))
    const outcome = await robustnessStage(deps(inject)).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { jobId: 'rj-2' } })
    expect(current().links?.robustnessJobId).toBe('rj-2')
  })

  it('starts afresh when the pinned job record is gone', async () => {
    writeFeature()
    const fresh = job({ jobId: 'rj-2' })
    const inject = makeInject((call) => {
      if (call.url === '/api/robustness/rj-prior') return { statusCode: 404, body: {} }
      if (call.url === '/api/runs/run-1') return passedRun
      if (call.method === 'POST') return { statusCode: 202, body: { jobId: 'rj-2' } }
      if (call.url === '/api/robustness/rj-2') return { statusCode: 200, body: fresh }
      return undefined
    })
    const outcome = await robustnessStage(deps(inject)).run(ctxFor(manifest({ runId: 'run-1', robustnessJobId: 'rj-prior' })).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { jobId: 'rj-2' } })
  })
})

describe('robustness stage — teardown and reset', () => {
  it('owns the pinned job: teardown stops it through the abort route, so findings so far stay readable', async () => {
    const calls: InjectCall[] = []
    const adapter = robustnessStage(deps(makeInject(() => ({ statusCode: 202, body: { aborted: true } }), calls)))
    const stageJob = adapter.teardown(ctxFor(manifest({ runId: 'run-1', robustnessJobId: 'rj-1' })).ctx)
    expect(stageJob?.id).toBe('rj-1')
    await stageJob!.stop('pause')
    expect(calls).toMatchObject([{ method: 'POST', url: '/api/robustness/rj-1/abort' }])
  })

  it('owns nothing before a job is pinned', () => {
    expect(robustnessStage(deps(makeInject(() => undefined))).teardown(ctxFor(manifest({ runId: 'run-1' })).ctx)).toBeNull()
  })

  it('reset drops the pinned job record through its route, and is a no-op without one', async () => {
    const calls: InjectCall[] = []
    const adapter = robustnessStage(deps(makeInject(() => ({ statusCode: 204, body: null }), calls)))
    await adapter.reset!(ctxFor(manifest({ runId: 'run-1', robustnessJobId: 'rj-1' })).ctx)
    expect(calls).toEqual([{ method: 'DELETE', url: '/api/robustness/rj-1' }])
    await adapter.reset!(ctxFor(manifest({ runId: 'run-1' })).ctx)
    expect(calls).toHaveLength(1)
  })

  it('reset swallows a route failure — a wipe must not be blocked by a record that is already gone', async () => {
    const adapter = robustnessStage(deps(async () => { throw new Error('route down') }))
    await expect(adapter.reset!(ctxFor(manifest({ runId: 'run-1', robustnessJobId: 'rj-1' })).ctx)).resolves.toBeUndefined()
  })
})
