import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { featuresRoutes } from './features'
import type { PlaywrightListSpawner } from '../../runs/logic/playwright-list'
import { clearPlaywrightListCache } from '../../runs/logic/playwright-list'

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
    // No saved overlay → not portified.
    expect(body[0].portified).toBe(false)
  })

  it('flags portified=true when the feature has a saved port overlay', async () => {
    const dir = writeFeature('ported')
    const overlayDir = path.join(dir, 'portify')
    fs.mkdirSync(overlayDir, { recursive: true })
    fs.writeFileSync(path.join(overlayDir, 'repo1.patch'), 'diff --git a/x b/x\n')
    fs.writeFileSync(path.join(overlayDir, 'meta.json'), JSON.stringify({
      version: 1, featureName: 'ported', agent: 'claude', capturedAt: 't',
      repos: [{ name: 'repo1', baseSha: 's', patch: 'repo1.patch', touchedFiles: [] }],
    }))
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features' })
    const body = res.json() as Array<{ name: string; portified: boolean }>
    expect(body.find((f) => f.name === 'ported')?.portified).toBe(true)
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

  it('404s with "config file not found" when the feature loads but its featureDir has no config file', async () => {
    // The config lives in the feature's own dir (so loadFeatures finds it),
    // but `featureDir` points at a sibling dir that holds NO config file.
    // The route resolves the feature, then fails the candidate-file scan.
    const dir = path.join(featuresDir, 'detached')
    const emptyDir = path.join(tmpDir, 'no-config-here')
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(emptyDir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'detached', description: 'd', envs: [], featureDir: ${JSON.stringify(emptyDir)} } }`,
    )
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/detached/config' })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: string }).error).toBe('config file not found')
  })
})

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
      tests: Array<{ name: string; line: number; bodySource: string; sourceFile?: string; steps: Array<{ label: string }> }>
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

  // A spec whose body is nested deeply enough to overflow the AST extractor's
  // recursive visitor. `extractTestsFromSource` catches the RangeError and
  // surfaces it as `parseError`, which lets us drive the route's parseError
  // branches with real source (the TS parser itself never throws on bad text).
  function deepNestedSpec(): string {
    const open = '('.repeat(2000)
    const close = ')'.repeat(2000)
    return `test('deep', async () => { const a = ${open}x${close} })\n`
  }

  it('surfaces parseError on the AST-fallback path when Playwright --list fails', async () => {
    writeFeature('deepfb', { spec: deepNestedSpec() })
    const app = await build({ spawner: failingSpawner })
    const res = await app.inject({ method: 'GET', url: '/api/features/deepfb/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ tests: unknown[]; parseError?: string }>
    expect(body[0].tests).toEqual([])
    expect(body[0].parseError).toBeTruthy()
  })

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
