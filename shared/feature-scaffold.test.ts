import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyFeatureScaffold,
  buildFeatureScaffold,
  buildFeatureSkeletonScaffold,
  canonicalScaffoldPaths,
  skeletonScaffoldPaths,
  validateGeneratedFeatureFiles,
  validateGeneratedSpecFiles,
} from './feature-scaffold'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-scaffold-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('buildFeatureScaffold', () => {
  it('produces the canonical deterministic file set', () => {
    const files = buildFeatureScaffold({ featureName: 'demo_login', description: 'Demo login' })
    expect(files.map((file) => file.path)).toEqual(canonicalScaffoldPaths('demo_login'))
    expect(files.find((file) => file.path === 'feature.config.cjs')?.content).toContain("name: 'demo_login'")
    expect(files.find((file) => file.path === 'playwright.config.ts')?.content).toContain('baseConfig')
  })

  it('can build the external-client skeleton without generated specs', () => {
    const files = buildFeatureSkeletonScaffold({
      featureName: 'demo_login',
      description: 'Demo login',
      envs: ['local', 'staging'],
      repos: [{ name: 'api', localPath: '/repos/api', branch: 'main' }],
    })

    expect(files.map((file) => file.path)).toEqual(skeletonScaffoldPaths('demo_login'))
    expect(files.some((file) => file.path.endsWith('.spec.ts'))).toBe(false)
    expect(files.find((file) => file.path === 'feature.config.cjs')?.content).toContain("envs: ['local', 'staging']")
    expect(files.find((file) => file.path === 'feature.config.cjs')?.content).toContain("name: 'api'")
  })
})

