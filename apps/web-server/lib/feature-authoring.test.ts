import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  applyExternalDraftFiles,
  captureFeatureEnvFiles,
  checkoutFeatureRepoBranch,
  createFeatureSkeleton,
  deleteFeature,
  envsetSchema,
  externalTestFileRules,
  getFeatureEnvsetSummary,
  getFeatureRepoStatus,
  parseRedactedEntries,
  writeFeatureDoc,
} from './feature-authoring'

let tmpDir: string
let featuresDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-feature-authoring-')))
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function ctx() {
  return { projectRoot: tmpDir, featuresDir }
}

function writeFeatureConfig(
  feature: string,
  extras: string = '',
  repos: string = '[]',
): string {
  const featureDir = path.join(featuresDir, feature)
  fs.mkdirSync(featureDir, { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), `const config = {
  name: '${feature}',
  envs: ['local'],
  repos: ${repos},
  featureDir: __dirname,
  ${extras}
}
module.exports = { config }
`, 'utf8')
  return featureDir
}

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), 'repo\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['branch', 'topic'], { cwd: dir })
}

describe('feature-authoring', () => {
  it('creates a skeleton feature and reports envset summaries', () => {
    const created = createFeatureSkeleton({
      ...ctx(),
      feature: 'checkout_flow',
      description: ' Checkout flow ',
      envs: ['local', 'staging', 'local'],
      repos: [{ name: 'app', localPath: '/repo/app', branch: 'main' }],
    })

    expect(created).toMatchObject({
      ok: true,
      feature: 'checkout_flow',
      nextSteps: ['capture_feature_env_files', 'start_external_draft', 'apply_external_draft'],
      testFileRules: externalTestFileRules(),
      envsetSchema: envsetSchema('checkout_flow'),
    })
    if (!created.ok) throw new Error(created.error)
    expect(created.written.map((file) => path.relative(created.featureDir, file)).sort()).toEqual([
      'envsets/envsets.config.json',
      'envsets/local/checkout_flow.env',
      'feature.config.cjs',
      'playwright.config.ts',
    ])
    expect(fs.existsSync(path.join(created.featureDir, 'envsets', 'staging'))).toBe(true)

    const summary = getFeatureEnvsetSummary(ctx(), 'checkout_flow')
    expect(summary).toMatchObject({
      feature: 'checkout_flow',
      configPath: path.join(created.featureDir, 'envsets', 'envsets.config.json'),
      envs: [
        { name: 'local', slots: [{ slot: 'checkout_flow.env', target: '$CANARY_LAB_PROJECT_ROOT/features/checkout_flow/.env' }] },
        { name: 'staging', slots: [] },
      ],
    })

    const defaultEnv = createFeatureSkeleton({
      ...ctx(),
      feature: 'default_env',
    })
    expect(defaultEnv).toMatchObject({ ok: true, feature: 'default_env' })

    const emptyEnvList = createFeatureSkeleton({
      ...ctx(),
      feature: 'empty_env_list',
      envs: [],
    })
    expect(emptyEnvList).toMatchObject({ ok: true, feature: 'empty_env_list' })
  })

  it('rejects invalid or duplicate skeleton targets', () => {
    expect(createFeatureSkeleton({ ...ctx(), feature: '../bad' })).toMatchObject({ ok: false, error: 'invalid-name' })
    const featureDir = writeFeatureConfig('existing')
    expect(createFeatureSkeleton({ ...ctx(), feature: 'existing' })).toEqual({
      ok: false,
      error: 'feature-exists',
      featureDir,
    })
  })

  it('captures env files, redacts previews, and synchronizes feature envs', () => {
    const featureDir = writeFeatureConfig('checkout')
    const sourcePath = path.join(tmpDir, '.env.dev')
    fs.writeFileSync(sourcePath, [
      '# comment',
      'export API_KEY=secret',
      'DATABASE_URL:postgres://localhost',
      '! ignored',
      'INVALID LINE',
      '',
    ].join('\n'), 'utf8')

    const captured = captureFeatureEnvFiles(ctx(), {
      feature: 'checkout',
      sources: [{
        sourcePath,
        env: 'staging',
        slot: 'app.env',
        target: '  ',
        description: '  ',
      }],
    })

    expect(captured).toMatchObject({
      ok: true,
      captured: [{
        env: 'staging',
        slot: 'app.env',
        sourcePath,
        target: sourcePath,
        writtenPath: path.join(featureDir, 'envsets', 'staging', 'app.env'),
        preview: [
          { key: 'API_KEY', value: '********' },
          { key: 'DATABASE_URL', value: '********' },
        ],
      }],
    })
    expect(require(path.join(featureDir, 'feature.config.cjs')).config.envs).toEqual(['local', 'staging'])

    const overwrite = captureFeatureEnvFiles(ctx(), {
      feature: 'checkout',
      sources: [{ sourcePath, env: 'staging', slot: 'app.env' }],
    })
    expect(overwrite).toEqual({ ok: false, error: 'slot already exists; pass confirmOverwrite: true to overwrite staging/app.env' })

    const confirmedOverwrite = captureFeatureEnvFiles(ctx(), {
      feature: 'checkout',
      sources: [{
        sourcePath,
        env: 'staging',
        slot: 'app.env',
        target: '/tmp/runtime.env',
        description: 'Runtime env',
        confirmOverwrite: true,
      }],
    })
    expect(confirmedOverwrite).toMatchObject({
      ok: true,
      captured: [{ target: '/tmp/runtime.env' }],
      summary: {
        envs: [{
          name: 'staging',
          slots: [{ slot: 'app.env', target: '/tmp/runtime.env', description: 'Runtime env' }],
        }],
      },
    })

    const defaultSourceEnv = captureFeatureEnvFiles(ctx(), {
      feature: 'checkout',
      sources: [{ sourcePath, env: null, slot: 'default.env', target: null } as never],
    })
    expect(defaultSourceEnv).toMatchObject({ ok: true, captured: [{ env: 'local', slot: 'default.env' }] })

    const noEnvConfigDir = path.join(featuresDir, 'capture_no_envs')
    fs.mkdirSync(noEnvConfigDir, { recursive: true })
    fs.writeFileSync(path.join(noEnvConfigDir, 'feature.config.cjs'), `const config = {
  name: 'capture_no_envs',
  repos: [],
  featureDir: __dirname,
}
module.exports = { config }
`, 'utf8')
    expect(captureFeatureEnvFiles(ctx(), {
      feature: 'capture_no_envs',
      sources: [{ sourcePath, slot: 'capture.env' }],
    })).toMatchObject({ ok: true, captured: [{ env: 'local' }] })
  })

  it('validates capture requests before writing env files', () => {
    writeFeatureConfig('checkout')
    expect(captureFeatureEnvFiles(ctx(), { feature: 'missing', sources: [] }))
      .toEqual({ ok: false, error: 'feature not found' })
    expect(captureFeatureEnvFiles(ctx(), { feature: 'checkout', sources: [] }))
      .toEqual({ ok: false, error: 'sources[] required' })
    expect(captureFeatureEnvFiles(ctx(), { feature: 'checkout', sources: [{ sourcePath: path.join(tmpDir, 'missing.env') }] }))
      .toEqual({ ok: false, error: `source file not found: ${path.join(tmpDir, 'missing.env')}` })
    const sourcePath = path.join(tmpDir, '.env')
    fs.writeFileSync(sourcePath, 'KEY=value\n', 'utf8')
    expect(() => captureFeatureEnvFiles(ctx(), { feature: 'checkout', sources: [{ sourcePath, env: 'bad/env' }] }))
      .toThrow('invalid env name')
    expect(() => captureFeatureEnvFiles(ctx(), { feature: 'checkout', sources: [{ sourcePath, slot: '../bad.env' }] }))
      .toThrow('invalid slot name')
  })

  it('returns repo status and checks out configured repo branches', async () => {
    const repoDir = path.join(tmpDir, 'repo')
    initGitRepo(repoDir)
    writeFeatureConfig('checkout', '', `[{ name: 'app', localPath: ${JSON.stringify(repoDir)}, branch: 'topic' }]`)

    await expect(getFeatureRepoStatus(ctx(), 'missing', 'app')).resolves.toBeNull()
    await expect(getFeatureRepoStatus(ctx(), 'checkout', 'missing')).resolves.toBeNull()
    await expect(getFeatureRepoStatus(ctx(), 'checkout', 'app')).resolves.toMatchObject({
      isGitRepo: true,
      currentBranch: 'main',
      path: repoDir,
      expectedBranch: 'topic',
    })

    await expect(checkoutFeatureRepoBranch(ctx(), {
      feature: 'missing',
      repo: 'app',
      branch: 'topic',
      confirm: true,
    })).resolves.toEqual({ error: 'feature not found', statusCode: 404 })
    await expect(checkoutFeatureRepoBranch(ctx(), {
      feature: 'checkout',
      repo: 'missing',
      branch: 'topic',
      confirm: true,
    })).resolves.toEqual({ error: 'repo not found', statusCode: 404 })
    await expect(checkoutFeatureRepoBranch(ctx(), {
      feature: 'checkout',
      repo: 'app',
      branch: 'topic',
      confirm: true,
    })).resolves.toMatchObject({
      isGitRepo: true,
      currentBranch: 'topic',
      path: repoDir,
      expectedBranch: 'topic',
    })
    await expect(checkoutFeatureRepoBranch(ctx(), {
      feature: 'checkout',
      repo: 'app',
      branch: '',
      confirm: true,
    })).resolves.toEqual({ error: 'branch must be a non-empty branch name', statusCode: 400 })

    writeFeatureConfig('checkout_no_expected', '', `[{ name: 'app', localPath: ${JSON.stringify(repoDir)} }]`)
    await expect(getFeatureRepoStatus(ctx(), 'checkout_no_expected', 'app')).resolves.toMatchObject({
      path: repoDir,
      expectedBranch: null,
    })
    await expect(checkoutFeatureRepoBranch(ctx(), {
      feature: 'checkout_no_expected',
      repo: 'app',
      branch: 'topic',
      confirm: true,
    })).resolves.toMatchObject({ expectedBranch: null })
  })

  it('deletes only confirmed terminal feature directories', () => {
    const featureDir = writeFeatureConfig('checkout')
    expect(deleteFeature(ctx(), { feature: 'checkout', confirmName: 'wrong' }))
      .toEqual({ ok: false, error: 'confirmName must match the feature name' })
    expect(deleteFeature(ctx(), { feature: 'missing', confirmName: 'missing' }))
      .toEqual({ ok: false, error: 'feature not found' })
    expect(deleteFeature(ctx(), { feature: 'checkout', confirmName: 'checkout' }))
      .toEqual({ ok: true, featureDir })
    expect(fs.existsSync(featureDir)).toBe(false)

    const outsideDir = path.join(tmpDir, 'outside')
    fs.mkdirSync(outsideDir)
    const unsafeDir = path.join(featuresDir, 'unsafe')
    fs.mkdirSync(unsafeDir)
    fs.writeFileSync(path.join(unsafeDir, 'feature.config.cjs'), `const config = {
  name: 'unsafe',
  envs: ['local'],
  repos: [],
  featureDir: ${JSON.stringify(outsideDir)},
}
module.exports = { config }
`, 'utf8')
    expect(deleteFeature(ctx(), { feature: 'unsafe', confirmName: 'unsafe' }))
      .toEqual({ ok: false, error: 'feature directory is outside the features root', featureDir: outsideDir })
  })

  it('applies provided or existing external draft spec files', () => {
    const featureDir = writeFeatureConfig('checkout')
    expect(applyExternalDraftFiles({ featureDir, files: [] }))
      .toEqual({ ok: false, error: 'no generated files' })
    expect(applyExternalDraftFiles({
      featureDir,
      files: [{
        path: 'e2e/checkout.spec.ts',
        content: "import { test } from 'canary-lab/feature-support/log-marker-fixture'\n",
      }],
    })).toEqual({
      ok: true,
      written: [path.join(featureDir, 'e2e', 'checkout.spec.ts')],
    })
    expect(applyExternalDraftFiles({ featureDir })).toEqual({
      ok: true,
      written: [path.join(featureDir, 'e2e', 'checkout.spec.ts')],
    })
  })

  it('handles malformed envset config and absent config files defensively', () => {
    const featureDir = writeFeatureConfig('checkout')
    const envsetsDir = path.join(featureDir, 'envsets')
    fs.mkdirSync(path.join(envsetsDir, 'local'), { recursive: true })
    fs.writeFileSync(path.join(envsetsDir, 'envsets.config.json'), '{bad json', 'utf8')
    fs.writeFileSync(path.join(envsetsDir, 'local', 'checkout.env'), 'TOKEN=secret\n', 'utf8')

    expect(getFeatureEnvsetSummary(ctx(), 'checkout')).toMatchObject({
      configPath: path.join(envsetsDir, 'envsets.config.json'),
      envs: [{ name: 'local', slots: [{ slot: 'checkout.env', preview: [{ key: 'TOKEN', value: '********' }] }] }],
    })

    const noEnvsetsDir = writeFeatureConfig('no_envsets')
    expect(getFeatureEnvsetSummary(ctx(), 'no_envsets')).toMatchObject({
      feature: 'no_envsets',
      featureDir: noEnvsetsDir,
      configPath: null,
      envs: [],
    })

    const noFeatureDir = path.join(featuresDir, 'no_feature_dir')
    fs.mkdirSync(noFeatureDir, { recursive: true })
    fs.writeFileSync(path.join(noFeatureDir, 'feature.config.cjs'), `const config = {
  name: 'no_feature_dir',
  envs: ['local'],
  repos: [],
}
module.exports = { config }
`, 'utf8')
    expect(getFeatureEnvsetSummary(ctx(), 'no_feature_dir')).toBeNull()

    const configWithoutSlotMetadataDir = writeFeatureConfig('bare_slot')
    fs.mkdirSync(path.join(configWithoutSlotMetadataDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(configWithoutSlotMetadataDir, 'envsets', 'local', 'bare.env'), 'KEY=value\n', 'utf8')
    fs.writeFileSync(path.join(configWithoutSlotMetadataDir, 'envsets', 'envsets.config.json'), JSON.stringify({ slots: { 'bare.env': {} } }), 'utf8')
    expect(getFeatureEnvsetSummary(ctx(), 'bare_slot')).toMatchObject({
      envs: [{ name: 'local', slots: [{ slot: 'bare.env' }] }],
    })

    const nullConfigDir = writeFeatureConfig('null_config')
    fs.mkdirSync(path.join(nullConfigDir, 'envsets'), { recursive: true })
    fs.writeFileSync(path.join(nullConfigDir, 'envsets', 'envsets.config.json'), 'null', 'utf8')
    expect(getFeatureEnvsetSummary(ctx(), 'null_config')).toMatchObject({ configPath: path.join(nullConfigDir, 'envsets', 'envsets.config.json') })

    const raceDir = writeFeatureConfig('missing_env_dir')
    fs.mkdirSync(path.join(raceDir, 'envsets', 'local'), { recursive: true })
    const existsSync = fs.existsSync
    vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (target === path.join(raceDir, 'envsets', 'local')) return false
      return existsSync(target)
    })
    expect(getFeatureEnvsetSummary(ctx(), 'missing_env_dir')).toMatchObject({
      envs: [{ name: 'local', slots: [] }],
    })
    vi.restoreAllMocks()

    fs.rmSync(path.join(featureDir, 'feature.config.cjs'))
    const sourcePath = path.join(tmpDir, '.env')
    fs.writeFileSync(sourcePath, 'KEY=value\n', 'utf8')
    expect(captureFeatureEnvFiles(ctx(), {
      feature: 'checkout',
      sources: [{ sourcePath, confirmOverwrite: true }],
    })).toMatchObject({ ok: false, error: 'feature not found' })

    const dynamicDir = path.join(featuresDir, 'dynamic')
    fs.mkdirSync(dynamicDir, { recursive: true })
    fs.writeFileSync(path.join(dynamicDir, 'feature.config.cjs'), `function makeConfig() {
  return { name: 'dynamic', envs: ['local'], repos: [], featureDir: __dirname }
}
module.exports = { config: makeConfig() }
`, 'utf8')
    expect(() => captureFeatureEnvFiles(ctx(), {
      feature: 'dynamic',
      sources: [{ sourcePath }],
    })).toThrow('Unable to locate feature config object literal')

    const outsideSyncDir = path.join(tmpDir, 'outside-sync')
    fs.mkdirSync(outsideSyncDir)
    const outsideFeatureDir = path.join(featuresDir, 'outside_sync')
    fs.mkdirSync(outsideFeatureDir, { recursive: true })
    fs.writeFileSync(path.join(outsideFeatureDir, 'feature.config.cjs'), `const config = {
  name: 'outside_sync',
  envs: ['local'],
  repos: [],
  featureDir: ${JSON.stringify(outsideSyncDir)},
}
module.exports = { config }
`, 'utf8')
    expect(captureFeatureEnvFiles(ctx(), {
      feature: 'outside_sync',
      sources: [{ sourcePath }],
    })).toMatchObject({ ok: true })
  })

  it('returns no generated files when applying existing specs without an e2e directory', () => {
    const featureDir = writeFeatureConfig('empty_specs')
    expect(applyExternalDraftFiles({ featureDir }))
      .toEqual({ ok: false, error: 'no generated files' })
  })

  it('parses supported env key formats in sorted order', () => {
    expect(parseRedactedEntries('B=value\nA: value\nexport C=value\n# ignored\n! ignored\n')).toEqual([
      { key: 'A', value: '********' },
      { key: 'B', value: '********' },
      { key: 'C', value: '********' },
    ])
  })
})

