import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { featuresRoutes } from './features'
import type { PlaywrightListSpawner } from '../lib/playwright-list'
import { clearPlaywrightListCache } from '../lib/playwright-list'

let tmpDir: string
let featuresDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-froutes-')))
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
  clearPlaywrightListCache()
})

function writeFeature(name: string, opts: { spec?: string; specName?: string } = {}): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: {
      name: ${JSON.stringify(name)},
      description: 'desc',
      envs: ['local'],
      repos: [{ name: 'repo1', localPath: __dirname }],
      featureDir: __dirname,
    } }`,
  )
  if (opts.spec !== undefined) {
    const e2eDir = path.join(dir, 'e2e')
    fs.mkdirSync(e2eDir, { recursive: true })
    fs.writeFileSync(path.join(e2eDir, opts.specName ?? 'a.spec.ts'), opts.spec)
  }
  return dir
}

// A spawner that prints canned JSON via `node -e` so the production code path
// (spawn → parse stdout) is exercised end-to-end without needing real
// playwright installed in the tmp dir.
function jsonSpawner(buildReport: (featureDir: string) => unknown): PlaywrightListSpawner {
  return (featureDir) => {
    const json = JSON.stringify(buildReport(featureDir))
    return {
      command: 'node',
      args: ['-e', `process.stdout.write(${JSON.stringify(json)})`],
      cwd: featureDir,
    }
  }
}

// Spawner that simulates Playwright failing to discover (non-zero exit). Used
// by tests that don't care about the playwright-list integration so they fall
// back to the AST-only path (current behaviour).
const failingSpawner: PlaywrightListSpawner = (featureDir) => ({
  command: 'node',
  args: ['-e', 'process.exit(1)'],
  cwd: featureDir,
})

async function build(opts: { spawner?: PlaywrightListSpawner } = {}) {
  const app = Fastify()
  await app.register(featuresRoutes, {
    featuresDir,
    playwrightListSpawner: opts.spawner ?? failingSpawner,
  })
  return app
}

describe('GET /api/features', () => {
  it('returns the list of discovered features', async () => {
    writeFeature('alpha')
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ name: 'alpha', description: 'desc', envs: ['local'] })
    expect(body[0].repos).toHaveLength(1)
  })

  it('substitutes empty arrays when a feature has no repos / envs declared', async () => {
    const dir = path.join(featuresDir, 'sparse')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'sparse', description: 'd', featureDir: __dirname } }`,
    )
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features' })
    const body = res.json() as Array<{ repos: unknown[]; envs: unknown[] }>
    expect(body[0].repos).toEqual([])
    expect(body[0].envs).toEqual([])
  })

  it('returns [] when no features exist', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features' })
    expect(res.json()).toEqual([])
  })
})

