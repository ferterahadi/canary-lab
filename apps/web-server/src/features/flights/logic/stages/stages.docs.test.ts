import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

import { execFileSync } from 'child_process'

// Transparent pass-through by default — every other test in this file spawns
// real processes (fake npx/claude binaries on PATH). Only the one test below
// that needs to control child-process event ordering deterministically
// installs an override via setMockSpawn.
const { getMockSpawn, setMockSpawn } = vi.hoisted(() => {
  let impl: ((...args: unknown[]) => unknown) | null = null
  return {
    getMockSpawn: () => impl,
    setMockSpawn: (fn: ((...args: unknown[]) => unknown) | null) => { impl = fn },
  }
})

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      const impl = getMockSpawn()
      return impl ? impl(...args) : (actual.spawn as (...a: unknown[]) => unknown)(...args)
    },
  }
})

import { attemptLogLine, describeAttempt, docsStage } from './docs'

import type { FlightInject, FlightStageDeps } from './context'

import type { StageContext, StageOutcome } from '../conductor'

import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'

import { createFeatureSkeleton } from '../../../config/logic/feature-authoring'

let tmpDir: string

let featuresDir: string

let logsDir: string

let repoDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-stages-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  repoDir = path.join(tmpDir, 'product-repo')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(repoDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

type InjectCall = { method: string; url: string; payload?: unknown }

type InjectImpl = (call: InjectCall) => { statusCode: number; body: unknown } | undefined

function makeInject(impl: InjectImpl, calls: InjectCall[] = []): FlightInject {
  return async (opts) => {
    calls.push(opts)
    const out = impl(opts) ?? { statusCode: 500, body: { error: `unstubbed ${opts.method} ${opts.url}` } }
    return { statusCode: out.statusCode, json: () => out.body }
  }
}

function deps(over: Partial<FlightStageDeps> = {}): FlightStageDeps {
  return {
    featuresDir,
    logsDir,
    projectRoot: tmpDir,
    inject: makeInject(() => undefined),
    ...over,
  }
}

function manifest(over: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'fl-test',
    feature: 'checkout',
    repoPaths: [repoDir],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'running',
    currentStage: 'similarity',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function ctxFor(m: FlightManifest): { ctx: StageContext; current: () => FlightManifest; setStage: (key: FlightStageKey, patch: Partial<FlightStage>) => void; progressLog: unknown[] } {
  const state = { m }
  const progressLog: unknown[] = []
  const setStage = (key: FlightStageKey, patch: Partial<FlightStage>): void => {
    state.m = { ...state.m, stages: state.m.stages.map((s) => (s.key === key ? { ...s, ...patch } : s)) }
  }
  return {
    progressLog,
    ctx: {
      manifest: () => state.m,
      flightDir: path.join(logsDir, 'flights', state.m.flightId),
      signal: new AbortController().signal,
      appendLog: () => {},
      setProgress: (progress) => { progressLog.push(progress) },
      patchFlight: (patch) => {
        state.m = {
          ...state.m,
          ...patch,
          links: patch.links ? { ...state.m.links, ...patch.links } : state.m.links,
        }
      },
    },
    current: () => state.m,
    setStage,
  }
}

function configCjs(name: string, repoLocalPath: string, description = 'existing feature'): string {
  return [
    'const config = {',
    `  name: '${name}',`,
    `  description: '${description}',`,
    "  envs: ['local'],",
    `  repos: [{ name: 'app', localPath: '${repoLocalPath}', startCommands: ['npm run dev'] }],`,
    '  featureDir: __dirname,',
    '}',
    'module.exports = { config }',
    '',
  ].join('\n')
}

describe('docs stage', () => {
  beforeEach(() => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    fs.mkdirSync(path.join(featuresDir, 'checkout', 'docs'), { recursive: true })
  })

  function initGitRepoWithDiff(): void {
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
    run(['init', '-q', '-b', 'main'])
    run(['config', 'user.email', 't@t.com'])
    run(['config', 'user.name', 't'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi\n')
    run(['add', '.'])
    run(['commit', '-qm', 'init'])
    run(['checkout', '-qb', 'feature'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi\nworld\n'.repeat(5))
    run(['add', '.'])
    run(['commit', '-qm', 'change'])
  }

  it('parks even when docs already exist — with `continue` as the release (requirements always pause)', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD\nreal doc')
    const outcome = await docsStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'prd-source', options: expect.arrayContaining(['continue']) },
    })
  })

  it('continue releases the checkpoint with the present docs', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD\nreal doc')
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'continue' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'user-confirmed', docs: ['prd.md'] } })
  })

  it('continue with no docs present re-parks instead of settling empty', async () => {
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'continue' })
    expect(outcome.kind).toBe('checkpoint')
  })

  it('yolo with existing docs settles done without parking', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD\nreal doc')
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'existing' } })
  })

  it('symlinks a local doc path referenced in the intent into docs/ (rung 0.5)', async () => {
    const prdPath = path.join(tmpDir, 'external-prd.md')
    fs.writeFileSync(prdPath, '# External PRD\nthe checkout flow')
    const m = manifest({ description: `test checkout, refer to ${prdPath}` })
    const parked = await docsStage(deps()).run(ctxFor(m).ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    expect((parked.checkpoint.data as { linked: string[] }).linked.length).toBe(1)
    const dest = path.join(featuresDir, 'checkout', 'docs', 'external-prd.md')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(dest, 'utf-8')).toContain('External PRD')
  })

  it('yolo auto-gathers repo docs (README) into the feature', async () => {
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Product\nIt should do the thing.')
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'repo-docs' } })
    const docs = fs.readdirSync(path.join(featuresDir, 'checkout', 'docs')).filter((f) => !f.startsWith('_'))
    expect(docs.length).toBeGreaterThan(0)
  })

  it('falls back to the description alone when the repo offers nothing', async () => {
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'description-only', docs: ['description.md'] } })
  })

  it('parks on prd-source otherwise; a drop while parked releases via continue', async () => {
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    expect(parked.checkpoint.kind).toBe('prd-source')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'dropped.md'), '# Dropped PRD')
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'continue' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'user-confirmed', docs: ['dropped.md'] } })
  })

  it('is done immediately when the docs dir does not exist yet (userDocs catch)', async () => {
    fs.rmSync(path.join(featuresDir, 'checkout', 'docs'), { recursive: true, force: true })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'description-only' } })
  })

  it('parks on the two-path fork: agent options + the intent in the checkpoint data', async () => {
    const parked = await docsStage(deps()).run(ctxFor(manifest()).ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    // No docs yet → the two agent hints, no continue (nothing to continue with).
    expect(parked.checkpoint.options).toEqual(['collect-repo-docs', 'infer-from-diff'])
    expect((parked.checkpoint.data as { intent: string }).intent).toBe('checkout flow')
  })

  it('parks with continue FIRST once docs exist (the recommended release)', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD\nreal doc')
    const parked = await docsStage(deps()).run(ctxFor(manifest()).ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    expect(parked.checkpoint.options).toEqual(['continue', 'collect-repo-docs', 'infer-from-diff'])
  })

  it('yolo picks up docs/*.md files from the repo, not just READMEs', async () => {
    fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, 'docs', 'guide.md'), '# Guide\nDo the thing.')
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'repo-docs' } })
    const docs = fs.readdirSync(path.join(featuresDir, 'checkout', 'docs')).filter((f) => !f.startsWith('_'))
    expect(docs.some((f) => f.includes('guide'))).toBe(true)
  })

  it('infers requirements from the diff vs base when no repo docs exist', async () => {
    initGitRepoWithDiff()
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'diff-vs-base' } })
    const docs = fs.readdirSync(path.join(featuresDir, 'checkout', 'docs')).filter((f) => !f.startsWith('_'))
    // Feature-named artifact (R74) — never a stray repo-derived name.
    expect(docs.some((f) => f.startsWith('checkout-from-diff'))).toBe(true)
    const content = fs.readFileSync(path.join(featuresDir, 'checkout', 'docs', docs.find((f) => f.startsWith('checkout-from-diff'))!), 'utf-8')
    expect(content).toContain('```diff')
  })

  it('honors an explicit base branch override', async () => {
    initGitRepoWithDiff()
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, base: 'main' } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'diff-vs-base' } })
  })

  it('falls back past a no-op diff (same branch as base) to description-only', async () => {
    initGitRepoWithDiff()
    // Stay on main — current === base, diffVsBase short-circuits to null.
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoDir, encoding: 'utf-8' })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, base: 'main' } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'description-only' } })
  })

  it('findRepoDocs ignores non-markdown files under docs/ and stops once MAX_REPO_DOCS is hit', async () => {
    fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, 'docs', 'notes.txt'), 'not markdown')
    // 12 markdown files across 2 fake "repos" (>MAX_REPO_DOCS=10) to hit the cap.
    const repoDir2 = path.join(tmpDir, 'product-repo-2')
    fs.mkdirSync(path.join(repoDir2, 'docs'), { recursive: true })
    for (let i = 0; i < 12; i += 1) {
      fs.writeFileSync(path.join(repoDir2, 'docs', `d${i}.md`), `# doc ${i}\ncontent`)
    }
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true }, repoPaths: [repoDir, repoDir2] })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'repo-docs' } })
    const docs = fs.readdirSync(path.join(featuresDir, 'checkout', 'docs')).filter((f) => !f.startsWith('_'))
    expect(docs.length).toBeLessThanOrEqual(10)
    expect(docs.some((f) => f.includes('notes'))).toBe(false)
  })

  it('detectBaseBranch follows origin/HEAD when it resolves', async () => {
    initGitRepoWithDiff()
    execFileSync('git', ['checkout', '-q', 'feature'], { cwd: repoDir })
    // Fake a remote-tracking origin/HEAD pointing at main, without a real remote.
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'main'], { cwd: repoDir })
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: repoDir })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'diff-vs-base' } })
  })

  it('a genuinely empty diff (no file changes) is treated as no-op and falls through', async () => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
    run(['init', '-q', '-b', 'main'])
    run(['config', 'user.email', 't@t.com'])
    run(['config', 'user.name', 't'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi\n')
    run(['add', '.'])
    run(['commit', '-qm', 'init'])
    run(['checkout', '-qb', 'feature'])
    run(['commit', '-qm', 'empty change', '--allow-empty']) // current !== base, but the diff itself is empty
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, base: 'main' } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'description-only' } })
  })

  it('a diff over MAX_DIFF_BYTES gets truncated', async () => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
    run(['init', '-q', '-b', 'main'])
    run(['config', 'user.email', 't@t.com'])
    run(['config', 'user.name', 't'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), '\n')
    run(['add', '.'])
    run(['commit', '-qm', 'init'])
    run(['checkout', '-qb', 'feature'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), Array.from({ length: 40000 }, (_, i) => `line number is quite long here indeed ${i}`).join('\n') + '\n')
    run(['add', '.'])
    run(['commit', '-qm', 'huge change'])
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, base: 'main' } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'diff-vs-base' } })
    const docs = fs.readdirSync(path.join(featuresDir, 'checkout', 'docs')).filter((f) => f.startsWith('checkout-from-diff'))
    const content = fs.readFileSync(path.join(featuresDir, 'checkout', 'docs', docs[0]), 'utf-8')
    expect(content).toContain('…(truncated)')
  })

  it('a write failure (feature not found under its declared config name) fails every write, including repo-docs and the diff-doc one', async () => {
    // Overwrite the scaffolded config's declared `name` so findFeature() (used
    // by writeFeatureDoc) can never resolve "checkout" — every write() call
    // fails: the README write, the diff-vs-base doc write (a real git diff is
    // present so that write is actually attempted), and the final description.
    initGitRepoWithDiff()
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Product\nDoes the thing.')
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), configCjs('renamed-elsewhere', repoDir))
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: 'feature not found' })
  })

  it('write() succeeding at a DIFFERENT feature dir than featureDirFor still reports no docs landed', async () => {
    // A feature.config.cjs declaring name "checkout" but living in a
    // differently-named directory: writeFeatureDoc resolves featureDir via the
    // declared name (finds it, writes succeed there), while docsStage's own
    // featureDirFor(deps, 'checkout') is a straight path join that never
    // existed — so the harness-read userDocs() comes back empty.
    fs.rmSync(path.join(featuresDir, 'checkout'), { recursive: true, force: true })
    const otherDir = path.join(featuresDir, 'other-dir')
    fs.mkdirSync(otherDir, { recursive: true })
    fs.writeFileSync(path.join(otherDir, 'feature.config.cjs'), configCjs('checkout', repoDir))
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: 'no docs landed in features/<f>/docs/' })
  })

  it('legacy use-repo-docs choice degrades to the collect-repo-docs agent path', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => {
      fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'checkout-prd.md'), '# Requirements')
      return { text: 'collected' }
    }
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'use-repo-docs' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'agent-repo-docs' } })
  })

  it('userDocs skips a dangling symlink instead of throwing (statSync follows the link)', async () => {
    const docsDir = path.join(featuresDir, 'checkout', 'docs')
    fs.symlinkSync(path.join(tmpDir, 'does-not-exist.md'), path.join(docsDir, 'dangling.md'))
    const outcome = await docsStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'prd-source', data: { docs: [] } },
    })
  })

  it('intentDocPaths ignores an intent-referenced path that does not exist on disk', async () => {
    const bogus = path.join(tmpDir, 'never-created.md')
    const m = manifest({ description: `test checkout, refer to ${bogus}` })
    const parked = await docsStage(deps()).run(ctxFor(m).ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    expect((parked.checkpoint.data as { linked: string[] }).linked).toEqual([])
  })

  it('expands a "~"-prefixed intent doc path before linking it', async () => {
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir
    try {
      const prdPath = path.join(tmpDir, 'home-prd.md')
      fs.writeFileSync(prdPath, '# Home PRD\nthe checkout flow')
      const m = manifest({ description: 'test checkout, refer to ~/home-prd.md' })
      const parked = await docsStage(deps()).run(ctxFor(m).ctx)
      if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
      expect((parked.checkpoint.data as { linked: string[] }).linked).toEqual([path.join('docs', 'home-prd.md')])
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })

  it('logs (and skips) when linking an intent doc fails — e.g. the flight points at an unknown feature', async () => {
    const prdPath = path.join(tmpDir, 'external-prd-ghost.md')
    fs.writeFileSync(prdPath, '# External PRD\nthe checkout flow')
    const m = manifest({ feature: 'ghost-feature', description: `refer to ${prdPath}` })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'prd-source', data: { linked: [] } },
    })
  })

  it('logs "copied" instead of "linked" when the symlink write falls back to a copy', async () => {
    const prdPath = path.join(tmpDir, 'external-prd-copy.md')
    fs.writeFileSync(prdPath, '# External PRD copy\nthe checkout flow')
    const symlinkSpy = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('EPERM: symlinks unavailable')
    })
    try {
      const m = manifest({ description: `refer to ${prdPath}` })
      const parked = await docsStage(deps()).run(ctxFor(m).ctx)
      if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
      expect((parked.checkpoint.data as { linked: string[] }).linked).toEqual([path.join('docs', 'external-prd-copy.md')])
      const dest = path.join(featuresDir, 'checkout', 'docs', 'external-prd-copy.md')
      expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false)
      expect(fs.readFileSync(dest, 'utf-8')).toContain('External PRD copy')
    } finally {
      symlinkSpy.mockRestore()
    }
  })

  it('yolo with both existing docs AND an intent-linked doc reports "intent-linked" as the source', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD\nreal doc')
    const prdPath = path.join(tmpDir, 'external-prd-yolo.md')
    fs.writeFileSync(prdPath, '# External PRD\nthe checkout flow')
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true }, description: `refer to ${prdPath}` })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'intent-linked' } })
  })
})
