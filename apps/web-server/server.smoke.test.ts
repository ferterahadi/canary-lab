import { describe, it, expect } from 'vitest'
import path from 'path'
import { createServer } from './server'

// Smoke test: exercises createServer() against the real templates/project
// tree, hitting every read-side endpoint via inject(). Lives next to the
// bootstrap so it doubles as the manual boot check evidence — running
// `npx vitest run apps/web-server/server.smoke.test.ts` is the closest we
// can get to a real boot inside the sandbox.

describe('createServer smoke (templates/project)', () => {
  it('binds to a real port and answers a request over HTTP', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot })
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      // Fastify returns "http://127.0.0.1:<port>".
      const res = await fetch(`${address}/api/features`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Array<{ name: string }>
      expect(body.map((f) => f.name).sort()).toEqual(
        expect.arrayContaining(['broken_todo_api', 'example_todo_api']),
      )
    } finally {
      await app.close()
    }
  })

  it('serves all read-side endpoints', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot })
    try {
      const features = await app.inject({ method: 'GET', url: '/api/features' })
      expect(features.statusCode).toBe(200)
      const featuresJson = features.json() as Array<{ name: string }>
      const names = featuresJson.map((f) => f.name).sort()
      expect(names).toContain('example_todo_api')
      expect(names).toContain('broken_todo_api')

      const tests = await app.inject({
        method: 'GET',
        url: '/api/features/example_todo_api/tests',
      })
      expect(tests.statusCode).toBe(200)
      const testsJson = tests.json() as Array<{ file: string; tests: unknown[] }>
      expect(testsJson.length).toBeGreaterThan(0)

      const runs = await app.inject({ method: 'GET', url: '/api/runs' })
      expect(runs.statusCode).toBe(200)
      expect(Array.isArray(runs.json())).toBe(true)

      const journal = await app.inject({ method: 'GET', url: '/api/journal' })
      expect(journal.statusCode).toBe(200)
      expect(Array.isArray(journal.json())).toBe(true)

      const unknown = await app.inject({ method: 'GET', url: '/api/runs/zzz' })
      expect(unknown.statusCode).toBe(404)

      const unknownFeature = await app.inject({
        method: 'GET',
        url: '/api/features/nope/tests',
      })
      expect(unknownFeature.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})
