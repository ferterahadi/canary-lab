import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerFeatureEnvTools } from './authoring-env'
import { captureTools } from './__fixtures__/tool-group-harness'

// Envset capture/inspection, feature deletion, and the repo-branch surface.
//
// Real files and a real git repo in a tmpdir: these tools copy the user's
// secrets into envsets, delete directories out of features/, and check branches
// out in their working copy. Every guard below is what stands between an MCP
// client's word and one of those, so a mocked filesystem would prove nothing.

let tmpDir: string
let featuresDir: string
let repoDir: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()
}

function writeFeature(name: string, repos: Array<Record<string, unknown>> = []): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: '${name}', description: 'd', envs: ['local'], featureDir: __dirname, repos: ${JSON.stringify(repos)} } }`,
  )
  return dir
}

function harness(over: Record<string, unknown> = {}) {
  const published: unknown[] = []
  const tools = captureTools(registerFeatureEnvTools, {
    projectRoot: tmpDir,
    featuresDir,
    workspaceEvents: { publish: (e: unknown) => published.push(e) },
    ...over,
  })
  return { ...tools, published }
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-env-')))
  featuresDir = path.join(tmpDir, 'features')
  repoDir = path.join(tmpDir, 'repo-shop')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(repoDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('get_feature_envset_summary', () => {
  it('reports an unknown feature rather than an empty layout', async () => {
    const { text } = harness()

    expect(await text('get_feature_envset_summary', { feature: 'ghost' }))
      .toBe('feature not found: ghost')
  })

  it('describes the layout of a real feature', async () => {
    writeFeature('checkout', [{ name: 'shop', localPath: repoDir, branch: 'main' }])
    const { call } = harness()

    const out = await call('get_feature_envset_summary', { feature: 'checkout' })

    expect(out.repos).toMatchObject([{ name: 'shop' }])
  })
})

describe('capture_feature_env_files', () => {
  it('copies a declared env file in and announces the feature change', async () => {
    writeFeature('checkout', [{ name: 'shop', localPath: repoDir }])
    fs.writeFileSync(path.join(repoDir, '.env.local'), 'API_KEY=secret\nPORT=4000\n')
    const { call, published } = harness()

    const out = await call('capture_feature_env_files', {
      feature: 'checkout',
      sources: [{ sourcePath: path.join(repoDir, '.env.local'), env: 'local', slot: 'shop.env' }],
    })

    expect(out.ok).toBe(true)
    expect(fs.existsSync(path.join(featuresDir, 'checkout', 'envsets', 'local', 'shop.env'))).toBe(true)
    // The Envsets tab is derived from disk, so without an announcement it stays
    // stale. The capture layer publishes its own envsets event too; what this
    // tool adds is the feature-list refresh.
    expect(published).toContainEqual({ type: 'features-changed' })
    // Values are never echoed back — the whole point of the redacted preview.
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  it('reports a refusal instead of announcing a change that did not happen', async () => {
    writeFeature('checkout', [{ name: 'shop', localPath: repoDir }])
    const { text, published } = harness()

    const out = await text('capture_feature_env_files', {
      feature: 'checkout',
      sources: [{ sourcePath: path.join(repoDir, 'missing.env'), env: 'local', slot: 'shop.env' }],
    })

    expect(out).not.toBe('')
    expect(published).toEqual([])
  })

  it('reports an unknown feature rather than capturing into nothing', async () => {
    const { text } = harness()

    expect(await text('capture_feature_env_files', {
      feature: 'ghost',
      sources: [{ sourcePath: path.join(repoDir, '.env'), env: 'local', slot: 'x.env' }],
    })).not.toBe('')
  })

  it('reports a filesystem failure instead of letting it escape as a tool crash', async () => {
    const featureDir = writeFeature('checkout', [{ name: 'shop', localPath: repoDir }])
    fs.writeFileSync(path.join(repoDir, '.env.local'), 'PORT=4000\n')
    // A read-only feature directory: the capture writes with no try/catch of its
    // own, so the throw lands in the tool. Letting it escape would give the
    // client a protocol error carrying no message it can act on.
    fs.chmodSync(featureDir, 0o500)
    try {
      const { text, published } = harness()

      const out = await text('capture_feature_env_files', {
        feature: 'checkout',
        sources: [{ sourcePath: path.join(repoDir, '.env.local'), env: 'local', slot: 'shop.env' }],
      })

      expect(out).toMatch(/EACCES|permission denied/i)
      expect(published).toEqual([])
    } finally {
      fs.chmodSync(featureDir, 0o700)
    }
  })
})

describe('write_envset', () => {
  const ARGS = {
    feature: 'checkout', env: 'local', slot: 'shop.env',
    entries: [{ key: 'PORT', value: '4000' }], confirm: true,
  }

  it('says so when the REST writer is not wired', async () => {
    const { text } = harness()

    expect(await text('write_envset', ARGS)).toBe('writeEnvsetSlot dependency is not configured')
  })

  it('writes through the REST handler and announces the envset change', async () => {
    const writeEnvsetSlot = vi.fn(async () => ({
      path: '/features/checkout/envsets/local/shop.env',
      entries: [{ key: 'PORT', value: '4000' }],
      unparsedLines: [3],
    }))
    const { call, published } = harness({ writeEnvsetSlot })

    const out = await call('write_envset', ARGS)

    // Reused rather than re-implemented: the REST handler owns the
    // path-traversal and feature-resolution checks.
    expect(writeEnvsetSlot).toHaveBeenCalledWith('checkout', 'local', 'shop.env', [{ key: 'PORT', value: '4000' }])
    expect(out).toMatchObject({
      feature: 'checkout', env: 'local', slot: 'shop.env',
      path: '/features/checkout/envsets/local/shop.env', unparsedLines: [3],
    })
    expect(published).toEqual([{ type: 'envsets-changed', feature: 'checkout' }])
  })

  it('surfaces the writer\'s rejection', async () => {
    const { text } = harness({
      writeEnvsetSlot: async () => { throw new Error('slot escapes the envset directory') },
    })

    expect(await text('write_envset', ARGS)).toBe('slot escapes the envset directory')
  })

  it('is destructive but idempotent — the same entries land on the same file', async () => {
    const { configs } = harness()

    expect(configs.get('write_envset')!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true })
  })
})

describe('delete_feature', () => {
  it('refuses a mismatched confirmation before removing any flight history', async () => {
    writeFeature('checkout')
    const removeFlightRecordsFor = vi.fn(() => ({ removed: 3 }))
    const { text } = harness({ removeFlightRecordsFor })

    expect(await text('delete_feature', { feature: 'checkout', confirmName: 'checkou' }))
      .toBe('confirmName must match the feature name')
    // Ordering is the point: the flight hook deletes records, so a failed
    // confirmation must not have already run it.
    expect(removeFlightRecordsFor).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(featuresDir, 'checkout'))).toBe(true)
  })

  it('refuses while a flight is still active, leaving the directory alone', async () => {
    writeFeature('checkout')
    const { text } = harness({
      removeFlightRecordsFor: () => ({ error: 'flight fl-1 is running — pause it first', removed: 0 }),
    })

    expect(await text('delete_feature', { feature: 'checkout', confirmName: 'checkout' }))
      .toBe('flight fl-1 is running — pause it first')
    expect(fs.existsSync(path.join(featuresDir, 'checkout'))).toBe(true)
  })

  it('deletes the directory and reports how much flight history went with it', async () => {
    writeFeature('checkout')
    const { call } = harness({ removeFlightRecordsFor: () => ({ removed: 2 }) })

    const out = await call('delete_feature', { feature: 'checkout', confirmName: 'checkout' })

    expect(out).toMatchObject({ deleted: true, feature: 'checkout', flightRecordsRemoved: 2 })
    expect(fs.existsSync(path.join(featuresDir, 'checkout'))).toBe(false)
  })

  it('reports zero flight records on a build with no flight hook wired', async () => {
    writeFeature('checkout')
    const { call } = harness()

    expect(await call('delete_feature', { feature: 'checkout', confirmName: 'checkout' }))
      .toMatchObject({ deleted: true, flightRecordsRemoved: 0 })
  })

  it('surfaces a deletion the authoring layer refused', async () => {
    const { text } = harness({ removeFlightRecordsFor: () => ({ removed: 0 }) })

    expect(await text('delete_feature', { feature: 'ghost', confirmName: 'ghost' }))
      .toBe('feature not found')
  })
})

describe('the feature repo branch surface', () => {
  beforeEach(() => {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# shop\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    git('branch', 'feature-x')
  })

  it('reports an unknown repo rather than guessing a path', async () => {
    writeFeature('checkout', [{ name: 'shop', localPath: repoDir }])
    const { text } = harness()

    expect(await text('get_feature_repo_status', { feature: 'checkout', repo: 'nope' }))
      .toBe('repo not found: checkout/nope')
  })

  it('reports an unknown feature the same way', async () => {
    const { text } = harness()

    expect(await text('get_feature_repo_status', { feature: 'ghost', repo: 'shop' }))
      .toBe('repo not found: ghost/shop')
  })

  it('reads the live branch, and the branch the config expects', async () => {
    writeFeature('checkout', [{ name: 'shop', localPath: repoDir, branch: 'main' }])
    const { call } = harness()

    const out = await call('get_feature_repo_status', { feature: 'checkout', repo: 'shop' })

    expect(out).toMatchObject({ currentBranch: 'main', expectedBranch: 'main', path: repoDir, isGitRepo: true })
  })

  it('checks a branch out and announces it so the Repos tab follows', async () => {
    writeFeature('checkout', [{ name: 'shop', localPath: repoDir, branch: 'feature-x' }])
    const { call, published } = harness()

    const out = await call('checkout_feature_repo_branch', {
      feature: 'checkout', repo: 'shop', branch: 'feature-x', confirm: true,
    })

    expect(out).toMatchObject({ currentBranch: 'feature-x' })
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature-x')
    expect(published).toEqual([{ type: 'features-changed' }])
  })

  it('surfaces a refused checkout without announcing a move that did not happen', async () => {
    writeFeature('checkout', [{ name: 'shop', localPath: repoDir }])
    const { text, published } = harness()

    const out = await text('checkout_feature_repo_branch', {
      feature: 'checkout', repo: 'nope', branch: 'feature-x', confirm: true,
    })

    expect(out).not.toBe('')
    expect(published).toEqual([])
  })
})
