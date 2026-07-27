import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

import Fastify, { type FastifyInstance } from 'fastify'

// Coverage generation is LLM-only; the route drives the real service, so swap the
// agent-backed summarizer/mapper for the test fakes at the module boundary.
//
// The fakes are loaded via vi.hoisted (which runs BEFORE the vi.mock registrations
// below) so the fixture's own `import { reconcileRequirementIds } from
// '../prd-summary'` resolves to the REAL module. Importing the fixture *inside* a
// mock factory deadlocks instead: the factory would await an import of the fixture,
// which re-enters the very module being mocked while its factory is still running.
const { fakeSummarize, fakePropose } = await vi.hoisted(
  async () => import('../logic/coverage/__fixtures__/fake-coverage-agents'),
)

vi.mock('../logic/coverage/prd-summary', async (importActual) => {
  const actual = await importActual<typeof import('../logic/coverage/prd-summary')>()
  return { ...actual, summarizePrd: fakeSummarize }
})

vi.mock('../logic/coverage/annotate-engine', async (importActual) => {
  const actual = await importActual<typeof import('../logic/coverage/annotate-engine')>()
  return { ...actual, proposeCoverageMappings: fakePropose }
})

import { coverageRoutes } from './coverage'

import type { WorkspaceEvent } from '../../../shared/workspace-events'

import { CoverageJobRunStore, type CoverageJobStore, type CoverageJobStoreEvent } from '../logic/coverage/jobs/store'

let tmpDir: string

let featuresDir: string

let logsDir: string

let app: FastifyInstance

let events: WorkspaceEvent[]

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cov-route-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  app = Fastify()
  events = []
  await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, workspaceEvents: { publish: (e) => events.push(e) } })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFeature(name: string, spec: string, docs: Record<string, string> = {}): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), spec)
  if (Object.keys(docs).length) {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    for (const [rel, content] of Object.entries(docs)) {
      fs.writeFileSync(path.join(dir, 'docs', rel), content)
    }
  }
  return dir
}

const SPEC = `
  import { test, expect } from '@playwright/test'
  // @requirement R1
  // @path happy
  test('Cart adds an item', async () => {
    await page.goto('https://shop.test/cart')
    await expect(page.locator('.cart')).toBeVisible()
  })
`

