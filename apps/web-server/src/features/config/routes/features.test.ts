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

// Real DirtySpecStore backed by a tmp logs dir — no mocking, matching this
// file's convention of exercising real fs/git rather than stubbing collaborators.
function makeDirtySpecStore(): DirtySpecStore {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-froutes-dirty-'))
  return new DirtySpecStore(logsDir)
}

function initGitFeature(dir: string): void {
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 't@t.dev'])
  git(dir, ['config', 'user.name', 'test'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'baseline'])
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

  it('ships all-false stage evidence for a bare scaffold, and flags each artifact once present', async () => {
    const dir = writeFeature('evidenced', { spec: `import { test } from '@playwright/test'` })
    writeFeature('bare')
    fs.mkdirSync(path.join(dir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'envsets', 'local', 'app.env'), 'PORT=3000\n')
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'docs', '_prd-summary.json'), '{}')
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features' })
    const body = res.json() as Array<{ name: string; evidence: Record<string, unknown> }>
    // `booted` is false for both: this route's deps carry no logs dir in these
    // tests, so no run history exists to prove a boot with.
    expect(body.find((f) => f.name === 'evidenced')?.evidence).toEqual({
      envCapture: true,
      booted: false,
      prdSummary: true,
      specs: true,
      portInjectability: 'none',
    })
    expect(body.find((f) => f.name === 'bare')?.evidence).toEqual({
      envCapture: false,
      booted: false,
      prdSummary: false,
      specs: false,
      portInjectability: 'none',
    })
  })

  // Parallel readiness is a config property, so the row must report it even
  // with no portify overlay anywhere — that is what lets the shipped
  // storefront suite read "ready" on a fresh scaffold.
  it('reports declared port injectability off the config alone', async () => {
    const dir = path.join(featuresDir, 'slotted')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'slotted',
        description: 'd',
        envs: ['local'],
        featureDir: __dirname,
        repos: [{ name: 'a', localPath: __dirname, startCommands: [
          { command: 'npm run dev:api', ports: [{ name: 'api', env: 'PORT' }] },
        ] }],
      } }`,
    )
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features' })
    const body = res.json() as Array<{ name: string; portified: boolean; evidence: Record<string, unknown> }>
    const row = body.find((f) => f.name === 'slotted')!
    expect(row.portified).toBe(false)
    expect(row.evidence.portInjectability).toBe('declared')
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

  it('passes group through when set, and omits the key when absent', async () => {
    const groupedDir = path.join(featuresDir, 'grouped')
    fs.mkdirSync(groupedDir, { recursive: true })
    fs.writeFileSync(
      path.join(groupedDir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'grouped', description: 'd', group: 'checkout', envs: ['local'], featureDir: __dirname } }`,
    )
    writeFeature('ungrouped')
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features' })
    const body = res.json() as Array<{ name: string; group?: string }>
    expect(body.find((f) => f.name === 'grouped')?.group).toBe('checkout')
    const ungrouped = body.find((f) => f.name === 'ungrouped')!
    expect('group' in ungrouped).toBe(false)
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

describe('dirty summary on GET /api/features', () => {
  it('reports status "clean" with no specs when the store has no record for the feature', async () => {
    writeFeature('alpha')
    const store = makeDirtySpecStore()
    const app = await build({ dirtySpecStore: store })
    const res = await app.inject({ method: 'GET', url: '/api/features' })
    const body = res.json() as Array<{ name: string; dirty: { status: string; specs: unknown[] } }>
    expect(body[0].dirty).toEqual({ status: 'clean', specs: [] })
  })

  it('reports status "dirty" with mapped specs when the record is dirty', async () => {
    const dir = writeFeature('alpha', { spec: "test('one', async () => { expect(1).toBe(1) })\n" })
    initGitFeature(dir)
    // Edit after commit so computeDirty (HEAD baseline) marks the spec dirty.
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), "test('one', async () => { expect(1).toBe(2) })\n")

    const store = makeDirtySpecStore()
    await store.recompute('alpha', dir)

    const app = await build({ dirtySpecStore: store })
    const res = await app.inject({ method: 'GET', url: '/api/features' })
    const body = res.json() as Array<{
      name: string
      dirty: { status: string; specs: { file: string; affectedTests: string[] }[] }
    }>
    const alpha = body.find((f) => f.name === 'alpha')!
    expect(alpha.dirty.status).toBe('dirty')
    expect(alpha.dirty.specs).toHaveLength(1)
    expect(alpha.dirty.specs[0]).toMatchObject({ file: 'e2e/a.spec.ts' })
    expect(alpha.dirty.specs[0].affectedTests).toEqual(['one'])
  })
})