describe('GET /api/features/:name/config', () => {
  it('iterates through candidate file extensions and returns the .js variant', async () => {
    const dir = path.join(featuresDir, 'jsfeat')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.js'),
      `module.exports = { config: { name: 'jsfeat', description: 'd', envs: [], featureDir: __dirname } }`,
    )
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/jsfeat/config' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { format: string }).format).toBe('js')
  })

  it('returns the cjs config file content', async () => {
    writeFeature('alpha')
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/config' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { format: string; content: string }
    expect(body.format).toBe('cjs')
    expect(body.content).toContain("name: \"alpha\"")
  })

  it('404s for an unknown feature', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/missing/config' })
    expect(res.statusCode).toBe(404)
  })

  it('404s when the feature dir has no config file', async () => {
    // Create a feature, then delete the config file but keep the dir.
    const dir = writeFeature('beta')
    fs.unlinkSync(path.join(dir, 'feature.config.cjs'))
    // loadFeatures keys off the config file, so the route returns
    // "feature not found" — still 404, which is the branch we want.
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/beta/config' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/features/:name/tests', () => {
  it('parses spec files and returns tests with steps (AST fallback)', async () => {
    writeFeature('alpha', {
      spec: `
        test('first', async () => {
          await test.step('one', async () => {})
          await test.step('two', async () => {})
        })
      `,
    })
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].tests[0].name).toBe('first')
    expect(body[0].tests[0].steps.map((s: { label: string }) => s.label)).toEqual(['one', 'two'])
  })

  it('returns [] when feature has no e2e dir', async () => {
    writeFeature('alpha')
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/tests' })
    expect(res.json()).toEqual([])
  })

  it('404s on unknown feature', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/missing/tests' })
    expect(res.statusCode).toBe(404)
  })

  it('handles a feature with a malformed spec gracefully', async () => {
    const dir = writeFeature('alpha', { spec: '???? not really typescript ::' })
    expect(fs.existsSync(path.join(dir, 'e2e', 'a.spec.ts'))).toBe(true)
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].tests).toEqual([])
  })

  it('falls back to AST-only tests when Playwright list returns no entries for the spec', async () => {
    writeFeature('emptylist', {
      spec: "test('only', async () => {})\n",
    })
    const spawner = jsonSpawner(() => ({ config: {}, suites: [] }))
    const app = await build({ spawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/emptylist/tests' })
    const body = res.json() as Array<{ tests: Array<{ name: string }> }>
    expect(body[0].tests.map((t) => t.name)).toEqual(['only'])
  })

  it('falls back to defaults when a Playwright entry has no matching AST line', async () => {
    const dir = writeFeature('orphan', {
      spec: "test('first', async () => {})\n",
    })
    const specFile = path.join(dir, 'e2e', 'a.spec.ts')
    // The pw spec reports line 99 which has no AST entry, so the route must
    // fall back to bodySource=''/steps=[] for this entry.
    const spawner = jsonSpawner(() => ({
      config: { rootDir: dir },
      suites: [
        {
          file: specFile,
          specs: [{ title: 'first', file: specFile, line: 99 }],
        },
      ],
    }))
    const app = await build({ spawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/orphan/tests' })
    const body = res.json() as Array<{ tests: Array<{ name: string; bodySource: string; steps: unknown[] }> }>
    expect(body[0].tests[0].bodySource).toBe('')
    expect(body[0].tests[0].steps).toEqual([])
  })

  it('expands loop-generated tests using Playwright --list output', async () => {
    const dir = writeFeature('alpha', {
      spec: [
        "const keys = ['a', 'b', 'c'] as const",
        "for (const key of keys) {",
        "  test(`runs ${key} case`, async () => {",
        "    await test.step('inner', async () => {})",
        "  })",
        "}",
        "test('plain', async () => {})",
      ].join('\n'),
    })
    const specFile = path.join(dir, 'e2e', 'a.spec.ts')
    const spawner = jsonSpawner(() => ({
      config: { rootDir: dir },
      suites: [
        {
          file: specFile,
          specs: [
            { title: 'runs a case', file: specFile, line: 3 },
            { title: 'runs b case', file: specFile, line: 3 },
            { title: 'runs c case', file: specFile, line: 3 },
            { title: 'plain', file: specFile, line: 7 },
          ],
        },
      ],
    }))
    const app = await build({ spawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    const tests = body[0].tests as Array<{ name: string; line: number; steps: { label: string }[]; bodySource: string }>
    expect(tests.map((t) => t.name)).toEqual(['runs a case', 'runs b case', 'runs c case', 'plain'])
    // Loop iterations all share the same call-site body/steps.
    expect(tests[0].line).toBe(3)
    expect(tests[1].line).toBe(3)
    expect(tests[2].line).toBe(3)
    expect(tests[0].steps.map((s) => s.label)).toEqual(['inner'])
    expect(tests[0].bodySource).toBe(tests[1].bodySource)
    expect(tests[0].bodySource).not.toBe('')
    // Standalone test still surfaced.
    expect(tests[3].line).toBe(7)
    expect(tests[3].steps).toEqual([])
  })

  it('falls back to AST output (raw template text) when Playwright --list fails', async () => {
    writeFeature('alpha', {
      spec: [
        "const keys = ['a', 'b'] as const",
        "for (const key of keys) {",
        "  test(`runs ${key} case`, async () => {})",
        "}",
      ].join('\n'),
    })
    const app = await build({ spawner: failingSpawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Without playwright-list expansion we still surface the call site, with
    // the raw `${key}` placeholder so the user at least sees something.
    expect(body[0].tests).toHaveLength(1)
    expect(body[0].tests[0].name).toBe('runs ${key} case')
  })
})
