// The run-start suite snapshot (D9): the run executes a copy of
// features/<suite>/ taken before any service or agent starts, so a spec edited
// mid-run cannot reach the process that produces the verdict.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { adoptSpecEdits, adoptTestHealSpecEdits, digestOfSpecHashes, recordSpecEdits, refreshSpecEdits, restoreReviewedSuiteFiles, restoreSpecEdits, snapshotSuite, suiteDigest } from './run-suite-snapshot'
import { hashFeatureSpecs } from '../dirty-specs/detect'
import { suiteReviewRevision } from './suite-review'
import { writeManifest, type RunManifest } from './manifest'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import type { RunContext } from './run-context'
import type { RunnerLog } from './runner-log'
import { cleanupSuiteRuntimeInputsForRun, materializeSuiteRuntimeInputs, removeSuiteRuntimeInputs, suiteRuntimeInputTargets, suiteRuntimeInputTargetsForSnapshot } from './suite-runtime-inputs'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-suite-snap-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function ctxFor(state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  const made = makeHealLoopContext({ root: tmpDir, opts, state })
  fs.mkdirSync(made.ctx.runDir, { recursive: true })
  return made
}

function write(dir: string, rel: string, body: string): void {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

function fakeRunnerLog(): RunnerLog & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    warn: (m: string) => { warnings.push(m) },
    info: () => {},
    error: () => {},
  } as unknown as RunnerLog & { warnings: string[] }
}

function configureSuiteEnvTarget(ctx: RunContext, target = '.env', body = 'SECRET=selected\n'): string {
  const live = ctx.feature.featureDir
  write(live, 'envsets/local/app.env', body)
  write(live, 'envsets/envsets.config.json', JSON.stringify({
    appRoots: {},
    slots: { 'app.env': { description: 'test env', target: path.join(live, target) } },
    feature: { slots: ['app.env'], testCommand: 'npx playwright test', testCwd: live },
  }))
  write(live, target, body)
  return path.join(live, target)
}

const SPEC_A = "test('a', async () => { expect(1).toBe(1) })\n"

