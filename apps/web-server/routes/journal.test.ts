import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { journalRoutes } from './journal'
import { buildRunPaths, runDirFor } from '../lib/runtime/run-paths'

let tmpDir: string
let logsDir: string
let journalPath: string
let runJournalPath: string

const SAMPLE = `# Diagnosis Journal

## Iteration 1 — 2026-04-22T01:20:11Z

- run: r-aaaa
- feature: foo
- hypothesis: h1
- signal: .restart
- outcome: no_change

## Iteration 2 — 2026-04-22T01:25:00Z

- run: r-bbbb
- feature: bar
- hypothesis: h2
- signal: .rerun
- outcome: pending
`

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-jroutes-')))
  logsDir = path.join(tmpDir, 'logs')
  journalPath = path.join(tmpDir, 'diagnosis-journal.md')
  fs.writeFileSync(journalPath, SAMPLE)
  runJournalPath = buildRunPaths(runDirFor(logsDir, 'r-bbbb')).diagnosisJournalPath
  fs.mkdirSync(path.dirname(runJournalPath), { recursive: true })
  fs.writeFileSync(runJournalPath, SAMPLE)
})

async function build() {
  const app = Fastify()
  await app.register(journalRoutes, { logsDir, journalPath })
  return app
}

async function buildWithoutLegacyJournal() {
  const app = Fastify()
  await app.register(journalRoutes, { logsDir })
  return app
}

describe('GET /api/journal', () => {
  it('returns sections newest first', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/journal' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ iteration: number }>
    expect(body.map((b) => b.iteration)).toEqual([2, 1])
  })

  it('filters by feature', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/journal?feature=foo' })
    const body = res.json() as Array<{ iteration: number }>
    expect(body.map((b) => b.iteration)).toEqual([1])
  })

  it('filters by run', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/journal?run=r-bbbb' })
    expect((res.json() as Array<{ iteration: number }>).map((b) => b.iteration)).toEqual([2])
  })

  it('falls back to the legacy root journal when the selected run journal is missing', async () => {
    const app = await build()
    fs.rmSync(runJournalPath, { force: true })
    const res = await app.inject({ method: 'GET', url: '/api/journal?run=r-bbbb' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as Array<{ iteration: number }>).map((b) => b.iteration)).toEqual([2])
  })

  it('shows legacy external-client run journals by inferring missing run and feature fields', async () => {
    const app = await build()
    const runDir = runDirFor(logsDir, 'r-external')
    const paths = buildRunPaths(runDir)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(paths.manifestPath, JSON.stringify({
      runId: 'r-external',
      feature: 'foo',
      startedAt: '2026-05-25T08:00:00.000Z',
      status: 'healing',
      healCycles: 2,
      services: [],
    }))
    fs.writeFileSync(paths.diagnosisJournalPath, `## Iteration 2

Hypothesis: route was not registered

Fix: enabled the module
`)

    const res = await app.inject({ method: 'GET', url: '/api/journal?feature=foo&run=r-external' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject([
      {
        iteration: 2,
        timestamp: null,
        run: 'r-external',
        feature: 'foo',
        body: expect.stringContaining('Fix: enabled the module'),
      },
    ])
  })

  it('falls back to the manifest featureName when feature is absent', async () => {
    const app = await build()
    const runDir = runDirFor(logsDir, 'r-legacy-name')
    const paths = buildRunPaths(runDir)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(paths.manifestPath, JSON.stringify({
      runId: 'r-legacy-name',
      featureName: 'bar',
      startedAt: '2026-05-25T08:00:00.000Z',
      status: 'healing',
      healCycles: 0,
      services: [],
    }))
    fs.writeFileSync(paths.diagnosisJournalPath, `## Iteration 7

Hypothesis: stale build artifact

Fix: cleared the cache
`)

    const res = await app.inject({ method: 'GET', url: '/api/journal?feature=bar&run=r-legacy-name' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject([
      {
        iteration: 7,
        run: 'r-legacy-name',
        feature: 'bar',
      },
    ])
  })

  it('rejects path-like run ids without reading the root journal', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/journal?run=..%2Fsecret' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('returns an empty list when no run or legacy journal is selected', async () => {
    const app = await buildWithoutLegacyJournal()
    const res = await app.inject({ method: 'GET', url: '/api/journal' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})

describe('DELETE /api/journal/:iteration', () => {
  it('removes the section atomically and 204s', async () => {
    const app = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/journal/1?run=r-bbbb' })
    expect(res.statusCode).toBe(204)
    expect(fs.readFileSync(runJournalPath, 'utf-8')).not.toContain('## Iteration 1')
    expect(fs.readFileSync(journalPath, 'utf-8')).toContain('## Iteration 1')
  })

  it('removes a matching legacy root section when the selected run journal is missing', async () => {
    const app = await build()
    fs.rmSync(runJournalPath, { force: true })
    const res = await app.inject({ method: 'DELETE', url: '/api/journal/2?run=r-bbbb' })
    expect(res.statusCode).toBe(204)
    expect(fs.existsSync(runJournalPath)).toBe(false)
    expect(fs.readFileSync(journalPath, 'utf-8')).not.toContain('## Iteration 2')
    expect(fs.readFileSync(journalPath, 'utf-8')).toContain('## Iteration 1')
  })

  it('400s on non-numeric iteration', async () => {
    const app = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/journal/abc' })
    expect(res.statusCode).toBe(400)
  })

  it('400s when deleting without a run and no legacy journal is configured', async () => {
    const app = await buildWithoutLegacyJournal()
    const res = await app.inject({ method: 'DELETE', url: '/api/journal/1' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'run is required' })
  })

  it('404s when iteration not present', async () => {
    const app = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/journal/99' })
    expect(res.statusCode).toBe(404)
  })

  it('404s when the legacy fallback also lacks a matching iteration', async () => {
    const app = await build()
    fs.rmSync(runJournalPath, { force: true })
    // Iteration 99 does not exist in the legacy journal — the fallback check
    // runs but ultimately reports not found.
    const res = await app.inject({ method: 'DELETE', url: '/api/journal/99?run=r-bbbb' })
    expect(res.statusCode).toBe(404)
  })
})
