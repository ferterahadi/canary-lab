import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { journalRoutes } from './journal'

let tmpDir: string
let journalPath: string

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
  journalPath = path.join(tmpDir, 'diagnosis-journal.md')
  fs.writeFileSync(journalPath, SAMPLE)
})

async function build() {
  const app = Fastify()
  await app.register(journalRoutes, { journalPath })
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
})

describe('DELETE /api/journal/:iteration', () => {
  it('removes the section atomically and 204s', async () => {
    const app = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/journal/1' })
    expect(res.statusCode).toBe(204)
    expect(fs.readFileSync(journalPath, 'utf-8')).not.toContain('## Iteration 1')
  })

  it('400s on non-numeric iteration', async () => {
    const app = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/journal/abc' })
    expect(res.statusCode).toBe(400)
  })

  it('404s when iteration not present', async () => {
    const app = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/journal/99' })
    expect(res.statusCode).toBe(404)
  })
})