describe('snapshotSuite', () => {
  it('does not record whole-suite restoration when the legacy action leaves a helper changed', () => {
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    write(ctx.feature.featureDir, 'e2e/fixture.ts', 'recorded')
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', `${SPEC_A}// edited`)
    write(ctx.feature.featureDir, 'e2e/fixture.ts', 'edited helper')
    expect(restoreSpecEdits(ctx)).toEqual({ ok: true, restored: ['e2e/a.spec.ts'] })
    expect(sink.patches.at(-1)?.specEdits?.reviewDecisions).toBeUndefined()
    expect(fs.readFileSync(path.join(ctx.feature.featureDir, 'e2e/fixture.ts'), 'utf8')).toBe('edited helper')
  })
  it('reports when an exact restore has no reviewed files', () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    const revision = suiteReviewRevision(ctx.suiteDir, ctx.feature.featureDir)
    expect(restoreReviewedSuiteFiles(ctx.suiteDir, ctx.feature.featureDir, revision)).toEqual({ ok: false, reason: 'nothing-to-restore' })
  })
  it('restores exactly reviewed supporting-file additions, deletions and changes', () => {
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/fixture.ts', 'old fixture')
    write(ctx.feature.featureDir, 'e2e/deleted.ts', 'recorded')
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/fixture.ts', 'new fixture')
    write(ctx.feature.featureDir, 'e2e/added.ts', 'added')
    fs.unlinkSync(path.join(ctx.feature.featureDir, 'e2e/deleted.ts'))
    const revision = suiteReviewRevision(ctx.suiteDir, ctx.feature.featureDir)
    expect(restoreSpecEdits(ctx, revision)).toEqual({ ok: true, restored: ['e2e/added.ts', 'e2e/deleted.ts', 'e2e/fixture.ts'] })
    expect(fs.readFileSync(path.join(ctx.feature.featureDir, 'e2e/fixture.ts'), 'utf8')).toBe('old fixture')
    expect(fs.readFileSync(path.join(ctx.feature.featureDir, 'e2e/deleted.ts'), 'utf8')).toBe('recorded')
    expect(fs.existsSync(path.join(ctx.feature.featureDir, 'e2e/added.ts'))).toBe(false)
    expect(sink.patches.at(-1)?.specEdits?.reviewDecisions).toContainEqual(expect.objectContaining({ revision, decision: 'restored' }))
  })
  it('refuses stale restore approval without discarding the newer edit', () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/fixture.ts', 'recorded')
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/fixture.ts', 'reviewed')
    const revision = suiteReviewRevision(ctx.suiteDir, ctx.feature.featureDir)
    write(ctx.feature.featureDir, 'e2e/fixture.ts', 'newer')
    expect(restoreSpecEdits(ctx, revision)).toEqual({ ok: false, reason: 'review-changed' })
    expect(fs.readFileSync(path.join(ctx.feature.featureDir, 'e2e/fixture.ts'), 'utf8')).toBe('newer')
  })
  it('refuses a symlink restore before writing any reviewed file', () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/fixture.ts', 'recorded')
    snapshotSuite(ctx)
    const outside = path.join(tmpDir, 'outside'); fs.mkdirSync(outside)
    write(outside, 'fixture.ts', 'private')
    fs.rmSync(path.join(ctx.feature.featureDir, 'e2e'), { recursive: true })
    fs.symlinkSync(outside, path.join(ctx.feature.featureDir, 'e2e'))
    const revision = suiteReviewRevision(ctx.suiteDir, ctx.feature.featureDir)
    expect(restoreSpecEdits(ctx, revision)).toEqual({ ok: false, reason: 'restore-failed' })
    expect(fs.readFileSync(path.join(outside, 'fixture.ts'), 'utf8')).toBe('private')
  })
  it('also rejects symlinks and missing snapshot paths through the legacy restore action', () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', `${SPEC_A}// changed`)
    const outside = path.join(tmpDir, 'legacy-outside')
    fs.mkdirSync(outside)
    fs.rmSync(path.join(ctx.feature.featureDir, 'e2e'), { recursive: true })
    fs.symlinkSync(outside, path.join(ctx.feature.featureDir, 'e2e'))
    expect(restoreSpecEdits(ctx)).toEqual({ ok: false, reason: 'restore-failed' })

    fs.rmSync(ctx.feature.featureDir, { recursive: true, force: true })
    fs.mkdirSync(path.join(ctx.feature.featureDir, 'e2e'), { recursive: true })
    write(ctx.feature.featureDir, 'e2e/added.spec.ts', SPEC_A)
    expect(restoreSpecEdits(ctx)).toMatchObject({ ok: true, restored: expect.arrayContaining(['e2e/added.spec.ts']) })
  })
  it('adopts a reviewed helper-only correction without requiring an unrelated spec edit', async () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    write(ctx.feature.featureDir, 'e2e/helper.ts', 'export const value = 1')
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/helper.ts', 'export const value = 2')
    const revision = suiteReviewRevision(ctx.suiteDir, ctx.feature.featureDir)
    const result = await adoptSpecEdits(ctx, revision)
    expect(result).toMatchObject({ ok: true, adopted: ['e2e/helper.ts'] })
    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e/helper.ts'), 'utf8')).toBe('export const value = 2')
  })
  it('copies the suite under the run dir and points the run at the copy', () => {
    const { ctx, sink } = ctxFor()
    const live = ctx.feature.featureDir
    write(live, 'e2e/a.spec.ts', SPEC_A)
    write(live, 'e2e/helpers/api.ts', 'export const api = 1\n')
    write(live, 'playwright.config.ts', 'export default {}\n')
    write(live, 'feature.config.cjs', 'module.exports = {}\n')

    snapshotSuite(ctx)

    expect(ctx.suiteDir).toBe(ctx.paths.suiteSnapshotDir)
    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e', 'a.spec.ts'), 'utf8')).toBe(SPEC_A)
    expect(fs.existsSync(path.join(ctx.suiteDir, 'e2e', 'helpers', 'api.ts'))).toBe(true)
    expect(fs.existsSync(path.join(ctx.suiteDir, 'playwright.config.ts'))).toBe(true)
    expect(sink.patches).toEqual([{
      suiteSnapshot: {
        kind: 'taken',
        dir: ctx.paths.suiteSnapshotDir,
        takenAt: expect.any(String),
        digest: suiteDigest(live),
      },
    }])
  })

  it('leaves envsets, materialized env targets, backups, node_modules and .git out of the copy', () => {
    // Envsets carry secrets and are read from the live dir by the env switcher;
    // its target and backup are runtime state, node_modules resolves by walking
    // up from the copy, and .git is never suite content.
    const { ctx } = ctxFor()
    const live = ctx.feature.featureDir
    write(live, 'e2e/a.spec.ts', SPEC_A)
    write(live, 'envsets/local/api.env', 'SECRET=1\n')
    write(live, '.env', 'SECRET=1\n')
    write(live, '.env.bak.1789653324105', 'OLD_SECRET=1\n')
    write(live, 'node_modules/pkg/index.js', '')
    write(live, '.git/HEAD', 'ref: refs/heads/main\n')

    snapshotSuite(ctx)

    expect(fs.readdirSync(ctx.suiteDir).sort()).toEqual(['.canary-suite-tests.json', 'e2e'])
  })

  it('copies authored docs but leaves engine-owned coverage state out of the run snapshot', () => {
    const { ctx } = ctxFor()
    const live = ctx.feature.featureDir
    write(live, 'e2e/a.spec.ts', SPEC_A)
    write(live, 'docs/requirements.md', '# Requirements\n')
    write(live, 'docs/_coverage-state.json', '{"requirementsHash":"generated"}\n')

    snapshotSuite(ctx)

    expect(fs.readFileSync(path.join(ctx.suiteDir, 'docs/requirements.md'), 'utf8')).toBe('# Requirements\n')
    expect(fs.existsSync(path.join(ctx.suiteDir, 'docs/_coverage-state.json'))).toBe(false)
  })

  it('materializes a selected .env only while the suite snapshot is executable', () => {
    const { ctx } = ctxFor({}, { env: 'local' })
    const live = ctx.feature.featureDir
    write(live, 'e2e/a.spec.ts', SPEC_A)
    configureSuiteEnvTarget(ctx)

    snapshotSuite(ctx)

    const runtimeEnv = path.join(ctx.suiteDir, '.env')
    expect(fs.readFileSync(runtimeEnv, 'utf8')).toBe('SECRET=selected\n')
    expect(fs.statSync(runtimeEnv).mode & 0o777).toBe(0o600)
    removeSuiteRuntimeInputs(ctx)
    expect(fs.existsSync(runtimeEnv)).toBe(false)
    expect(fs.existsSync(ctx.paths.suiteRuntimeInputsDir)).toBe(false)
    const retainedInventory = fs.readFileSync(ctx.paths.suiteRuntimeInputsInventoryPath, 'utf8')
    expect(retainedInventory).not.toContain('SECRET=selected')
    expect(retainedInventory).not.toContain('sha256')
    expect(JSON.parse(retainedInventory)).toMatchObject({ state: 'cleaned', entries: [{ relativeTarget: '.env' }] })
  })

  it('reuses run-owned resolved bytes when a crashed run resumes after the shared target changed', () => {
    const { ctx } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    const sharedTarget = configureSuiteEnvTarget(ctx)
    snapshotSuite(ctx)
    fs.writeFileSync(sharedTarget, 'SECRET=mutated-after-capture\n')
    fs.rmSync(path.join(ctx.suiteDir, '.env'))

    expect(materializeSuiteRuntimeInputs(ctx)).toEqual(['.env'])
    expect(fs.readFileSync(path.join(ctx.suiteDir, '.env'), 'utf8')).toBe('SECRET=selected\n')
  })

  it('fails setup before tests when a selected suite-local target vanished', () => {
    const { ctx } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    const target = configureSuiteEnvTarget(ctx)
    fs.rmSync(target)

    expect(() => snapshotSuite(ctx)).toThrow(/Selected envset target app\.env vanished before run setup/)
    expect(ctx.suiteDir).toBe(ctx.feature.featureDir)
    expect(fs.existsSync(ctx.paths.suiteSnapshotDir)).toBe(false)
  })

  it('fails setup when a selected target is a directory rather than a file', () => {
    const { ctx } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    write(ctx.feature.featureDir, 'envsets/local/app.env', 'SECRET=selected\n')
    const target = path.join(ctx.feature.featureDir, 'runtime')
    fs.mkdirSync(target)
    write(ctx.feature.featureDir, 'envsets/envsets.config.json', JSON.stringify({
      appRoots: {},
      slots: { 'app.env': { description: 'test env', target } },
      feature: { slots: ['app.env'], testCommand: 'npx playwright test', testCwd: ctx.feature.featureDir },
    }))

    expect(() => snapshotSuite(ctx)).toThrow(/Selected envset target app\.env must be a regular file/)
    expect(fs.existsSync(ctx.paths.suiteRuntimeInputsDir)).toBe(false)
  })

  it('refuses a selected target that traverses a symlink inside the feature', () => {
    const { ctx } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    const target = configureSuiteEnvTarget(ctx)
    const outside = path.join(tmpDir, 'runtime-input-outside')
    fs.writeFileSync(outside, 'SECRET=outside\n')
    fs.rmSync(target)
    fs.symlinkSync(outside, target)

    expect(() => snapshotSuite(ctx)).toThrow(/Selected envset target app\.env traverses a symlink/)
  })

  it('leaves an envset target outside the copied feature to its owning workspace', () => {
    const { ctx } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    write(ctx.feature.featureDir, 'envsets/local/app.env', 'SECRET=selected\n')
    const externalTarget = path.join(tmpDir, 'workspace-owned.env')
    fs.writeFileSync(externalTarget, 'SECRET=workspace\n')
    write(ctx.feature.featureDir, 'envsets/envsets.config.json', JSON.stringify({
      appRoots: {},
      slots: { 'app.env': { description: 'workspace target', target: externalTarget } },
      feature: { slots: ['app.env'], testCommand: 'npx playwright test', testCwd: ctx.feature.featureDir },
    }))

    snapshotSuite(ctx)

    expect(suiteRuntimeInputTargets(ctx)).toEqual([])
    expect(fs.existsSync(path.join(ctx.suiteDir, path.basename(externalTarget)))).toBe(false)
  })

  it('treats malformed retained runtime-input inventories as unavailable to review readers', () => {
    const { ctx } = ctxFor()
    fs.mkdirSync(ctx.runDir, { recursive: true })
    fs.writeFileSync(ctx.paths.suiteRuntimeInputsInventoryPath, JSON.stringify({ version: 2, entries: [] }))
    expect(suiteRuntimeInputTargetsForSnapshot(ctx.paths.suiteSnapshotDir)).toEqual([])
    fs.writeFileSync(ctx.paths.suiteRuntimeInputsInventoryPath, JSON.stringify({ version: 1, entries: [{}] }))
    expect(suiteRuntimeInputTargetsForSnapshot(ctx.paths.suiteSnapshotDir)).toEqual([])
  })

  it('fails closed on a broken retained input and skips runtime materialization when no copy is active', () => {
    const { ctx } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    configureSuiteEnvTarget(ctx)
    snapshotSuite(ctx)
    fs.rmSync(path.join(ctx.paths.suiteRuntimeInputsDir, '000.input'))

    expect(() => materializeSuiteRuntimeInputs(ctx)).toThrow(/runtime inputs are unavailable/)
    const noEnv = ctxFor().ctx
    noEnv.env = undefined
    expect(materializeSuiteRuntimeInputs(noEnv)).toEqual([])
    const liveEnv = ctxFor({}, { env: 'local' }).ctx
    liveEnv.suiteDir = liveEnv.feature.featureDir
    expect(materializeSuiteRuntimeInputs(liveEnv)).toEqual([])

    fs.writeFileSync(ctx.paths.suiteRuntimeInputsInventoryPath, JSON.stringify({ version: 2, entries: [] }))
    expect(suiteRuntimeInputTargets(ctx)).toEqual([])
  })

  it('fails closed when retained runtime input storage is replaced with a directory', () => {
    const { ctx } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    configureSuiteEnvTarget(ctx)
    snapshotSuite(ctx)
    const stored = path.join(ctx.paths.suiteRuntimeInputsDir, '000.input')
    fs.rmSync(stored)
    fs.mkdirSync(stored)

    expect(() => materializeSuiteRuntimeInputs(ctx)).toThrow(/runtime inputs are unavailable/)
  })

  it('does not retain a partial snapshot when materializing the private runtime input fails', () => {
    const { ctx, sink } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    configureSuiteEnvTarget(ctx)
    const realCopy = fs.copyFileSync
    vi.spyOn(fs, 'copyFileSync').mockImplementation(((source: fs.PathLike, destination: fs.PathLike, mode?: number) => {
      if (String(source).endsWith('000.input')) throw 'private input copy failed'
      return realCopy(source, destination, mode)
    }) as typeof fs.copyFileSync)

    expect(() => snapshotSuite(ctx)).toThrow(/Suite runtime input setup failed.*private input copy failed/)
    expect(ctx.suiteDir).toBe(ctx.feature.featureDir)
    expect(fs.existsSync(ctx.paths.suiteSnapshotDir)).toBe(false)
    expect(sink.patches.at(-1)).toMatchObject({ suiteSnapshot: { kind: 'unavailable', reason: 'private input copy failed' } })
  })

  it('rejects malformed cleanup inventories before touching the suite snapshot', () => {
    const { ctx } = ctxFor()
    fs.mkdirSync(ctx.runDir, { recursive: true })
    fs.writeFileSync(ctx.paths.suiteRuntimeInputsInventoryPath, JSON.stringify({ version: 2, entries: [] }))
    expect(() => cleanupSuiteRuntimeInputsForRun(ctx.runDir)).toThrow(/Invalid suite runtime input cleanup inventory/)
    fs.writeFileSync(ctx.paths.suiteRuntimeInputsInventoryPath, JSON.stringify({ version: 1, entries: [{}] }))
    expect(() => cleanupSuiteRuntimeInputsForRun(ctx.runDir)).toThrow('Invalid suite runtime input cleanup target')
    fs.writeFileSync(ctx.paths.suiteRuntimeInputsInventoryPath, JSON.stringify({
      version: 1, state: 'active', runId: ctx.runId, env: ctx.env, capturedAt: 'now',
      entries: [{ relativeTarget: '../escape', storedAs: '000.input', sha256: 'ignored' }],
    }))
    expect(() => cleanupSuiteRuntimeInputsForRun(ctx.runDir)).toThrow(/escapes its owned directory/)
  })

  it('does not rewrite an inventory that was already scrubbed', () => {
    const { ctx } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    configureSuiteEnvTarget(ctx)
    snapshotSuite(ctx)
    removeSuiteRuntimeInputs(ctx)
    const before = fs.readFileSync(ctx.paths.suiteRuntimeInputsInventoryPath, 'utf8')
    cleanupSuiteRuntimeInputsForRun(ctx.runDir)
    expect(fs.readFileSync(ctx.paths.suiteRuntimeInputsInventoryPath, 'utf8')).toBe(before)
  })

  it('keeps non-dotenv runtime targets out of retained snapshots and review bytes', async () => {
    const { ctx } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    configureSuiteEnvTarget(ctx, 'runtime/private.json', '{"token":"do-not-retain"}\n')
    snapshotSuite(ctx)

    expect(fs.readFileSync(path.join(ctx.suiteDir, 'runtime/private.json'), 'utf8')).toContain('do-not-retain')
    expect(suiteRuntimeInputTargets(ctx)).toEqual(['runtime/private.json'])
    removeSuiteRuntimeInputs(ctx)
    expect(fs.existsSync(path.join(ctx.suiteDir, 'runtime/private.json'))).toBe(false)
    const excluded = suiteRuntimeInputTargetsForSnapshot(ctx.suiteDir)
    expect(excluded).toEqual(['runtime/private.json'])
    const review = await import('./suite-review').then(({ buildSuiteReview }) => buildSuiteReview(ctx.suiteDir, ctx.feature.featureDir, excluded))
    expect(review.files).toEqual([])
    expect(review.patch).not.toContain('do-not-retain')
  })

  it('adopts edited tests while rematerializing the originally captured runtime bytes', async () => {
    const { ctx } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    const sharedTarget = configureSuiteEnvTarget(ctx)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', `${SPEC_A}// reviewed edit\n`)
    fs.writeFileSync(sharedTarget, 'SECRET=newer-shared-value\n')
    const revision = suiteReviewRevision(ctx.suiteDir, ctx.feature.featureDir, suiteRuntimeInputTargets(ctx))

    expect(await adoptSpecEdits(ctx, revision)).toMatchObject({ ok: true, adopted: ['e2e/a.spec.ts'] })
    expect(fs.readFileSync(path.join(ctx.suiteDir, '.env'), 'utf8')).toBe('SECRET=selected\n')
  })

  it('captures only the exact terminal-approved revision into a new run', () => {
    const { ctx } = ctxFor({}, { testReviewApproval: { sourceRunId: 'old-run', revision: '', approvedAt: 'now' } })
    const source = path.join(path.dirname(ctx.runDir), 'old-run', 'suite')
    write(source, 'e2e/a.spec.ts', SPEC_A)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', `${SPEC_A}// approved\n`)
    const revision = suiteReviewRevision(source, ctx.feature.featureDir)
    ;(ctx.testReviewApproval as { revision: string }).revision = revision

    snapshotSuite(ctx)
    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e/a.spec.ts'), 'utf8')).toContain('// approved')

    fs.appendFileSync(path.join(ctx.feature.featureDir, 'e2e/a.spec.ts'), '// stale after approval\n')
    fs.rmSync(ctx.paths.suiteSnapshotDir, { recursive: true, force: true })
    ctx.suiteDir = ctx.feature.featureDir
    expect(() => snapshotSuite(ctx)).toThrow(/Approved test review changed before snapshot capture/)
    expect(fs.existsSync(ctx.paths.suiteSnapshotDir)).toBe(false)
  })

  it('fails closed if an approved byte changes while the snapshot is copied', () => {
    const { ctx, sink } = ctxFor({}, { testReviewApproval: { sourceRunId: 'old-run', revision: '', approvedAt: 'now' } })
    const source = path.join(path.dirname(ctx.runDir), 'old-run', 'suite')
    write(source, 'e2e/a.spec.ts', SPEC_A)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', `${SPEC_A}// approved\n`)
    ;(ctx.testReviewApproval as { revision: string }).revision = suiteReviewRevision(source, ctx.feature.featureDir)
    const realCopy = fs.copyFileSync
    vi.spyOn(fs, 'copyFileSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike, mode?: number) => {
      const copied = realCopy(from, to, mode)
      if (String(to) === path.join(ctx.paths.suiteSnapshotDir, 'e2e/a.spec.ts')) fs.appendFileSync(to, '// changed during copy\n')
      return copied
    }) as typeof fs.copyFileSync)

    expect(() => snapshotSuite(ctx)).toThrow(/Approved test review snapshot capture failed/)
    expect(sink.patches.at(-1)).toMatchObject({ suiteSnapshot: { kind: 'unavailable' } })
  })

  it('a mid-run edit to the live spec leaves the copy untouched', () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)

    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', async () => {})\n")

    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e', 'a.spec.ts'), 'utf8')).toBe(SPEC_A)
  })

  it('replaces a stale copy so a re-snapshot (adopt) carries exactly the current suite', () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    write(ctx.paths.suiteSnapshotDir, 'e2e/old.spec.ts', 'gone\n')

    snapshotSuite(ctx)

    expect(fs.existsSync(path.join(ctx.suiteDir, 'e2e', 'old.spec.ts'))).toBe(false)
    expect(fs.existsSync(path.join(ctx.suiteDir, 'e2e', 'a.spec.ts'))).toBe(true)
  })

  it('falls back to the live dir, records why on the manifest, and warns when the copy fails', () => {
    // The boundary is best-effort at boot: a run that cannot copy its suite
    // still runs, but the manifest says so — a silent fallback would let the
    // UI and MCP results claim a boundary that was never there.
    const runnerLog = fakeRunnerLog()
    const { ctx, sink } = ctxFor({}, { runnerLog })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('EACCES: denied') })

    snapshotSuite(ctx)

    expect(ctx.suiteDir).toBe(ctx.feature.featureDir)
    expect(sink.patches).toEqual([{
      suiteSnapshot: { kind: 'unavailable', at: expect.any(String), reason: expect.stringContaining('EACCES') },
    }])
    expect(runnerLog.warnings[0]).toContain('EACCES')
  })

  it('stringifies a non-Error throw rather than recording "undefined"', () => {
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw 'disk full' })

    snapshotSuite(ctx)

    expect(sink.patches[0]).toMatchObject({ suiteSnapshot: { kind: 'unavailable', reason: 'disk full' } })
  })

  it('retains an Error message when runtime input setup cannot copy the retained bytes', () => {
    const { ctx, sink } = ctxFor({}, { env: 'local' })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    configureSuiteEnvTarget(ctx)
    const copy = fs.copyFileSync
    vi.spyOn(fs, 'copyFileSync').mockImplementation(((source: fs.PathLike, target: fs.PathLike, mode?: number) => {
      if (String(source).endsWith('000.input')) throw new Error('retained input denied')
      return copy(source, target, mode)
    }) as typeof fs.copyFileSync)

    expect(() => snapshotSuite(ctx)).toThrow(/retained input denied/)
    expect(sink.patches.at(-1)).toMatchObject({ suiteSnapshot: { kind: 'unavailable', reason: 'retained input denied' } })
  })
})

