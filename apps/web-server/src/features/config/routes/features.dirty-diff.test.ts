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

describe('GET /api/features/:name/dirty-diff', () => {
  const COMMITTED = `test('applies voucher', async () => { expect(1).toBe(1) })\ntest('other', async () => { expect(2).toBe(2) })\n`
  const EDITED = `test('applies voucher', async () => { expect(1).toBe(2) })\ntest('other', async () => { expect(2).toBe(2) })\n`

  it('flags only the changed test, with its changed line, against the HEAD body', async () => {
    const dir = writeFeature('alpha', { spec: COMMITTED })
    git(dir, ['init', '-q'])
    git(dir, ['config', 'user.email', 't@t.dev'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'baseline'])
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), EDITED)

    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/dirty-diff?file=e2e/a.spec.ts' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { tests: { name: string; changedLines: number[] }[] }
    expect(body.tests).toHaveLength(1)
    expect(body.tests[0].name).toBe('applies voucher')
    expect(body.tests[0].changedLines.length).toBeGreaterThan(0)
  })

  it('returns no tests when the feature has no git repo', async () => {
    writeFeature('nogit', { spec: COMMITTED })
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/nogit/dirty-diff?file=e2e/a.spec.ts' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { tests: unknown[] }).tests).toEqual([])
  })

  it('returns no tests when the file has never been committed', async () => {
    const dir = writeFeature('uncommitted', { spec: COMMITTED })
    git(dir, ['init', '-q'])
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/uncommitted/dirty-diff?file=e2e/a.spec.ts' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { tests: unknown[] }).tests).toEqual([])
  })

  it('flags every line of a test added since the last commit', async () => {
    const dir = writeFeature('alpha', { spec: COMMITTED })
    git(dir, ['init', '-q'])
    git(dir, ['config', 'user.email', 't@t.dev'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'baseline'])
    fs.writeFileSync(
      path.join(dir, 'e2e', 'a.spec.ts'),
      `${COMMITTED}test('brand new', async () => { expect(3).toBe(3) })\n`,
    )

    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/dirty-diff?file=e2e/a.spec.ts' })
    const body = res.json() as { tests: { name: string; changedLines: number[] }[] }
    expect(body.tests).toHaveLength(1)
    expect(body.tests[0].name).toBe('brand new')
  })

  it('omits an empty-body test added since the last commit (no lines to flag)', async () => {
    const dir = writeFeature('alpha', { spec: COMMITTED })
    git(dir, ['init', '-q'])
    git(dir, ['config', 'user.email', 't@t.dev'])
    git(dir, ['config', 'user.name', 'test'])
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'baseline'])
    fs.writeFileSync(
      path.join(dir, 'e2e', 'a.spec.ts'),
      `${COMMITTED}test('brand new empty')\n`,
    )

    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/dirty-diff?file=e2e/a.spec.ts' })
    const body = res.json() as { tests: { name: string; changedLines: number[] }[] }
    expect(body.tests.find((t) => t.name === 'brand new empty')).toBeUndefined()
  })

  it('400s without a file query param', async () => {
    writeFeature('alpha', { spec: COMMITTED })
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/dirty-diff' })
    expect(res.statusCode).toBe(400)
  })

  it('404s for an unknown feature', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/missing/dirty-diff?file=e2e/a.spec.ts' })
    expect(res.statusCode).toBe(404)
  })
})

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
    expect(body[0].tests[0].readable).toEqual(expect.objectContaining({
      title: 'first',
      completeness: 'complete',
      nodes: [
        expect.objectContaining({ kind: 'group', text: 'one', children: [] }),
        expect.objectContaining({ kind: 'group', text: 'two', children: [] }),
      ],
    }))
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

  it('ignores malformed envset config and still returns spec tests', async () => {
    const dir = writeFeature('badenv', {
      spec: `
        test('env shape does not block listing', async () => {
          await test.step('visible step', async () => {})
        })
      `,
    })
    fs.mkdirSync(path.join(dir, 'envsets'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'envsets', 'envsets.config.json'),
      JSON.stringify({ envsets: { local: { files: ['envsets/local/badenv.env'] } } }),
    )

    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/badenv/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].tests[0].name).toBe('env shape does not block listing')
    expect(body[0].tests[0].steps.map((s: { label: string }) => s.label)).toEqual(['visible step'])
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
    const body = res.json() as Array<{
      tests: Array<{ name: string; bodySource: string; steps: unknown[]; readable: { title: string; completeness: string; nodes: unknown[] } }>
    }>
    expect(body[0].tests[0].bodySource).toBe('')
    expect(body[0].tests[0].steps).toEqual([])
    expect(body[0].tests[0].readable).toEqual(expect.objectContaining({
      title: 'first',
      completeness: 'complete',
      nodes: [],
    }))
  })

  it('falls back to the helper source location when its Playwright line has no AST match', async () => {
    const dir = writeFeature('orphanhelper', {
      spec: "import { defineSpecs } from './helpers/factory'\ndefineSpecs()\n",
    })
    const wrapperSpec = path.join(dir, 'e2e', 'a.spec.ts')
    const helpersDir = path.join(dir, 'e2e', 'helpers')
    fs.mkdirSync(helpersDir, { recursive: true })
    const helperFile = path.join(helpersDir, 'factory.ts')
    fs.writeFileSync(helperFile, "export function defineSpecs() {}\n")
    const spawner = jsonSpawner(() => ({
      config: { rootDir: dir },
      suites: [{
        file: wrapperSpec,
        suites: [{
          file: helperFile,
          specs: [{ title: 'generated inner', file: helperFile, line: 99 }],
        }],
      }],
    }))
    const app = await build({ spawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/orphanhelper/tests' })
    const body = res.json() as Array<{
      tests: Array<{
        line: number
        bodyLine?: number
        sourceFile?: string
        readable: { title: string; nodes: unknown[] }
      }>
    }>

    expect(body[0].tests[0]).toEqual(expect.objectContaining({
      line: 99,
      bodyLine: 99,
      sourceFile: helperFile,
    }))
    expect(body[0].tests[0].readable).toEqual(expect.objectContaining({
      title: 'generated inner',
      nodes: [],
    }))
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
    const tests = body[0].tests as Array<{
      name: string
      line: number
      steps: { label: string }[]
      bodySource: string
      readable: { title: string; nodes: unknown[] }
    }>
    expect(tests.map((t) => t.name)).toEqual(['runs a case', 'runs b case', 'runs c case', 'plain'])
    // Loop iterations all share the same call-site body/steps.
    expect(tests[0].line).toBe(3)
    expect(tests[1].line).toBe(3)
    expect(tests[2].line).toBe(3)
    expect(tests[0].steps.map((s) => s.label)).toEqual(['inner'])
    expect(tests[0].bodySource).toBe(tests[1].bodySource)
    expect(tests[0].bodySource).not.toBe('')
    expect(tests.slice(0, 3).map((test) => test.readable.title)).toEqual(['runs a case', 'runs b case', 'runs c case'])
    expect(tests[0].readable.nodes).toEqual(tests[1].readable.nodes)
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
    expect(body[0].tests[0].readable.title).toBe('runs ${key} case')
  })

  it('attributes helper-defined tests to the entry-point spec with body from the helper file', async () => {
    // Mirrors the `defineLocaleSpec` pattern: the spec file is a one-liner
    // that calls a helper, and the helper holds the real `test(...)` body.
    // Without origin-file enrichment, the helper-generated tests would be
    // dropped (bucketed under the helper path, which is not a spec file).
    const dir = writeFeature('factory', {
      // Wrapper spec body is irrelevant — the AST extractor finds no tests
      // here because `defineSpec(...)` is just a function call.
      spec: "import { defineSpec } from './helpers/factory'\ndefineSpec()\n",
    })
    const wrapperSpec = path.join(dir, 'e2e', 'a.spec.ts')
    const helpersDir = path.join(dir, 'e2e', 'helpers')
    fs.mkdirSync(helpersDir, { recursive: true })
    const helperFile = path.join(helpersDir, 'factory.ts')
    // Real `test(...)` body lives here. Line numbers must match the JSON
    // we feed the spawner below (test on line 4, step on line 5).
    fs.writeFileSync(
      helperFile,
      [
        "import { test } from '@playwright/test'",
        "export function defineSpec() {",
        "  test.describe('matrix', () => {",
        "    test('inner case', async () => {",
        "      await test.step('inner-step', async () => {})",
        "    })",
        "  })",
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
              title: 'matrix',
              specs: [{ title: 'inner case', file: helperFile, line: 4 }],
            },
          ],
        },
      ],
    }))
    const app = await build({ spawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/factory/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{
      file: string
      tests: Array<{
        name: string
        line: number
        bodySource: string
        sourceFile?: string
        steps: Array<{ label: string }>
        readable: { title: string; nodes: Array<{ kind: string; text: string; source: { file: string; startLine: number } }> }
      }>
    }>
    // Only the wrapper spec is returned by `listSpecFiles` (helpers/ is
    // ignored). The helper-defined test must show up under the wrapper.
    expect(body).toHaveLength(1)
    expect(body[0].file).toBe(wrapperSpec)
    expect(body[0].tests).toHaveLength(1)
    const t = body[0].tests[0]
    expect(t.name).toBe('inner case')
    expect(t.line).toBe(4)
    expect(t.sourceFile).toBe(helperFile)
    expect(t.bodySource).toContain("test.step('inner-step'")
    expect(t.steps.map((s) => s.label)).toEqual(['inner-step'])
    expect(t.readable.title).toBe('inner case')
    expect(t.readable.nodes[0]).toEqual(expect.objectContaining({
      kind: 'group',
      text: 'inner-step',
      source: expect.objectContaining({ file: helperFile, startLine: 5 }),
    }))
  })

  it('passes the first feature envset into Playwright list without applying files', async () => {
    const dir = writeFeature('alpha', {
      spec: "test('placeholder', async () => {})\n",
    })
    const specFile = path.join(dir, 'e2e', 'a.spec.ts')
    const envsetsDir = path.join(dir, 'envsets')
    fs.mkdirSync(path.join(envsetsDir, 'local'), { recursive: true })
    fs.writeFileSync(
      path.join(envsetsDir, 'envsets.config.json'),
      JSON.stringify({
        appRoots: { ROOT: tmpDir },
        slots: {
          'feature.env': {
            description: 'feature env',
            target: '$ROOT/features/alpha/.env',
          },
        },
        feature: {
          slots: ['feature.env'],
          testCommand: 'yarn test:e2e',
          testCwd: '$ROOT/features/alpha',
        },
      }),
    )
    fs.writeFileSync(path.join(envsetsDir, 'local', 'feature.env'), 'SHOP_TEST_PRODUCT_ID=expanded-from-envset\n')
    fs.writeFileSync(path.join(dir, '.env'), 'SHOP_TEST_PRODUCT_ID=stale-on-disk\n')

    const spawner: PlaywrightListSpawner = (featureDir) => ({
      command: 'node',
      args: ['-e', `
        process.stdout.write(JSON.stringify({
          config: { rootDir: ${JSON.stringify(dir)} },
          suites: [{
            file: ${JSON.stringify(specFile)},
            specs: [{
              title: process.env.SHOP_TEST_PRODUCT_ID,
              file: ${JSON.stringify(specFile)},
              line: 1
            }]
          }]
        }))
      `],
      cwd: featureDir,
    })

    const app = await build({ spawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ tests: Array<{ name: string }> }>
    expect(body[0].tests[0].name).toBe('expanded-from-envset')
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toBe('SHOP_TEST_PRODUCT_ID=stale-on-disk\n')
  })

  it('surfaces parseError on the AST-fallback path when Playwright --list fails', async () => {
    writeFeature('deepfb', { spec: deepNestedSpec() })
    const app = await build({ spawner: failingSpawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/deepfb/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ tests: unknown[]; parseError?: string }>
    expect(body[0].tests).toEqual([])
    expect(body[0].parseError).toBeTruthy()
  })
})