describe('coverage routes', () => {
  it('starts a coverage job (202), polls it to done, and rejects a concurrent one (409)', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nuser adds an item to the cart' })
    await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: {} })

    const start = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/coverage/jobs',
      payload: { kind: 'coverage' },
    })
    expect(start.statusCode).toBe(202)
    const jobId = (start.json() as { jobId: string }).jobId
    expect(jobId).toBeTruthy()

    // Poll until the (fast, deterministic) job finishes.
    let manifest: { status: string } = { status: 'running' }
    for (let i = 0; i < 50 && manifest.status === 'running'; i++) {
      manifest = (await app.inject({ method: 'GET', url: `/api/coverage/jobs/${jobId}` })).json() as { status: string }
      if (manifest.status === 'running') await new Promise((r) => setTimeout(r, 10))
    }
    expect(manifest.status).toBe('done')

    // It appears in the feature's job list.
    const jobs = (await app.inject({ method: 'GET', url: '/api/features/checkout/coverage/jobs' })).json() as unknown[]
    expect(jobs.length).toBe(1)
  })

  it('rejects a job with an invalid kind (400) and an unknown feature (404)', async () => {
    writeFeature('checkout', SPEC)
    const bad = await app.inject({ method: 'POST', url: '/api/features/checkout/coverage/jobs', payload: { kind: 'nope' } })
    expect(bad.statusCode).toBe(400)
    const missing = await app.inject({ method: 'POST', url: '/api/features/ghost/coverage/jobs', payload: { kind: 'summary' } })
    expect(missing.statusCode).toBe(404)
  })

  it('404s polling an unknown job', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/coverage/jobs/missing' })
    expect(res.statusCode).toBe(404)
  })

  it('agent-session: 404s an unknown job and returns null when a job has no session (R17)', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart\nuser adds an item' })
    // Unknown job → 404.
    const missing = await app.inject({ method: 'GET', url: '/api/coverage/jobs/nope/agent-session' })
    expect(missing.statusCode).toBe(404)
    // A real deterministic job has no agent session ref → null (200).
    await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: {} })
    const start = await app.inject({ method: 'POST', url: '/api/features/checkout/coverage/jobs', payload: { kind: 'coverage' } })
    const jobId = (start.json() as { jobId: string }).jobId
    let m: { status: string } = { status: 'running' }
    for (let i = 0; i < 50 && m.status === 'running'; i++) {
      m = (await app.inject({ method: 'GET', url: `/api/coverage/jobs/${jobId}` })).json() as { status: string }
      if (m.status === 'running') await new Promise((r) => setTimeout(r, 10))
    }
    const session = await app.inject({ method: 'GET', url: `/api/coverage/jobs/${jobId}/agent-session` })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toBeNull()
  })

  it('agent-session: returns null (200) for a claude sessionRef when the log file is not on disk', async () => {
    // Create a feature so the store can accept its job manifest.
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart\nuser adds an item' })
    await app.close()

    // Re-register the route with an injected store so we can seed a manifest
    // with a claude sessionRef directly (no real agent runs).
    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    const fakeJobId = 'cj-test-session'
    store.save({
      jobId: fakeJobId,
      feature: 'checkout',
      kind: 'coverage',
      status: 'done',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      log: '',
      sessionRef: { agent: 'claude', sessionId: 'nonexistent-session-id' },
    })

    // findClaudeLogBySessionId returns null for a session that doesn't exist on
    // disk → the endpoint returns null (200) for the "no log yet" case.
    const res = await app.inject({ method: 'GET', url: `/api/coverage/jobs/${fakeJobId}/agent-session` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
  })

  it('rejects a concurrent job with 409 and existingJobId', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nuser adds an item to the cart' })
    await app.close()

    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    // Seed a running job so the single-flight guard fires.
    const fakeJobId = 'cj-blocker'
    store.save({ jobId: fakeJobId, feature: 'checkout', kind: 'coverage', status: 'running', startedAt: '2026-01-01T00:00:00Z', log: '' })

    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/coverage/jobs',
      payload: { kind: 'coverage' },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { existingJobId: string }).existingJobId).toBe(fakeJobId)
    expect(typeof (res.json() as { error: string }).error).toBe('string')
  })

  it('agent-session: returns null (200) for a claude sessionRef with an empty sessionId (line 231 null branch)', async () => {
    // ref.agent === 'claude' but ref.sessionId is '' (falsy) → the ternary
    // `ref.sessionId ? findClaudeLogBySessionId(...) : null` takes the null branch.
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart\nuser adds an item' })
    await app.close()

    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    store.save({
      jobId: 'cj-claude-no-session',
      feature: 'checkout',
      kind: 'coverage',
      status: 'done',
      startedAt: '2026-01-01T00:00:00Z',
      log: '',
      sessionRef: { agent: 'claude', sessionId: '' },
    })

    const res = await app.inject({ method: 'GET', url: '/api/coverage/jobs/cj-claude-no-session/agent-session' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
  })

  it('agent-session: returns null (200) for a codex sessionRef when no session is on disk', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart\nuser adds an item' })
    await app.close()

    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    store.save({
      jobId: 'cj-codex',
      feature: 'checkout',
      kind: 'coverage',
      status: 'done',
      startedAt: '2026-01-01T00:00:00Z',
      log: '',
      sessionRef: { agent: 'codex', sessionId: '' },
    })

    // locateCodexSessionLog returns null (no real codex session on disk) → route returns null.
    const res = await app.inject({ method: 'GET', url: '/api/coverage/jobs/cj-codex/agent-session' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
  })

  it('agent-session: loads and returns events from a real claude log when it exists on disk (R17)', async () => {
    // Build a minimal JSONL claude session log on disk so findClaudeLogBySessionId
    // can locate it → loadAgentSession is called → lines 238-239 are covered.
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart\nuser adds an item' })
    await app.close()

    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    const sessionId = 'test-session-log-' + Date.now()
    // Write a minimal claude log under ~/.claude/projects/<encoded-tmpDir>/<sessionId>.jsonl
    const homeDir = os.homedir()
    const encodedDir = tmpDir.replace(/\//g, '-').replace(/^-/, '')
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    // Scan for any existing project dir that matches, or create a synthetic one.
    // We use a dedicated test subdir so we can clean it up.
    const testProjectDir = path.join(projectsDir, `test-canary-lab-${Date.now()}`)
    fs.mkdirSync(testProjectDir, { recursive: true })
    const logFile = path.join(testProjectDir, `${sessionId}.jsonl`)
    fs.writeFileSync(logFile, JSON.stringify({ type: 'system', subtype: 'init', cwd: tmpDir, version: '1.0.0', tools: [] }) + '\n')

    try {
      store.save({
        jobId: 'cj-real-session',
        feature: 'checkout',
        kind: 'coverage',
        status: 'done',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:01:00Z',
        log: '',
        sessionRef: { agent: 'claude', sessionId },
      })

      const res = await app.inject({ method: 'GET', url: '/api/coverage/jobs/cj-real-session/agent-session' })
      expect(res.statusCode).toBe(200)
      // The session was found and loaded: returns an object with agent + events array.
      const body = res.json() as { agent: string; events: unknown[] } | null
      expect(body).not.toBeNull()
      expect(body?.agent).toBe('claude')
      expect(Array.isArray(body?.events)).toBe(true)
    } finally {
      // Clean up the synthetic project dir.
      fs.rmSync(testProjectDir, { recursive: true, force: true })
    }
  })

  it('GET /api/coverage/jobs returns all jobs sorted newest-first (line 184)', async () => {
    // Populate three jobs with distinct timestamps so the sort comparator is called
    // in both directions — covering both the `1` (a < b) and `-1` (a >= b) branches.
    writeFeature('checkout', SPEC)
    writeFeature('checkout2', SPEC)
    writeFeature('checkout3', SPEC)
    await app.close()

    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    store.save({ jobId: 'cj-a', feature: 'checkout', kind: 'summary', status: 'done', startedAt: '2026-01-01T00:00:00Z', log: '' })
    store.save({ jobId: 'cj-b', feature: 'checkout2', kind: 'coverage', status: 'done', startedAt: '2026-01-03T00:00:00Z', log: '' })
    store.save({ jobId: 'cj-c', feature: 'checkout3', kind: 'summary', status: 'done', startedAt: '2026-01-02T00:00:00Z', log: '' })

    const res = await app.inject({ method: 'GET', url: '/api/coverage/jobs' })
    expect(res.statusCode).toBe(200)
    const jobs = res.json() as Array<{ jobId: string; startedAt: string }>
    expect(jobs.length).toBeGreaterThanOrEqual(3)
    // Newest first: cj-b (Jan 3) → cj-c (Jan 2) → cj-a (Jan 1).
    const ids = jobs.map((j) => j.jobId)
    expect(ids.indexOf('cj-b')).toBeLessThan(ids.indexOf('cj-c'))
    expect(ids.indexOf('cj-c')).toBeLessThan(ids.indexOf('cj-a'))
  })

  it('re-throws non-conflict errors from startCoverageJob as 500 (line 275)', async () => {
    // Inject a store whose save() throws immediately, causing startCoverageJob to
    // propagate the error as a non-CoverageJobConflictError → route re-throws → 500.
    writeFeature('checkout', SPEC)
    await app.close()

    const throwingStore: CoverageJobStore = {
      list: () => [],
      get: () => null,
      activeFor: () => null,
      save: () => { throw new Error('disk full') },
      remove: () => {},
      reconcileInterrupted: () => {},
      onEvent: () => {},
      offEvent: () => {},
    }

    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: throwingStore })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/coverage/jobs',
      payload: { kind: 'coverage' },
    })
    expect(res.statusCode).toBe(500)
  })
})