describe('recordSpecEdits', () => {
  it('writes the live edits the run has not executed onto the manifest', () => {
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', async () => {})\n")

    recordSpecEdits(ctx)

    const patch = sink.patches.at(-1) as { specEdits: RunManifest['specEdits'] }
    expect(patch.specEdits).toMatchObject({
      checkedAt: expect.any(String),
      pending: [{ file: 'e2e/a.spec.ts', change: 'modified', affectedTests: ['a'], strength: { verdict: 'weaker' } }],
      adopted: [],
    })
  })

  it('hints on a spec deleted since run start without its @req ids — there is no live file to read them from', () => {
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', { tag: ['@req-cart-1'] }, async () => { expect(1).toBe(1) })\n")
    snapshotSuite(ctx)
    fs.rmSync(path.join(ctx.feature.featureDir, 'e2e', 'a.spec.ts'))

    recordSpecEdits(ctx)

    const patch = sink.patches.at(-1) as { specEdits: RunManifest['specEdits']; integrity: RunManifest['integrity'] }
    expect(patch.specEdits?.pending).toMatchObject([{ file: 'e2e/a.spec.ts', change: 'deleted' }])
    expect(patch.integrity?.hints).toEqual([expect.objectContaining({ kind: 'weaker', file: 'e2e/a.spec.ts', test: 'a' })])
    expect(patch.integrity?.hints[0]).not.toHaveProperty('requirements')
  })

  it('writes the integrity hints and their disclosure beside the pending edits', () => {
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', { tag: ['@req-cart-1'] }, async () => { expect(1).toBe(1); expect(2).toBe(2) })\n")
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', { tag: ['@req-cart-1'] }, async () => { expect(1).toBe(1) })\n")

    recordSpecEdits(ctx)

    const patch = sink.patches.at(-1) as { integrity: RunManifest['integrity'] }
    expect(patch.integrity).toEqual({
      hints: [{ kind: 'weaker', file: 'e2e/a.spec.ts', test: 'a', requirements: ['cart-1'], was: ['expect(2).toBe(2)'], now: [] }],
      disclosure: expect.stringContaining('No human labelled them.'),
    })
  })

  it('keeps the adopted history already on the manifest', () => {
    // Adoption is appended by the adopt route; a routine re-check after a
    // Playwright exit must not wipe that record.
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    const adopted = [{ at: '2026-09-06T00:00:00.000Z', by: 'human' as const, files: ['e2e/a.spec.ts'] }]
    writeManifest(ctx.paths.manifestPath, {
      runId: ctx.runId, feature: 'demo', startedAt: '', status: 'running', healCycles: 0, services: [],
      specEdits: { checkedAt: '', pending: [], adopted },
    })

    recordSpecEdits(ctx)

    expect((sink.patches.at(-1) as { specEdits: RunManifest['specEdits'] }).specEdits).toMatchObject({ pending: [], adopted })
  })

  it('records nothing when the run has no snapshot to compare against', () => {
    // Without a copy there is no boundary; a `pending: []` here would read as
    // "no edits" when the truth is "we cannot tell".
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)

    recordSpecEdits(ctx)

    expect(sink.patches).toEqual([])
  })
})