describe('POST /api/features/:name/approve-dirty', () => {
  it('404s for an unknown feature', async () => {
    const store = makeDirtySpecStore()
    const app = await build({ dirtySpecStore: store })
    const res = await app.inject({ method: 'POST', url: '/api/features/missing/approve-dirty' })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: string }).error).toBe('feature not found')
  })

  it('503s when dirtySpecStore is not configured', async () => {
    writeFeature('alpha')
    const app = await build()
    const res = await app.inject({ method: 'POST', url: '/api/features/alpha/approve-dirty' })
    expect(res.statusCode).toBe(503)
    expect((res.json() as { error: string }).error).toBe('test-file integrity tracking is not available')
  })

  it('approves the current content as the baseline and clears the dirty status', async () => {
    const dir = writeFeature('alpha', { spec: "test('one', async () => { expect(1).toBe(1) })\n" })
    initGitFeature(dir)
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), "test('one', async () => { expect(1).toBe(2) })\n")

    const store = makeDirtySpecStore()
    await store.recompute('alpha', dir)
    expect(store.get('alpha')?.status).toBe('dirty')

    const app = await build({ dirtySpecStore: store })
    const res = await app.inject({ method: 'POST', url: '/api/features/alpha/approve-dirty' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { status: string; dirtySpecs: unknown[] }
    expect(body.status).toBe('clean')
    expect(body.dirtySpecs).toEqual([])
    expect(store.get('alpha')?.status).toBe('clean')
  })
})

