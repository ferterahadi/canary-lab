import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { ROBUSTNESS_ENVELOPE_FORMAT } from '../../../../../../shared/robustness/types'
import { readRobustnessEnvelope, writeRobustnessEnvelope } from '../../../../../../shared/robustness/envelope'
import type { RobustnessJobManifest } from '../../../../../../shared/robustness/jobs'
import { writeRunsIndex, type RunIndexEntry } from '../logic/runtime/manifest'
import type { RobustnessCellResult, RobustnessCellRunner } from '../logic/robustness/cell-runner'
import { RobustnessJobRunStore } from '../logic/robustness/store'

// The driver is real everywhere below; one test flips this to prove the route
// still answers with text when the start path throws something that is not an
// Error (a bare string from a faulty planner would otherwise 500 as `{}`).
const driver = vi.hoisted(() => ({ throwRaw: undefined as unknown }))
vi.mock('../logic/robustness/matrix', async (importOriginal) => {
  const real = await importOriginal<typeof import('../logic/robustness/matrix')>()
  return {
    ...real,
    startRobustnessJob: (...args: Parameters<typeof real.startRobustnessJob>) => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the non-Error path under test
      if (driver.throwRaw !== undefined) throw driver.throwRaw
      return real.startRobustnessJob(...args)
    },
  }
})

import { latestPassedRun, robustnessRoutes } from './robustness'

// Admission for a Robustness Lab matrix lives in this one route, for the flight
// stage and the MCP tools alike: a green run, a suite with a declared slot, an
// envelope that parses, one matrix per suite. Each refusal is pinned with its
// status AND its wording — the wording is what a human or an agent acts on.

const FORMAT = ROBUSTNESS_ENVELOPE_FORMAT
const FEATURE = 'storefront'

let tmp: string
let logsDir: string
let featuresDir: string
let featureDir: string
let store: RobustnessJobRunStore
let app: FastifyInstance

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-robustness-routes-')))
  logsDir = path.join(tmp, 'logs')
  featuresDir = path.join(tmp, 'features')
  featureDir = path.join(featuresDir, FEATURE)
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featureDir, { recursive: true })
  store = new RobustnessJobRunStore(logsDir)
})

afterEach(async () => {
  driver.throwRaw = undefined
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeFeature(startCommands: string): void {
  fs.writeFileSync(
    path.join(featureDir, 'feature.config.cjs'),
    `module.exports = { config: {
       name: '${FEATURE}', description: 'fixture', envs: ['local'], featureDir: __dirname,
       repos: [{ name: 'app', localPath: '/tmp/app', startCommands: ${startCommands} }],
     } }`,
  )
}
const SLOTTED = "[{ name: 'catalog', command: 'npm run dev', ports: [{ name: 'catalog', env: 'PORT' }] }]"

/** A settled run on disk: index row + manifest, and — for a green one — the
 *  inventory the matrix planner needs (summary with list lines, suite snapshot). */
function writeRun(runId: string, over: Partial<RunIndexEntry> & { inventory?: boolean } = {}): void {
  const { inventory = true, ...entry } = over
  const row: RunIndexEntry = { runId, feature: FEATURE, startedAt: `2026-09-10T00:00:0${runId.length % 10}Z`, status: 'passed', ...entry }
  const existing = fs.existsSync(path.join(logsDir, 'runs', 'index.json'))
    ? (JSON.parse(fs.readFileSync(path.join(logsDir, 'runs', 'index.json'), 'utf-8')) as RunIndexEntry[])
    : []
  writeRunsIndex(logsDir, [...existing, row])
  const runDir = path.join(logsDir, 'runs', runId)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ ...row, healCycles: 0, services: [], repoPaths: [], env: 'local' }))
  if (!inventory) return
  const suiteDir = path.join(runDir, 'suite', 'e2e')
  fs.mkdirSync(suiteDir, { recursive: true })
  fs.writeFileSync(path.join(suiteDir, 'a.spec.ts'), "import { test } from '@playwright/test'\ntest('browse', async () => {})\n")
  fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({
    complete: true, total: 1, passed: 1, passedNames: ['browse'], failed: [],
    knownTests: [{ name: 'browse', title: 'browse', listLine: 'e2e/a.spec.ts:2:1 › browse', location: path.join(suiteDir, 'a.spec.ts:2') }],
  }))
}