describe('adoptSpecEdits', () => {
  const WEAKER = "test('a', async () => {})\n"

  it('refuses while Playwright is running the current copy', async () => {
    const { ctx } = ctxFor({ playwrightPty: { pid: 1 } as unknown as RunContext['playwrightPty'] })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)

    expect(await adoptSpecEdits(ctx)).toEqual({ ok: false, reason: 'tests-running' })
  })

  it('refuses when the live suite already matches the copy', async () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)

    expect(await adoptSpecEdits(ctx)).toEqual({ ok: false, reason: 'nothing-to-adopt' })
  })

  it('re-takes the snapshot, re-baselines the dirty record, records the adoption and signals a rerun', async () => {
    const captureRunStart = vi.fn(async () => ({}))
    const { ctx, sink } = ctxFor({}, { dirtySpecHooks: { captureRunStart, finalizeRun: vi.fn() } })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)
    recordSpecEdits(ctx)
    ctx.signalGate.beginWaiting()

    const result = await adoptSpecEdits(ctx)

    expect(result).toEqual({ ok: true, adopted: ['e2e/a.spec.ts'], rerun: 'signalled' })
    // The copy now holds the adopted content and the baseline was re-taken from it.
    expect(fs.readFileSync(path.join(ctx.paths.suiteSnapshotDir, 'e2e', 'a.spec.ts'), 'utf8')).toBe(WEAKER)
    expect(captureRunStart).toHaveBeenLastCalledWith('demo', ctx.paths.suiteSnapshotDir)
    const last = sink.patches.at(-1) as { specEdits: RunManifest['specEdits']; integrity: RunManifest['integrity'] }
    expect(last.specEdits).toMatchObject({ pending: [], adopted: [{ at: expect.any(String), by: 'human', files: ['e2e/a.spec.ts'] }] })
    // Adopted means accepted: the hints that described the pending edit are gone.
    expect(last.integrity).toMatchObject({ hints: [] })
    // The rerun signal carries the human's authorship so the journal reads right.
    expect(ctx.signalGate.consume()).toMatchObject({ kind: 'rerun', body: { adoptedSpecEdits: ['e2e/a.spec.ts'] } })
  })

  it('keeps edits that arrive while adoption re-baselines as pending integrity evidence', async () => {
    const { ctx, sink } = ctxFor({}, {
      dirtySpecHooks: {
        captureRunStart: async () => { fs.appendFileSync(path.join(ctx.feature.featureDir, 'e2e/a.spec.ts'), '// edited while baselining\n') },
        finalizeRun: vi.fn(),
      },
    })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)

    await expect(adoptSpecEdits(ctx)).resolves.toMatchObject({ ok: true, adopted: ['e2e/a.spec.ts'] })
    const last = sink.patches.at(-1) as { specEdits: RunManifest['specEdits']; integrity: RunManifest['integrity'] }
    expect(last.specEdits?.pending).toEqual([expect.objectContaining({ file: 'e2e/a.spec.ts' })])
    expect(last.integrity).toBeDefined()
  })

  it('recomputes integrity hints from the live bytes that change during adoption', async () => {
    const { ctx, sink } = ctxFor({}, {
      dirtySpecHooks: {
        captureRunStart: async () => {
          write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', { tag: ['@req-cart-1'] }, async () => { expect(1).toBe(1) })\n")
        },
        finalizeRun: vi.fn(),
      },
    })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', { tag: ['@req-cart-1'] }, async () => { expect(1).toBe(1); expect(2).toBe(2) })\n")
    snapshotSuite(ctx)
    fs.appendFileSync(path.join(ctx.feature.featureDir, 'e2e/a.spec.ts'), '// approved edit\n')

    await expect(adoptSpecEdits(ctx)).resolves.toMatchObject({ ok: true })
    expect((sink.patches.at(-1) as { integrity: RunManifest['integrity'] }).integrity?.hints).toEqual([
      expect.objectContaining({ kind: 'weaker', file: 'e2e/a.spec.ts', test: 'a', requirements: ['cart-1'] }),
    ])
  })

  it('records integrity hints when a further live edit lands during the reviewed snapshot swap', async () => {
    const { ctx, sink } = ctxFor()
    const original = "test('a', { tag: ['@req-cart-1'] }, async () => { expect(1).toBe(1); expect(2).toBe(2) })\n"
    const reviewed = "test('a', { tag: ['@req-cart-1'] }, async () => { expect(1).toBe(1) })\n"
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', original)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', reviewed)
    const revision = suiteReviewRevision(ctx.suiteDir, ctx.feature.featureDir)
    const copy = fs.copyFileSync
    vi.spyOn(fs, 'copyFileSync').mockImplementation(((source: fs.PathLike, target: fs.PathLike, mode?: number) => {
      const copied = copy(source, target, mode)
      if (String(target).includes(`${path.sep}candidate${path.sep}e2e${path.sep}a.spec.ts`)) {
        write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', { tag: ['@req-cart-1'] }, async () => {})\n")
      }
      return copied
    }) as typeof fs.copyFileSync)

    await expect(adoptSpecEdits(ctx, revision)).resolves.toMatchObject({ ok: true })
    expect((sink.patches.at(-1) as { integrity: RunManifest['integrity'] }).integrity?.hints).toEqual([
      expect.objectContaining({ kind: 'weaker', file: 'e2e/a.spec.ts', test: 'a', requirements: ['cart-1'] }),
    ])
  })

  it('reports when no rerun could be signalled because the loop is not waiting for one', async () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)

    expect(await adoptSpecEdits(ctx)).toMatchObject({ ok: true, rerun: 'not-waiting-for-signal' })
  })

  it('takes a first snapshot when the run had none (the boundary was unavailable at boot)', async () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)

    const result = await adoptSpecEdits(ctx)

    expect(result).toMatchObject({ ok: true, adopted: ['e2e/a.spec.ts'] })
    expect(ctx.suiteDir).toBe(ctx.paths.suiteSnapshotDir)
  })

  it('fails closed when the re-snapshot cannot be taken', async () => {
    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('EACCES') })

    expect(await adoptSpecEdits(ctx)).toEqual({ ok: false, reason: 'snapshot-failed' })
  })

  // The two failures that land AFTER the reviewed copy is already in place. The
  // run's verdict is measured against that copy, so a half-installed one is
  // worse than a refused adoption.
  function installed(runnerLog: RunnerLog) {
    const { ctx } = ctxFor({}, { runnerLog })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)
    recordSpecEdits(ctx)
    return ctx
  }

  it('rolls the executed copy back when the manifest write fails', async () => {
    const runnerLog = fakeRunnerLog()
    const ctx = installed(runnerLog)
    vi.spyOn(ctx.stateSink, 'patchManifest').mockImplementation(() => { throw new Error('manifest locked') })

    expect(await adoptSpecEdits(ctx)).toEqual({ ok: false, reason: 'snapshot-failed' })
    // The bytes the run actually executed are back, not the adopted edit.
    expect(fs.readFileSync(path.join(ctx.paths.suiteSnapshotDir, 'e2e', 'a.spec.ts'), 'utf8')).toBe(SPEC_A)
    expect(runnerLog.warnings.join('\n')).toContain('reviewed suite snapshot failed: manifest locked')
  })

  it('says where the original was left when the rollback itself fails', async () => {
    const runnerLog = fakeRunnerLog()
    const ctx = installed(runnerLog)
    // A non-Error throw: the log line is the only record of what happened, so it
    // has to stay readable for anything a collaborator can throw.
    vi.spyOn(ctx.stateSink, 'patchManifest').mockImplementation(() => { throw 'manifest locked' })
    const realRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith(`${path.sep}original`)) throw new Error('EPERM')
      return realRename(from, to)
    })

    expect(await adoptSpecEdits(ctx)).toEqual({ ok: false, reason: 'snapshot-failed' })
    const warned = runnerLog.warnings.join('\n')
    // Unfindable original bytes would be the same as losing them.
    expect(warned).toMatch(/suite rollback failed; original retained at .*\.review-/)
    expect(warned).toContain('reviewed suite snapshot failed: manifest locked')
    expect(fs.existsSync(path.join(warned.match(/retained at (\S+):/)![1], 'original', 'e2e', 'a.spec.ts'))).toBe(true)
  })
})

