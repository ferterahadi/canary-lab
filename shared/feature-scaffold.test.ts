import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyFeatureScaffold,
  buildFeatureScaffold,
  canonicalScaffoldPaths,
  validateGeneratedFeatureFiles,
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
})
