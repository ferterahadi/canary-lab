import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { featuresRoutes } from './features'
import type { PlaywrightListSpawner } from '../../runs/logic/playwright-list'
import { clearPlaywrightListCache } from '../../runs/logic/playwright-list'
import { DirtySpecStore } from '../../runs/logic/dirty-specs/store'

vi.mock('../../../shared/git-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/git-repo')>()
  return { ...actual, runGit: vi.fn(actual.runGit) }
})

import { runGit } from '../../../shared/git-repo'

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

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

async function build(opts: { spawner?: PlaywrightListSpawner; dirtySpecStore?: DirtySpecStore } = {}) {
  const app = Fastify()
  await app.register(featuresRoutes, {
    featuresDir,
    playwrightListSpawner: opts.spawner ?? failingSpawner,
    dirtySpecStore: opts.dirtySpecStore,
  })
  return app
}

describe('GET /api/features/:name/tests', () => {
  // A spec whose body is nested deeply enough to overflow the AST extractor's
  // recursive visitor. `extractTestsFromSource` catches the RangeError and
  // surfaces it as `parseError`, which lets us drive the route's parseError
  // branches with real source (the TS parser itself never throws on bad text).
  function deepNestedSpec(): string {
    const open = '('.repeat(2000)
    const close = ')'.repeat(2000)
    return `test('deep', async () => { const a = ${open}x${close} })\n`
  }

  it('surfaces parseError when Playwright returns no entries for the spec', async () => {
    writeFeature('deepnone', { spec: deepNestedSpec() })
    const spawner = jsonSpawner(() => ({ config: {}, suites: [] }))
    const app = await build({ spawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/deepnone/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ tests: unknown[]; parseError?: string }>
    expect(body[0].tests).toEqual([])
    expect(body[0].parseError).toBeTruthy()
  })

  it('surfaces parseError alongside Playwright-resolved entries', async () => {
    const dir = writeFeature('deepboth', { spec: deepNestedSpec() })
    const specFile = path.join(dir, 'e2e', 'a.spec.ts')
    const spawner = jsonSpawner(() => ({
      config: { rootDir: dir },
      suites: [{ file: specFile, specs: [{ title: 'deep', file: specFile, line: 1 }] }],
    }))
    const app = await build({ spawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/deepboth/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ tests: Array<{ name: string }>; parseError?: string }>
    expect(body[0].tests[0].name).toBe('deep')
    expect(body[0].parseError).toBeTruthy()
  })

  it('reuses a single AST extraction for multiple helper-defined entries sharing an origin file', async () => {
    // Two resolved tests originate from the same helper file. The second
    // entry must hit the "already AST-extracted this origin file" short-circuit.
    const dir = writeFeature('sharedhelper', {
      spec: "import { defineSpecs } from './helpers/factory'\ndefineSpecs()\n",
    })
    const wrapperSpec = path.join(dir, 'e2e', 'a.spec.ts')
    const helpersDir = path.join(dir, 'e2e', 'helpers')
    fs.mkdirSync(helpersDir, { recursive: true })
    const helperFile = path.join(helpersDir, 'factory.ts')
    fs.writeFileSync(
      helperFile,
      [
        "import { test } from '@playwright/test'",
        "export function defineSpecs() {",
        "  test('first inner', async () => {})",
        "  test('second inner', async () => {})",
        "}",
      ].join('\n'),
    )
    const spawner = jsonSpawner(() => ({
      config: { rootDir: dir },
      suites: [
        {
          file: wrapperSpec,
          suites: [
            {
              file: helperFile,
              specs: [
                { title: 'first inner', file: helperFile, line: 3 },
                { title: 'second inner', file: helperFile, line: 4 },
              ],
            },
          ],
        },
      ],
    }))
    const app = await build({ spawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/sharedhelper/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ tests: Array<{ name: string; sourceFile?: string }> }>
    expect(body[0].tests.map((t) => t.name)).toEqual(['first inner', 'second inner'])
    expect(body[0].tests[0].sourceFile).toBe(helperFile)
    expect(body[0].tests[1].sourceFile).toBe(helperFile)
  })

  it('returns an empty env (no envName) when the first feature env is undefined', async () => {
    // A feature with no declared envs => feature.envs?.[0] is undefined =>
    // envsetProcessEnv short-circuits to {} without touching any envset config.
    const dir = path.join(featuresDir, 'noenvs')
    fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'noenvs', description: 'd', featureDir: __dirname } }`,
    )
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), "test('plain', async () => {})\n")
    const app = await build({ spawner: failingSpawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/noenvs/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ tests: Array<{ name: string }> }>
    expect(body[0].tests[0].name).toBe('plain')
  })

  it('skips envset slot files that do not exist on disk', async () => {
    const dir = writeFeature('missingslot', {
      spec: "test('plain', async () => {})\n",
    })
    const envsetsDir = path.join(dir, 'envsets')
    fs.mkdirSync(path.join(envsetsDir, 'local'), { recursive: true })
    // Valid config that declares a slot, but the slot file is absent under
    // envsets/local/, so envsetProcessEnv hits the `continue` (skip) branch.
    fs.writeFileSync(
      path.join(envsetsDir, 'envsets.config.json'),
      JSON.stringify({
        slots: { 'feature.env': { description: 'feature env', target: '/tmp/x' } },
        feature: { slots: ['feature.env'] },
      }),
    )
    const app = await build({ spawner: failingSpawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/missingslot/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ tests: Array<{ name: string }> }>
    expect(body[0].tests[0].name).toBe('plain')
  })

  it('ignores envset config that fails to load (malformed JSON)', async () => {
    const dir = writeFeature('brokenjson', {
      spec: "test('plain', async () => {})\n",
    })
    const envsetsDir = path.join(dir, 'envsets')
    fs.mkdirSync(envsetsDir, { recursive: true })
    // loadConfig throws on invalid JSON => the catch (err) { warn; return {} }
    // branch runs and listing still succeeds.
    fs.writeFileSync(path.join(envsetsDir, 'envsets.config.json'), '{ not valid json ')
    const app = await build({ spawner: failingSpawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/brokenjson/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ tests: Array<{ name: string }> }>
    expect(body[0].tests[0].name).toBe('plain')
  })

  it('ignores envset config whose feature.slots entries are not all strings', async () => {
    const dir = writeFeature('badslots', {
      spec: "test('plain', async () => {})\n",
    })
    const envsetsDir = path.join(dir, 'envsets')
    fs.mkdirSync(envsetsDir, { recursive: true })
    // Valid JSON, valid `slots` object, but feature.slots contains a non-string
    // => isEnvSetsConfig returns false => warn + return {}.
    fs.writeFileSync(
      path.join(envsetsDir, 'envsets.config.json'),
      JSON.stringify({ slots: { 'feature.env': {} }, feature: { slots: [123] } }),
    )
    const app = await build({ spawner: failingSpawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/badslots/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ tests: Array<{ name: string }> }>
    expect(body[0].tests[0].name).toBe('plain')
  })
})