describe('refreshSpecEdits', () => {
  const WEAKER = "test('a', async () => {})\n"

  it('re-measures the pending edits when a live spec of THIS feature changes while Playwright is idle', () => {
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    const before = sink.patches.length
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)

    refreshSpecEdits(ctx, ctx.feature.name)

    const patch = sink.patches.at(-1) as { specEdits: RunManifest['specEdits'] }
    expect(sink.patches.length).toBe(before + 1)
    expect(patch.specEdits?.pending).toMatchObject([{ file: 'e2e/a.spec.ts', change: 'modified' }])
    // The boundary itself did not move: the copy still holds what ran.
    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e/a.spec.ts'), 'utf8')).toBe(SPEC_A)
  })

  it("stays quiet for another feature's change, and while Playwright is executing the copy", () => {
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)
    const before = sink.patches.length

    refreshSpecEdits(ctx, `${ctx.feature.name}-other`)
    ctx.playwrightPty = { pid: 1 } as unknown as RunContext['playwrightPty']
    refreshSpecEdits(ctx, ctx.feature.name)

    expect(sink.patches.length).toBe(before)
  })
})

describe('restoreSpecEdits', () => {
  const WEAKER = "test('a', async () => {})\n"

  it('refuses while Playwright is running the current copy', () => {
    const { ctx } = ctxFor({ playwrightPty: { pid: 1 } as unknown as RunContext['playwrightPty'] })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)

    expect(restoreSpecEdits(ctx)).toEqual({ ok: false, reason: 'tests-running' })
  })

  it('refuses when there is no copy, and when the live suite already matches it', () => {
    const { ctx: noCopy } = ctxFor()
    write(noCopy.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    expect(restoreSpecEdits(noCopy)).toEqual({ ok: false, reason: 'nothing-to-restore' })

    const { ctx } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    expect(restoreSpecEdits(ctx)).toEqual({ ok: false, reason: 'nothing-to-restore' })
  })

  it('rewrites a modified spec, recreates a deleted one, removes an added one, and clears the pending record', () => {
    const { ctx, sink } = ctxFor()
    const live = ctx.feature.featureDir
    write(live, 'e2e/a.spec.ts', SPEC_A)
    write(live, 'e2e/gone.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(live, 'e2e/a.spec.ts', WEAKER)
    fs.rmSync(path.join(live, 'e2e', 'gone.spec.ts'))
    write(live, 'e2e/new.spec.ts', SPEC_A)
    recordSpecEdits(ctx)
    expect((sink.patches.at(-1) as { specEdits: RunManifest['specEdits'] }).specEdits?.pending).toHaveLength(3)

    const result = restoreSpecEdits(ctx)

    expect(result).toEqual({ ok: true, restored: ['e2e/a.spec.ts', 'e2e/gone.spec.ts', 'e2e/new.spec.ts'] })
    expect(fs.readFileSync(path.join(live, 'e2e', 'a.spec.ts'), 'utf8')).toBe(SPEC_A)
    expect(fs.readFileSync(path.join(live, 'e2e', 'gone.spec.ts'), 'utf8')).toBe(SPEC_A)
    expect(fs.existsSync(path.join(live, 'e2e', 'new.spec.ts'))).toBe(false)
    // The boundary did not move: the copy is untouched and nothing was adopted.
    expect(ctx.suiteDir).toBe(ctx.paths.suiteSnapshotDir)
    const last = sink.patches.at(-1) as { specEdits: RunManifest['specEdits']; integrity: RunManifest['integrity'] }
    expect(last.specEdits).toMatchObject({ pending: [], adopted: [] })
    expect(last.integrity).toMatchObject({ hints: [] })
    // No rerun: the verdict already rests on the copy the live suite now matches.
    expect(ctx.signalGate.consume()).toBeNull()
  })

  it('fails closed, re-measures what did change, and warns when a file cannot be rewritten', () => {
    const runnerLog = fakeRunnerLog()
    const { ctx, sink } = ctxFor({ runnerLog })
    const live = ctx.feature.featureDir
    write(live, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(live, 'e2e/a.spec.ts', WEAKER)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('EACCES') })

    expect(restoreSpecEdits(ctx)).toEqual({ ok: false, reason: 'restore-failed' })
    expect(runnerLog.warnings.join('\n')).toMatch(/restoring spec edits stopped after 0\/1: EACCES/)
    // The live edit is still pending — the manifest says so rather than claiming a restore.
    const last = sink.patches.at(-1) as { specEdits: RunManifest['specEdits'] }
    expect(last.specEdits?.pending).toHaveLength(1)
  })

  it('names a non-Error throw in the warning instead of printing [object Object]', () => {
    const runnerLog = fakeRunnerLog()
    const { ctx } = ctxFor({ runnerLog })
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw 'disk full' })

    expect(restoreSpecEdits(ctx)).toEqual({ ok: false, reason: 'restore-failed' })
    expect(runnerLog.warnings.join('\n')).toMatch(/restoring spec edits stopped after 0\/1: disk full/)
  })
})