describe('writeFeatureDoc', () => {
  it('writes a markdown doc into the feature docs/ dir and reports the relative path', () => {
    const featureDir = writeFeatureConfig('line_integration')
    const res = writeFeatureDoc(ctx(), {
      feature: 'line_integration',
      relPath: 'session-notes.md',
      content: '# Notes\n\nDistilled.',
    })
    expect(res).toEqual({
      ok: true,
      writtenPath: path.join(featureDir, 'docs', 'session-notes.md'),
      relativePath: path.join('docs', 'session-notes.md'),
    })
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'session-notes.md'), 'utf8')).toBe('# Notes\n\nDistilled.')
  })

  it('is create-or-replace — re-writing the same relPath overwrites', () => {
    writeFeatureConfig('line_integration')
    writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'plan.md', content: 'v1' })
    const res = writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'plan.md', content: 'v2' })
    expect(res.ok).toBe(true)
    const featureDir = path.join(featuresDir, 'line_integration')
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'plan.md'), 'utf8')).toBe('v2')
  })

  it('strips an optional leading docs/ so both forms land in docs/', () => {
    writeFeatureConfig('line_integration')
    const res = writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'docs/plan.md', content: 'x' })
    expect(res).toMatchObject({ ok: true, relativePath: path.join('docs', 'plan.md') })
  })

  it('supports nested subdirectories under docs/', () => {
    const featureDir = writeFeatureConfig('line_integration')
    const res = writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'sessions/2026-05-28.md', content: 'x' })
    expect(res).toMatchObject({ ok: true, relativePath: path.join('docs', 'sessions', '2026-05-28.md') })
    expect(fs.existsSync(path.join(featureDir, 'docs', 'sessions', '2026-05-28.md'))).toBe(true)
  })

  it('rejects an unknown feature', () => {
    expect(writeFeatureDoc(ctx(), { feature: 'nope', relPath: 'x.md', content: 'x' }))
      .toEqual({ ok: false, error: 'feature not found' })
  })

  it('rejects empty content', () => {
    writeFeatureConfig('line_integration')
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'x.md', content: '   ' }))
      .toEqual({ ok: false, error: 'content must be a non-empty string' })
  })

  it('rejects an absolute relPath', () => {
    writeFeatureConfig('line_integration')
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: '/etc/passwd.md', content: 'x' }))
      .toEqual({ ok: false, error: 'relPath must be relative' })
  })

  it('rejects a non-markdown extension', () => {
    writeFeatureConfig('line_integration')
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: 'notes.txt', content: 'x' }))
      .toEqual({ ok: false, error: 'relPath must end in .md or .markdown' })
  })

  it('rejects an empty relPath', () => {
    writeFeatureConfig('line_integration')
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: null as never, content: 'x' }))
      .toEqual({ ok: false, error: 'relPath required' })
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: '   ', content: 'x' }))
      .toEqual({ ok: false, error: 'relPath required' })
  })

  it('rejects a path that escapes the docs directory', () => {
    const featureDir = writeFeatureConfig('line_integration')
    expect(writeFeatureDoc(ctx(), { feature: 'line_integration', relPath: '../escape.md', content: 'x' }))
      .toEqual({ ok: false, error: 'relPath must not escape the docs directory' })
    expect(fs.existsSync(path.join(featureDir, 'escape.md'))).toBe(false)
  })
})