describe('POST /api/features/:name/commit-dirty', () => {
  it('404s for an unknown feature', async () => {
    const store = makeDirtySpecStore()
    const app = await build({ dirtySpecStore: store })
    const res = await app.inject({ method: 'POST', url: '/api/features/missing/commit-dirty' })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: string }).error).toBe('feature not found')
  })

  it('503s when dirtySpecStore is not configured', async () => {
    writeFeature('alpha')
    const app = await build()
    const res = await app.inject({ method: 'POST', url: '/api/features/alpha/commit-dirty' })
    expect(res.statusCode).toBe(503)
    expect((res.json() as { error: string }).error).toBe('test-file integrity tracking is not available')
  })

  it('reports "no modified specs" and recomputes when the store has no dirty specs for the feature', async () => {
    const dir = writeFeature('alpha', { spec: "test('one', async () => { expect(1).toBe(1) })\n" })
    const store = makeDirtySpecStore()
    const app = await build({ dirtySpecStore: store })
    const res = await app.inject({ method: 'POST', url: '/api/features/alpha/commit-dirty' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { committed: boolean; reason: string; status: string }
    expect(body.committed).toBe(false)
    expect(body.reason).toBe('no modified specs')
    expect(body.status).toBe('clean')
  })

  it('409s when the feature is not inside a git repository', async () => {
    const dir = writeFeature('alpha', { spec: "test('one', async () => { expect(1).toBe(1) })\n" })
    const store = makeDirtySpecStore()
    // No git repo at all — establish dirtiness via the run-start baseline
    // (independent of HEAD) rather than a git commit, so removing/never
    // having .git is what triggers the route's 409, not a missing baseline.
    await store.captureRunStart('alpha', dir)
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), "test('one', async () => { expect(1).toBe(2) })\n")
    await store.recompute('alpha', dir)
    expect(store.get('alpha')?.status).toBe('dirty')

    const app = await build({ dirtySpecStore: store })
    const res = await app.inject({ method: 'POST', url: '/api/features/alpha/commit-dirty' })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toBe('feature is not inside a git repository')
  })

  it('500s with the git stderr when `git add` fails', async () => {
    const dir = writeFeature('alpha', { spec: "test('one', async () => { expect(1).toBe(1) })\n" })
    initGitFeature(dir)
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), "test('one', async () => { expect(1).toBe(2) })\n")

    const store = makeDirtySpecStore()
    await store.recompute('alpha', dir)
    expect(store.get('alpha')?.status).toBe('dirty')

    // Plant a stale index.lock so the route's `git add` fails with a real
    // git error ("Unable to create .git/index.lock: File exists").
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '')

    const app = await build({ dirtySpecStore: store })
    const res = await app.inject({ method: 'POST', url: '/api/features/alpha/commit-dirty' })
    expect(res.statusCode).toBe(500)
    expect((res.json() as { error: string }).error).toBeTruthy()
  })

  it('500s with the git stderr when `git commit` fails (nothing staged to commit)', async () => {
    const dir = writeFeature('alpha', { spec: "test('one', async () => { expect(1).toBe(1) })\n" })
    initGitFeature(dir)
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), "test('one', async () => { expect(1).toBe(2) })\n")

    const store = makeDirtySpecStore()
    await store.recompute('alpha', dir)
    expect(store.get('alpha')?.status).toBe('dirty')

    // Revert the working tree back to the committed content before the route
    // runs. `git add` on unmodified content stages nothing, so the follow-up
    // `git commit` for those pathspecs fails ("nothing to commit").
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), "test('one', async () => { expect(1).toBe(1) })\n")

    const app = await build({ dirtySpecStore: store })
    const res = await app.inject({ method: 'POST', url: '/api/features/alpha/commit-dirty' })
    expect(res.statusCode).toBe(500)
    expect((res.json() as { error: string }).error).toBeTruthy()
  })

  it('commits the dirty specs and clears the dirty status on success', async () => {
    const dir = writeFeature('alpha', { spec: "test('one', async () => { expect(1).toBe(1) })\n" })
    initGitFeature(dir)
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), "test('one', async () => { expect(1).toBe(2) })\n")

    const store = makeDirtySpecStore()
    await store.recompute('alpha', dir)
    expect(store.get('alpha')?.status).toBe('dirty')

    const app = await build({ dirtySpecStore: store })
    const res = await app.inject({ method: 'POST', url: '/api/features/alpha/commit-dirty' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { committed: boolean; status: string }
    expect(body.committed).toBe(true)
    expect(body.status).toBe('clean')
    expect(store.get('alpha')?.status).toBe('clean')

    // The commit actually landed in git, with the expected message.
    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir }).toString().trim()
    expect(log).toBe('test: accept modified specs for "alpha" via Canary Lab')
  })

  it('falls back to "git add failed" when git exits nonzero with no output', async () => {
    const dir = writeFeature('alpha', { spec: "test('one', async () => { expect(1).toBe(1) })\n" })
    initGitFeature(dir)
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), "test('one', async () => { expect(1).toBe(2) })\n")

    const store = makeDirtySpecStore()
    await store.recompute('alpha', dir)

    const realRunGit = vi.mocked(runGit).getMockImplementation()!
    vi.mocked(runGit).mockImplementation(async (cwd, args) =>
      args[0] === 'add' ? { code: 1, stdout: '', stderr: '' } : realRunGit(cwd, args),
    )
    try {
      const app = await build({ dirtySpecStore: store })
      const res = await app.inject({ method: 'POST', url: '/api/features/alpha/commit-dirty' })
      expect(res.statusCode).toBe(500)
      expect((res.json() as { error: string }).error).toBe('git add failed')
    } finally {
      vi.mocked(runGit).mockImplementation(realRunGit)
    }
  })

  it('falls back to "git commit failed" when git exits nonzero with no output', async () => {
    const dir = writeFeature('alpha', { spec: "test('one', async () => { expect(1).toBe(1) })\n" })
    initGitFeature(dir)
    fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), "test('one', async () => { expect(1).toBe(2) })\n")

    const store = makeDirtySpecStore()
    await store.recompute('alpha', dir)

    const realRunGit = vi.mocked(runGit).getMockImplementation()!
    vi.mocked(runGit).mockImplementation(async (cwd, args) =>
      args[0] === 'commit' ? { code: 1, stdout: '', stderr: '' } : realRunGit(cwd, args),
    )
    try {
      const app = await build({ dirtySpecStore: store })
      const res = await app.inject({ method: 'POST', url: '/api/features/alpha/commit-dirty' })
      expect(res.statusCode).toBe(500)
      expect((res.json() as { error: string }).error).toBe('git commit failed')
    } finally {
      vi.mocked(runGit).mockImplementation(realRunGit)
    }
  })
})