describe('digestOfSpecHashes', () => {
  it('is what suiteDigest records, and digests an empty map to a real sha256', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-digest-'))
    try {
      fs.mkdirSync(path.join(dir, 'e2e'))
      fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'test("a", () => {})\n')
      expect(digestOfSpecHashes(hashFeatureSpecs(dir))).toBe(suiteDigest(dir))
      expect(digestOfSpecHashes({})).toBe(createHash('sha256').digest('hex'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('suiteDigest', () => {
  it('changes when any spec changes and ignores file order', () => {
    const a = path.join(tmpDir, 'a')
    const b = path.join(tmpDir, 'b')
    write(a, 'e2e/x.spec.ts', SPEC_A)
    write(a, 'e2e/y.spec.ts', SPEC_A)
    write(b, 'e2e/y.spec.ts', SPEC_A)
    write(b, 'e2e/x.spec.ts', SPEC_A)
    expect(suiteDigest(a)).toBe(suiteDigest(b))

    write(b, 'e2e/x.spec.ts', "test('a', async () => {})\n")
    expect(suiteDigest(a)).not.toBe(suiteDigest(b))
  })
})

// Test-heal mode is the one sanctioned "edit the spec" path: the feature has
// zero editable repos, so the spec IS the fixable code and Canary itself told
// the agent to change it. Without this, the agent's fix lands in the live dir
// while every rerun executes the run-start copy — the repair can never pass.
// The adopt is keyed on the heal MODE (no app to fix), never on a verdict.
describe('adoptTestHealSpecEdits', () => {
  const WEAKER = "test('a', async () => {})\n"

  function manifestWithRepos(ctx: RunContext, repoPaths: string[]): void {
    writeManifest(ctx.paths.manifestPath, {
      runId: ctx.runId, feature: 'demo', startedAt: 't', status: 'healing', healCycles: 1, services: [], repoPaths,
    } as RunManifest)
  }

  it('adopts the live edits before a rerun when the run has no editable repos', async () => {
    const { ctx, sink } = ctxFor()
    manifestWithRepos(ctx, [])
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)

    expect(await adoptTestHealSpecEdits(ctx)).toEqual(['e2e/a.spec.ts'])

    expect(fs.readFileSync(path.join(ctx.paths.suiteSnapshotDir, 'e2e', 'a.spec.ts'), 'utf8')).toBe(WEAKER)
    const last = sink.patches.at(-1) as { specEdits: RunManifest['specEdits'] }
    // The record says who adopted, so the UI never shows a runner adopt as a human one.
    expect(last.specEdits?.adopted).toEqual([{ at: expect.any(String), by: 'test-heal', files: ['e2e/a.spec.ts'] }])
    // No rerun signal: the loop is already acting on the agent's own signal.
    expect(ctx.signalGate.consume()).toBeNull()
  })

  it('never adopts for a run that has app code to fix', async () => {
    const { ctx, sink } = ctxFor()
    manifestWithRepos(ctx, ['/repo/app'])
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)
    const before = sink.patches.length

    expect(await adoptTestHealSpecEdits(ctx)).toEqual([])
    expect(fs.readFileSync(path.join(ctx.paths.suiteSnapshotDir, 'e2e', 'a.spec.ts'), 'utf8')).toBe(SPEC_A)
    expect(sink.patches.length).toBe(before)
  })

  it('adopts nothing when the re-snapshot fails — the copy that ran stays the copy', async () => {
    const { ctx } = ctxFor()
    manifestWithRepos(ctx, [])
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', WEAKER)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('EACCES') })

    expect(await adoptTestHealSpecEdits(ctx)).toEqual([])
  })

  it('is a no-op when nothing is pending, and when the run has no copy to adopt into', async () => {
    const { ctx } = ctxFor()
    manifestWithRepos(ctx, [])
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    expect(await adoptTestHealSpecEdits(ctx)).toEqual([])

    snapshotSuite(ctx)
    expect(await adoptTestHealSpecEdits(ctx)).toEqual([])
  })
})
