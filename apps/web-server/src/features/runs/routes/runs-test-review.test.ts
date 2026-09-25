// GET /api/runs/:runId/test-review — the patch a human is shown before deciding
// whether a mid-run spec edit gets into the run. Both arms here refuse to answer
// at all: an id that could escape the logs directory, and a suite that moved
// while the patch was being built. The happy path and the missing-snapshot 409
// are covered end-to-end through the real MCP + REST path in
// `mcp/server.test-review.test.ts`.
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runsRoutes } from './runs'
import { createRegistry, RunStore } from '../logic/run-store'
import { updateManifest, writeManifest } from '../logic/runtime/manifest'
import { runDirFor } from '../logic/runtime/run-paths'

vi.mock('../../../shared/editor-launch', () => ({ launchEditorDir: vi.fn(() => 'vscode') }))

// The 409 below guards a write that lands WHILE the patch is being built, so the
// test has to place one at that instant. Hooking the awaited diff step is the
// only deterministic way to do it — a timer would race the git subprocess the
// real implementation spawns, and a race is what this arm exists to catch.
const duringDiff = { run: () => {} }
vi.mock('../logic/dirty-specs/text-diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logic/dirty-specs/text-diff')>()
  return {
    ...actual,
    diffSourceText: async (...args: Parameters<typeof actual.diffSourceText>) => {
      duringDiff.run()
      return actual.diffSourceText(...args)
    },
  }
})

let tmpDir: string
let live: string
let registry: ReturnType<typeof createRegistry>

beforeEach(() => {
  duringDiff.run = () => {}
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-run-review-')))
  for (const dir of ['logs', 'features/demo/e2e', 'snap/e2e']) fs.mkdirSync(path.join(tmpDir, dir), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'snap/e2e/a.spec.ts'), "test('a', () => expect(1).toBe(1))\n")
  live = path.join(tmpDir, 'features/demo/e2e/a.spec.ts')
  fs.writeFileSync(live, "test('a', () => expect(2).toBe(2))\n")
})

async function build() {
  const logsDir = path.join(tmpDir, 'logs')
  registry = createRegistry()
  const store = new RunStore(logsDir, registry)
  const runDir = runDirFor(logsDir, 'r1')
  fs.mkdirSync(runDir, { recursive: true })
  writeManifest(path.join(runDir, 'manifest.json'), {
    runId: 'r1', feature: 'demo', featureDir: path.join(tmpDir, 'features/demo'),
    startedAt: 'now', status: 'healing', services: [], healCycles: 1,
    suiteSnapshot: { kind: 'taken', dir: path.join(tmpDir, 'snap'), takenAt: 'now', digest: 'abcdef0123456789' },
  })
  const app = Fastify()
  await app.register(runsRoutes, {
    featuresDir: path.join(tmpDir, 'features'),
    store,
    startRun: async () => { throw new Error('not configured') },
  })
  return app
}