describe('validateGeneratedFeatureFiles', () => {
  it('accepts the default scaffold', () => {
    expect(validateGeneratedFeatureFiles('demo_login', buildFeatureScaffold({ featureName: 'demo_login' }))).toEqual({ ok: true })
  })

  it('rejects invalid feature names', () => {
    const r = validateGeneratedFeatureFiles('bad name', buildFeatureScaffold({ featureName: 'bad_name' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('invalid feature name')
  })

  it('rejects generated files outside the feature directory', () => {
    const files = buildFeatureScaffold({ featureName: 'demo_login' })
    files.push({ path: '../escape.ts', content: 'x' })
    const r = validateGeneratedFeatureFiles('demo_login', files)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('inside the feature directory')
  })

  it('rejects missing required scaffold files', () => {
    const files = buildFeatureScaffold({ featureName: 'demo_login' })
      .filter((file) => file.path !== 'playwright.config.ts')
    const r = validateGeneratedFeatureFiles('demo_login', files)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('missing required file "playwright.config.ts"')
  })

  it('rejects stale envsets config shape', () => {
    const files = buildFeatureScaffold({ featureName: 'demo_login' }).map((file) => (
      file.path === 'envsets/envsets.config.json'
        ? { ...file, content: JSON.stringify({ envsets: { local: {} } }) }
        : file
    ))
    const r = validateGeneratedFeatureFiles('demo_login', files)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('stale envsets shape')
  })

  it('rejects specs that do not use the log marker fixture', () => {
    const files = buildFeatureScaffold({ featureName: 'demo_login' }).map((file) => (
      file.path.endsWith('.spec.ts')
        ? { ...file, content: "import { test } from '@playwright/test'\n" }
        : file
    ))
    const r = validateGeneratedFeatureFiles('demo_login', files)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('log-marker-fixture')
  })

  it('rejects an empty file set', () => {
    const r = validateGeneratedFeatureFiles('demo_login', [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('no generated files')
  })

  it('rejects duplicate generated paths', () => {
    // Two entries for one path means the later silently wins on write, so the
    // feature on disk would not be the one that was validated.
    const files = buildFeatureScaffold({ featureName: 'demo_login' })
    files.push({ path: 'feature.config.cjs', content: '// second copy' })
    const r = validateGeneratedFeatureFiles('demo_login', files)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('duplicate generated file "feature.config.cjs"')
  })

  it('rejects a scaffold with no e2e spec at all', () => {
    const files = buildFeatureScaffold({ featureName: 'demo_login' })
      .filter((file) => !file.path.endsWith('.spec.ts'))
    const r = validateGeneratedFeatureFiles('demo_login', files)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('missing required e2e/*.spec.ts file')
  })

  it('rejects a spec nested below e2e/', () => {
    // Playwright's testDir is `./e2e` and is not recursive here, so a nested
    // spec would be silently skipped rather than run.
    const files = buildFeatureScaffold({ featureName: 'demo_login' })
    files.push({
      path: 'e2e/nested/deep.spec.ts',
      content: "import { test } from 'canary-lab/feature-support/log-marker-fixture'\n",
    })
    const r = validateGeneratedFeatureFiles('demo_login', files)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('must live directly under e2e/')
  })

  it('rejects a feature.config.cjs that does not declare the expected fields', () => {
    const files = buildFeatureScaffold({ featureName: 'demo_login' }).map((file) => (
      file.path === 'feature.config.cjs'
        ? { ...file, content: "const config = { name: 'demo_login' }\nmodule.exports = { config }\n" }
        : file
    ))
    const r = validateGeneratedFeatureFiles('demo_login', files)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('feature.config.cjs must declare envs')
  })

  it('rejects envsets configs that are not a well-formed object', () => {
    const withEnvsets = (content: string) => buildFeatureScaffold({ featureName: 'demo_login' }).map((file) => (
      file.path === 'envsets/envsets.config.json' ? { ...file, content } : file
    ))
    const errorFor = (content: string): string => {
      const r = validateGeneratedFeatureFiles('demo_login', withEnvsets(content))
      expect(r.ok).toBe(false)
      return r.ok ? '' : r.error
    }

    expect(errorFor('{ not json')).toContain('invalid JSON')
    expect(errorFor('[]')).toBe('envsets/envsets.config.json must be an object')
    expect(errorFor(JSON.stringify({ slots: {}, feature: {} })))
      .toBe('envsets/envsets.config.json must declare appRoots object')
    expect(errorFor(JSON.stringify({ appRoots: {}, feature: {} })))
      .toBe('envsets/envsets.config.json must declare slots object')
    expect(errorFor(JSON.stringify({ appRoots: {}, slots: {} })))
      .toBe('envsets/envsets.config.json must declare feature object')
    expect(errorFor(JSON.stringify({ appRoots: {}, slots: {}, feature: {} })))
      .toBe('envsets feature.slots must be an array')
    expect(errorFor(JSON.stringify({ appRoots: {}, slots: {}, feature: { slots: [], testCommand: '  ' } })))
      .toBe('envsets feature.testCommand must be a non-empty string')
    expect(errorFor(JSON.stringify({ appRoots: {}, slots: {}, feature: { slots: [], testCommand: 'npx playwright test' } })))
      .toBe('envsets feature.testCwd must be a non-empty string')
  })

  it('rejects paths that are empty, absolute, or unnormalized', () => {
    const withExtra = (extra: { path: string; content: string }) => {
      const files = buildFeatureScaffold({ featureName: 'demo_login' })
      files.push(extra)
      const r = validateGeneratedFeatureFiles('demo_login', files)
      expect(r.ok).toBe(false)
      return r.ok ? '' : r.error
    }

    expect(withExtra({ path: '', content: 'x' })).toBe('file path empty')
    expect(withExtra({ path: '/etc/passwd', content: 'x' })).toContain('must be relative')
    // './e2e/x.ts' normalizes to 'e2e/x.ts' — accepting it would write a file
    // at a path other than the one that was validated.
    expect(withExtra({ path: './lib/helper.ts', content: 'x' })).toContain('must be normalized')
  })
})

describe('validateGeneratedSpecFiles', () => {
  it('accepts externally authored specs without requiring scaffold files', () => {
    expect(validateGeneratedSpecFiles([
      {
        path: 'e2e/login.spec.ts',
        content: "import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'\n",
      },
    ])).toEqual({ ok: true })
  })

  it('rejects external specs outside e2e', () => {
    const r = validateGeneratedSpecFiles([
      {
        path: 'tests/login.spec.ts',
        content: "import { test } from 'canary-lab/feature-support/log-marker-fixture'\n",
      },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('directly under e2e/')
  })

  it('rejects an empty set, duplicates, and a set with no spec at all', () => {
    expect(validateGeneratedSpecFiles([])).toEqual({ ok: false, error: 'no generated files' })

    const dup = validateGeneratedSpecFiles([
      { path: 'e2e/login.spec.ts', content: "import { test } from 'canary-lab/feature-support/log-marker-fixture'\n" },
      { path: 'e2e/login.spec.ts', content: '// second copy' },
    ])
    expect(dup).toEqual({ ok: false, error: 'duplicate generated file "e2e/login.spec.ts"' })

    // Non-spec files are allowed alongside specs, but on their own they mean
    // the generation produced no runnable test.
    expect(validateGeneratedSpecFiles([{ path: 'e2e/helpers.ts', content: 'export const x = 1\n' }]))
      .toEqual({ ok: false, error: 'missing required e2e/*.spec.ts file' })
  })

  it('rejects external specs that escape the feature directory or skip the fixture', () => {
    const escaped = validateGeneratedSpecFiles([{ path: '../evil.spec.ts', content: 'x' }])
    expect(escaped.ok).toBe(false)
    if (!escaped.ok) expect(escaped.error).toContain('inside the feature directory')

    const noFixture = validateGeneratedSpecFiles([
      { path: 'e2e/login.spec.ts', content: "import { test } from '@playwright/test'\n" },
    ])
    expect(noFixture.ok).toBe(false)
    if (!noFixture.ok) expect(noFixture.error).toContain('log-marker-fixture')
  })

  it('accepts a spec alongside non-spec helper files', () => {
    expect(validateGeneratedSpecFiles([
      { path: 'e2e/helpers.ts', content: 'export const x = 1\n' },
      { path: 'e2e/login.spec.ts', content: "import { test } from 'canary-lab/feature-support/log-marker-fixture'\n" },
    ])).toEqual({ ok: true })
  })
})

describe('applyFeatureScaffold', () => {
  it('writes the validated scaffold into features/<name>', () => {
    const r = applyFeatureScaffold({
      projectRoot: tmp,
      featureName: 'demo_login',
      files: buildFeatureScaffold({ featureName: 'demo_login' }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(fs.existsSync(path.join(r.featureDir, 'feature.config.cjs'))).toBe(true)
    expect(fs.existsSync(path.join(r.featureDir, 'playwright.config.ts'))).toBe(true)
  })

  it('refuses an invalid feature name before touching the filesystem', () => {
    const r = applyFeatureScaffold({
      projectRoot: tmp,
      featureName: 'bad name',
      files: buildFeatureScaffold({ featureName: 'bad_name' }),
    })
    expect(r).toEqual({ ok: false, error: 'invalid-name' })
    expect(fs.existsSync(path.join(tmp, 'features'))).toBe(false)
  })

  it('refuses to overwrite an existing feature directory', () => {
    // Writing into an existing feature would merge a generated scaffold on top
    // of hand-authored specs, so the caller has to rename or delete first.
    const featureDir = path.join(tmp, 'features', 'demo_login')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'keep.txt'), 'hand-written')

    const r = applyFeatureScaffold({
      projectRoot: tmp,
      featureName: 'demo_login',
      files: buildFeatureScaffold({ featureName: 'demo_login' }),
    })
    expect(r).toMatchObject({ ok: false, error: 'feature-exists' })
    expect(fs.readFileSync(path.join(featureDir, 'keep.txt'), 'utf8')).toBe('hand-written')
    expect(fs.existsSync(path.join(featureDir, 'feature.config.cjs'))).toBe(false)
  })

  it('refuses a file set that fails scaffold validation, writing nothing', () => {
    const r = applyFeatureScaffold({
      projectRoot: tmp,
      featureName: 'demo_login',
      files: buildFeatureScaffold({ featureName: 'demo_login' })
        .filter((file) => file.path !== 'playwright.config.ts'),
    })
    expect(r).toMatchObject({ ok: false, error: 'invalid-scaffold' })
    if (!r.ok && r.error === 'invalid-scaffold') expect(r.details).toContain('playwright.config.ts')
    expect(fs.existsSync(path.join(tmp, 'features', 'demo_login'))).toBe(false)
  })
})

describe('buildFeatureScaffold repos', () => {
  const configOf = (files: ReturnType<typeof buildFeatureScaffold>): string =>
    files.find((file) => file.path === 'feature.config.cjs')!.content

  it('renders every optional repo field that is present', () => {
    const config = configOf(buildFeatureScaffold({
      featureName: 'demo_login',
      repos: [{
        name: 'api',
        localPath: '/srv/api',
        cloneUrl: 'git@github.com:acme/api.git',
        branch: 'main',
        envs: ['local', 'staging'],
        startCommands: [{ command: 'npm start' }],
      }],
    }))
    expect(config).toContain("name: 'api'")
    expect(config).toContain("localPath: '/srv/api'")
    expect(config).toContain("cloneUrl: 'git@github.com:acme/api.git'")
    expect(config).toContain("branch: 'main'")
    expect(config).toContain("envs: ['local', 'staging']")
    expect(config).toContain('startCommands')
  })

  it('omits optional repo fields that are absent', () => {
    const config = configOf(buildFeatureScaffold({
      featureName: 'demo_login',
      repos: [{ name: 'api', localPath: '/srv/api' }],
    }))
    expect(config).toContain("name: 'api'")
    expect(config).not.toContain('cloneUrl')
    expect(config).not.toContain('branch:')
    expect(config).not.toContain('startCommands')
  })

  it('falls back to the local envset when every declared env is blank', () => {
    // An all-whitespace envs list would otherwise produce `envs: []`, and a
    // feature with no envset cannot be booted at all.
    const config = configOf(buildFeatureScaffold({ featureName: 'demo_login', envs: ['  ', ''] }))
    expect(config).toContain("envs: ['local']")
  })
})