async function build(runCell: RobustnessCellRunner = async () => ({ runId: 'cell', status: 'passed', summary: { complete: true, total: 1, passed: 1, failed: [] } as never })): Promise<void> {
  app = Fastify()
  await app.register(robustnessRoutes, { featuresDir, logsDir, store, runCell })
}

const start = (body?: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/features/${FEATURE}/robustness`, ...(body ? { payload: body } : {}) })

function job(over: Partial<RobustnessJobManifest> = {}): RobustnessJobManifest {
  return {
    jobId: 'rj-1', feature: FEATURE, runId: 'run-1', envelope: { format: FORMAT, latency: { ms: 300 } }, status: 'done',
    startedAt: '2026-09-10T00:00:00Z', endedAt: '2026-09-10T00:01:00Z', cells: { planned: 1, done: 1 }, findings: [], skipped: [], log: '',
    ...over,
  }
}

describe('latestPassedRun', () => {
  it('picks the newest PASSED test run, ignoring boots, verifies, benchmarks and cells — none is a verdict on the specs', () => {
    writeRunsIndex(logsDir, [
      { runId: 'newest-boot', feature: FEATURE, startedAt: '2026-09-10T09:00:00Z', status: 'passed', executionType: 'boot' },
      { runId: 'newest-verify', feature: FEATURE, startedAt: '2026-09-10T08:00:00Z', status: 'passed', executionType: 'verify' },
      { runId: 'newest-cell', feature: FEATURE, startedAt: '2026-09-10T07:00:00Z', status: 'passed', executionType: 'robustness' },
      { runId: 'newest-failed', feature: FEATURE, startedAt: '2026-09-10T06:00:00Z', status: 'failed' },
      { runId: 'green', feature: FEATURE, startedAt: '2026-09-10T05:00:00Z', status: 'passed', executionType: 'run' },
      { runId: 'older-green', feature: FEATURE, startedAt: '2026-09-10T04:00:00Z', status: 'passed' },
      { runId: 'other-suite', feature: 'other', startedAt: '2026-09-10T10:00:00Z', status: 'passed' },
    ])
    expect(latestPassedRun(logsDir, FEATURE)).toBe('green')
    expect(latestPassedRun(logsDir, 'nobody')).toBeUndefined()
  })
})

describe('POST /api/features/:name/robustness — admission', () => {
  it('404s an unknown suite', async () => {
    await build()
    const res = await start()
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'feature not found' })
  })

  it('409s a suite with no passing run — the matrix perturbs a green run\'s tests', async () => {
    writeFeature(SLOTTED)
    writeRun('run-red', { status: 'failed' })
    await build()
    const res = await start()
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'this suite has no passing run yet — the matrix perturbs a green run\'s tests' })
  })

  it('404s a named run that is missing or belongs to another suite', async () => {
    writeFeature(SLOTTED)
    await build()
    expect((await start({ runId: 'ghost' })).statusCode).toBe(404)
    fs.mkdirSync(path.join(logsDir, 'runs', 'theirs'), { recursive: true })
    fs.writeFileSync(path.join(logsDir, 'runs', 'theirs', 'manifest.json'), JSON.stringify({ runId: 'theirs', feature: 'other', status: 'passed', startedAt: 'x', healCycles: 0, services: [] }))
    const res = await start({ runId: 'theirs' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'run theirs not found for this suite' })
  })

  it('409s a named run that did not pass, quoting its verdict', async () => {
    writeFeature(SLOTTED)
    writeRun('run-red', { status: 'failed' })
    await build()
    const res = await start({ runId: 'run-red' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'run run-red did not pass (failed) — only green tests are perturbed' })
  })

  it('400s a suite that starts no services at all', async () => {
    writeFeature('[]')
    writeRun('run-1')
    await build()
    const res = await start()
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'this suite starts no services, so there is nothing to perturb' })
  })

  it('400s a suite whose services take no port from settings, naming Parallel setup as the remedy', async () => {
    writeFeature("[{ name: 'catalog', command: 'npm run dev' }]")
    writeRun('run-1')
    await build()
    const res = await start()
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('no service takes its port from settings, so nothing can be fronted by a proxy — run Parallel setup (or declare `ports` on each start command) first')
  })

  it('400s a body envelope that does not parse, with the reason', async () => {
    writeFeature(SLOTTED)
    writeRun('run-1')
    await build()
    const res = await start({ envelope: { format: FORMAT, latency: { ms: -1 } } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/^invalid envelope: /)
  })

  it('400s when the suite\'s own envelope file is hand-broken, rather than silently replacing it', async () => {
    writeFeature(SLOTTED)
    writeRun('run-1')
    fs.mkdirSync(path.join(featureDir, 'robustness'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'robustness', 'envelope.json'), '{ not json')
    await build()
    const res = await start()
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/^the suite's robustness\/envelope\.json is invalid: /)
    expect(store.list()).toEqual([])
  })

  it('400s a planning failure (a green run with no inventory) without writing a job', async () => {
    writeFeature(SLOTTED)
    writeRun('run-1', { inventory: false })
    await build()
    const res = await start()
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'run run-1 has no test inventory to build the matrix from' })
    expect(store.list()).toEqual([])
  })
})

describe('POST /api/features/:name/robustness — starting', () => {
  it('400s with the text of a non-Error thrown by the start path', async () => {
    writeFeature(SLOTTED)
    writeRun('run-1')
    driver.throwRaw = 'planner fell over'
    await build()
    const res = await start()
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'planner fell over' })
  })

  it('202s the running record for the newest green run, WRITING the default envelope (with the suite\'s slots) so the human can see and edit what ran', async () => {
    writeFeature(SLOTTED)
    writeRun('run-old', { startedAt: '2026-09-09T00:00:00Z' })
    writeRun('run-1', { startedAt: '2026-09-10T00:00:00Z' })
    await build()
    const res = await start()
    expect(res.statusCode).toBe(202)
    const record = res.json() as RobustnessJobManifest
    expect(record).toMatchObject({ feature: FEATURE, runId: 'run-1', status: 'running', cells: { planned: 3, done: 0 } })
    expect(record.envelope).toEqual({
      format: FORMAT,
      latency: { ms: 300 },
      duplicate: { gapMs: 0, match: 'WRITE /**' },
      restart: [{ slot: 'catalog', afterNth: 2, match: 'WRITE /**' }],
    })
    expect(readRobustnessEnvelope(featureDir)).toMatchObject({ kind: 'ok', envelope: record.envelope })
    // The one-cell matrix may already have settled by now; what the route
    // promised is the record's existence in the shared store.
    expect(store.get(record.jobId)).not.toBeNull()
  })

  it('runs under the suite\'s own envelope file when it has one, and under the body\'s when given — the body wins', async () => {
    writeFeature(SLOTTED)
    writeRun('run-1')
    writeRobustnessEnvelope(featureDir, { format: FORMAT, latency: { ms: 900 } })
    await build()
    const fromFile = (await start()).json() as RobustnessJobManifest
    expect(fromFile.envelope).toEqual({ format: FORMAT, latency: { ms: 900 } })
    // Let the one-cell matrix settle so the single-flight lock frees.
    await new Promise((r) => setTimeout(r, 20))
    const fromBody = (await start({ envelope: { format: FORMAT, duplicate: { gapMs: 100, match: 'WRITE /**' } } })).json() as RobustnessJobManifest
    expect(fromBody.envelope).toEqual({ format: FORMAT, duplicate: { gapMs: 100, match: 'WRITE /**' } })
    // The file is the human's; a body envelope never overwrites it.
    expect(readRobustnessEnvelope(featureDir)).toMatchObject({ kind: 'ok', envelope: { format: FORMAT, latency: { ms: 900 } } })
  })

  it('409s a second matrix while one is running for the suite, naming the job', async () => {
    writeFeature(SLOTTED)
    writeRun('run-1')
    await build(() => new Promise<RobustnessCellResult>(() => { /* held */ }))
    const first = (await start()).json() as RobustnessJobManifest
    const res = await start()
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: `a robustness job is already running for ${FEATURE}`, jobId: first.jobId })
  })
})

describe('reading, stopping and dropping a job', () => {
  it('lists a suite\'s jobs newest first and reads one by id; 404s an unknown id', async () => {
    store.save(job({ jobId: 'rj-old', startedAt: '2026-09-09T00:00:00Z' }))
    store.save(job({ jobId: 'rj-new', startedAt: '2026-09-10T00:00:00Z' }))
    store.save(job({ jobId: 'rj-other', feature: 'other' }))
    await build()
    const list = await app.inject({ method: 'GET', url: `/api/features/${FEATURE}/robustness` })
    expect((list.json() as Array<{ jobId: string }>).map((e) => e.jobId)).toEqual(['rj-new', 'rj-old'])
    const all = await app.inject({ method: 'GET', url: '/api/robustness' })
    expect((all.json() as Array<{ jobId: string }>).map((e) => e.jobId)).toEqual(store.list().map((e) => e.jobId))
    expect((all.json() as Array<{ jobId: string }>).map((e) => e.jobId).sort()).toEqual(['rj-new', 'rj-old', 'rj-other'])
    const one = await app.inject({ method: 'GET', url: '/api/robustness/rj-old' })
    expect(one.statusCode).toBe(200)
    expect(one.json()).toEqual(store.get('rj-old'))
    const missing = await app.inject({ method: 'GET', url: '/api/robustness/nope' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: 'robustness job not found' })
  })

  it('abort stops a running matrix through its driver and keeps the record with what was found', async () => {
    writeFeature(SLOTTED)
    writeRun('run-1')
    await build(() => new Promise<RobustnessCellResult>(() => { /* held */ }))
    const running = (await start()).json() as RobustnessJobManifest
    const res = await app.inject({ method: 'POST', url: `/api/robustness/${running.jobId}/abort` })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ aborted: true, status: 'aborted' })
    // The driver notices at its next checkpoint — the held cell never returns,
    // so the record flips only once the cell's own abort releases it. Here the
    // route's answer is the contract; the driver's flip is pinned in matrix.test.
    expect(store.get(running.jobId)).not.toBeNull()
  })

  it('abort settles a record that is running on disk with no driver here (the owning process died) so the lock frees now', async () => {
    store.save(job({ jobId: 'rj-orphan', status: 'running', endedAt: undefined }))
    await build()
    const res = await app.inject({ method: 'POST', url: '/api/robustness/rj-orphan/abort' })
    expect(res.statusCode).toBe(202)
    expect(store.get('rj-orphan')).toMatchObject({ status: 'aborted', error: 'Aborted' })
    expect(store.get('rj-orphan')?.endedAt).toBeTypeOf('string')
    expect(store.activeFor(FEATURE)).toBeNull()
  })

  it('abort keeps an orphan\'s own error when it recorded one', async () => {
    store.save(job({ jobId: 'rj-orphan', status: 'running', endedAt: undefined, error: 'lost the shim' }))
    await build()
    await app.inject({ method: 'POST', url: '/api/robustness/rj-orphan/abort' })
    expect(store.get('rj-orphan')?.error).toBe('lost the shim')
  })

  it('abort is idempotent on a settled job and 404s an unknown one', async () => {
    store.save(job({ jobId: 'rj-done' }))
    await build()
    const settled = await app.inject({ method: 'POST', url: '/api/robustness/rj-done/abort' })
    expect(settled.statusCode).toBe(200)
    expect(settled.json()).toEqual({ aborted: false, status: 'done' })
    expect((await app.inject({ method: 'POST', url: '/api/robustness/nope/abort' })).statusCode).toBe(404)
  })

  it('delete drops the record — stopping a running matrix first — and 404s an unknown one', async () => {
    store.save(job({ jobId: 'rj-done' }))
    await build(() => new Promise<RobustnessCellResult>(() => { /* held */ }))
    expect((await app.inject({ method: 'DELETE', url: '/api/robustness/rj-done' })).statusCode).toBe(204)
    expect(store.get('rj-done')).toBeNull()

    writeFeature(SLOTTED)
    writeRun('run-1')
    const running = (await start()).json() as RobustnessJobManifest
    expect((await app.inject({ method: 'DELETE', url: `/api/robustness/${running.jobId}` })).statusCode).toBe(204)
    expect(store.get(running.jobId)).toBeNull()
    expect((await app.inject({ method: 'DELETE', url: '/api/robustness/nope' })).statusCode).toBe(404)
  })
})
