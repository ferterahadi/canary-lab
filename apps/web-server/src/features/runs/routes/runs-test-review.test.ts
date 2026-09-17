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
import { writeManifest } from '../logic/runtime/manifest'
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
  const store = new RunStore(logsDir, createRegistry())
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

  it('serves the patch and its revision for a snapshot that held still', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/api/runs/r1/test-review' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ runId: 'r1', feature: 'demo', baseline: 'run-start', files: [{ file: 'e2e/a.spec.ts', change: 'modified' }] })
    expect(res.json().patch).toContain('expect(2).toBe(2)')
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
