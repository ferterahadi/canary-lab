import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'

// Old persisted/external extractor entries predate `bodyLine`. The route still
// accepts that compatible shape, so pin its fallback to the test call's line
// rather than making legacy code display from row 1.
vi.mock('../../../shared/ast-extractor', async (importActual) => {
  const actual = await importActual<typeof import('../../../shared/ast-extractor')>()
  return {
    ...actual,
    extractTestsFromSource: vi.fn((file: string) => ({
      file,
      tests: [{
        name: 'legacy test',
        line: 7,
        bodySource: 'await page.goto("/")',
        steps: [],
        readable: {} as never,
      }],
    })),
  }
})

import { featuresRoutes } from './features'

describe('GET /api/features/:name/tests legacy AST entries', () => {
  it('uses the test line when bodyLine is absent', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-features-legacy-')))
    try {
      const featuresDir = path.join(root, 'features')
      const featureDir = path.join(featuresDir, 'legacy')
      fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
      fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), `module.exports = { config: { name: 'legacy', description: 'd', envs: [], featureDir: __dirname } }`)
      fs.writeFileSync(path.join(featureDir, 'e2e', 'legacy.spec.ts'), 'test("legacy test", async () => {})')
      const app = Fastify()
      await app.register(featuresRoutes, {
        featuresDir,
        playwrightListSpawner: () => ({ command: 'node', args: ['-e', 'process.exit(1)'], cwd: featureDir }),
      })

      const response = await app.inject({ method: 'GET', url: '/api/features/legacy/tests' })
      const body = response.json() as Array<{ tests: Array<{ codeDisplay: { lineMap: Array<{ sourceLine: number }> } }> }>
      expect(response.statusCode).toBe(200)
      expect(body[0].tests[0].codeDisplay.lineMap[0].sourceLine).toBe(7)
      await app.close()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