describe('GET /api/runs/:runId/test-review', () => {
  // The run id becomes a path segment under the logs directory, so it is checked
  // before anything reads. A separator is the only rejection reachable over HTTP:
  // the router resolves `%2e%2e` to a parent segment and stops matching this
  // route at all, so the handler's explicit `.`/`..` check cannot be driven from
  // here. It stays as the guard for a caller that is not the router — the same
  // one `recorded-test-list.ts` applies to a run id that arrives as a query
  // parameter, where a bare `..` really does get through.
  it('refuses a run id carrying a path separator, without looking for it', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/api/runs/a%2Fb/test-review' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Invalid run')
  })

  it('distinguishes a missing run, an unavailable snapshot, and a settled empty review', async () => {
    const app = await build()
    expect((await app.inject({ method: 'GET', url: '/api/runs/missing/test-review' })).statusCode).toBe(404)

    fs.rmSync(path.join(tmpDir, 'snap'), { recursive: true })
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/test-review' })).statusCode).toBe(409)

    fs.mkdirSync(path.join(tmpDir, 'snap/e2e'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'snap/e2e/a.spec.ts'), fs.readFileSync(live))
    const settled = await app.inject({ method: 'GET', url: '/api/runs/r1/test-review?summary=true' })
    expect(settled.json()).toMatchObject({ reviewState: 'settled', allowedActions: [], nextAction: 'none', files: [] })
  })

  it('reports a missing live suite without treating the saved snapshot as missing', async () => {
    const app = await build()
    fs.rmSync(path.join(tmpDir, 'features/demo'), { recursive: true })
    const response = await app.inject('/api/runs/r1/test-review?summary=true')
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('live suite is unavailable')
    expect(fs.existsSync(path.join(tmpDir, 'snap/e2e/a.spec.ts'))).toBe(true)
  })

  it('rejects a retired suite with only untracked files left in its folder', async () => {
    const app = await build()
    fs.writeFileSync(path.join(tmpDir, 'snap/feature.config.cjs'), "module.exports = { name: 'demo' }\n")
    const response = await app.inject('/api/runs/r1/test-review?summary=true')
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('live suite is unavailable')
  })

  it('serves the patch and its revision for a snapshot that held still', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/api/runs/r1/test-review' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ runId: 'r1', feature: 'demo', baseline: 'run-start', files: [{ file: 'e2e/a.spec.ts', change: 'modified' }] })
    expect(res.json().patch).toContain('expect(2).toBe(2)')
  })

  it('serves lightweight review state without writing a patch artifact', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/test-review?summary=true' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ runId: 'r1', feature: 'demo', baseline: 'run-start',
      files: [{ file: 'e2e/a.spec.ts', change: 'modified' }], canAdopt: false })
    expect(res.json().review_revision).toMatch(/^[a-f0-9]{64}$/)
    expect(res.json()).not.toHaveProperty('patch')
    expect(res.json()).not.toHaveProperty('patchPath')
    expect(fs.existsSync(path.join(runDirFor(path.join(tmpDir, 'logs'), 'r1'), 'test-reviews'))).toBe(false)
  })

  it('reports terminal review capabilities without pretending the old run can rerun', async () => {
    const app = await build()
    const manifestPath = path.join(runDirFor(path.join(tmpDir, 'logs'), 'r1'), 'manifest.json')
    updateManifest(manifestPath, {
      status: 'passed', endedAt: 'later',
      specEdits: { checkedAt: 'later', pending: [{ file: 'e2e/a.spec.ts', change: 'modified', affectedTests: [] }], adopted: [] },
    })
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/test-review?summary=true' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      canAdopt: false,
      reviewState: 'pending-terminal',
      allowedActions: ['approve-new-run', 'restore', 'leave-pending'],
      nextAction: 'restore-or-leave',
    })
  })

  it('reports active and previously settled reviews, retaining a large patch only on disk', async () => {
    const app = await build()
    registry.set('r1', {
      runId: 'r1',
      stop: async () => {},
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
      adoptSpecEdits: async () => ({ ok: false, reason: 'nothing-to-adopt' }),
    })
    const active = await app.inject({ method: 'GET', url: '/api/runs/r1/test-review?summary=true' })
    expect(active.json()).toMatchObject({ reviewState: 'pending-active', nextAction: 'rerun-current' })
    const revision = active.json().review_revision as string
    const manifestPath = path.join(runDirFor(path.join(tmpDir, 'logs'), 'r1'), 'manifest.json')
    updateManifest(manifestPath, {
      specEdits: {
        checkedAt: 'later', pending: [], adopted: [],
        reviewDecisions: [{ revision, decision: 'approved-for-new-run', receipt: { decision: 'accepted', review_revision: revision, files: [], git: { status: 'not-requested' }, execution: { status: 'none' } } }],
      },
    })
    const settled = await app.inject({ method: 'GET', url: '/api/runs/r1/test-review?summary=true' })
    expect(settled.json()).toMatchObject({ reviewState: 'settled', nextAction: 'start-new-run', receipt: { decision: 'accepted' } })
    updateManifest(manifestPath, {
      specEdits: { checkedAt: 'later', pending: [], adopted: [], reviewDecisions: [{ revision, decision: 'restored' }] },
    })
    const receiptless = await app.inject({ method: 'GET', url: '/api/runs/r1/test-review?summary=true' })
    expect(receiptless.json()).toMatchObject({ reviewState: 'settled', nextAction: 'none' })
    expect(receiptless.json()).not.toHaveProperty('receipt')
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/test-review' })).statusCode).toBe(200)

    const large = await build()
    fs.writeFileSync(live, `test('large', () => {\n${'x'.repeat(9000)}\n})\n`)
    const response = await large.inject({ method: 'GET', url: '/api/runs/r1/test-review' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).not.toHaveProperty('patch')
    expect(response.json().patchPath).toEqual(expect.stringContaining('test-reviews'))
  })

  // A revision the human never saw must not be offered for approval: the patch in
  // the reply would be stale the moment it was written.
  it('refuses to serve a review whose suite changed while the patch was built', async () => {
    const app = await build()
    duringDiff.run = () => {
      fs.appendFileSync(live, "test('b', () => expect(3).toBe(3))\n")
      duringDiff.run = () => {}
    }
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/test-review' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/Suite changed while preparing review/)
    // Nothing is banked under a revision nobody can act on.
    expect(fs.existsSync(path.join(runDirFor(path.join(tmpDir, 'logs'), 'r1'), 'test-reviews'))).toBe(false)
  })
})
