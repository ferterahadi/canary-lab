// The run-start suite snapshot (D9): the run executes a copy of
// features/<suite>/ taken before any service or agent starts, so a spec edited
// mid-run cannot reach the process that produces the verdict.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { adoptSpecEdits, recordSpecEdits, snapshotSuite, suiteDigest } from './run-suite-snapshot'
import { writeManifest, type RunManifest } from './manifest'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import type { RunContext } from './run-context'
import type { RunnerLog } from './runner-log'

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

const SPEC_A = "test('a', async () => { expect(1).toBe(1) })\n"

describe('snapshotSuite', () => {
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

  it('leaves envsets, node_modules and .git out of the copy', () => {
    // Envsets carry secrets and are read from the live dir by the env switcher;
    // node_modules resolves by walking up from the copy exactly as it does from
    // features/<suite>/; .git is never suite content.
    const { ctx } = ctxFor()
    const live = ctx.feature.featureDir
    write(live, 'e2e/a.spec.ts', SPEC_A)
    write(live, 'envsets/local/api.env', 'SECRET=1\n')
    write(live, 'node_modules/pkg/index.js', '')
    write(live, '.git/HEAD', 'ref: refs/heads/main\n')

    snapshotSuite(ctx)

    expect(fs.readdirSync(ctx.suiteDir).sort()).toEqual(['e2e'])
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

  it('writes the integrity hints and their disclosure beside the pending edits', () => {
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', { tag: ['@req-cart-1'] }, async () => { expect(1).toBe(1); expect(2).toBe(2) })\n")
    snapshotSuite(ctx)
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', { tag: ['@req-cart-1'] }, async () => { expect(1).toBe(1) })\n")

    recordSpecEdits(ctx)

    const patch = sink.patches.at(-1) as { integrity: RunManifest['integrity'] }
    expect(patch.integrity).toEqual({
      hints: [{ kind: 'weaker', file: 'e2e/a.spec.ts', test: 'a', requirements: ['cart-1'], was: ['expect(2).toBe(2)'], now: [] }],
      disclosure: expect.stringContaining('no human'),
    })
  })

  it('keeps the adopted history already on the manifest', () => {
    // Adoption is appended by the adopt route; a routine re-check after a
    // Playwright exit must not wipe that record.
    const { ctx, sink } = ctxFor()
    write(ctx.feature.featureDir, 'e2e/a.spec.ts', SPEC_A)
    snapshotSuite(ctx)
    const adopted = [{ at: '2026-09-06T00:00:00.000Z', files: ['e2e/a.spec.ts'] }]
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
    expect(last.specEdits).toMatchObject({ pending: [], adopted: [{ at: expect.any(String), files: ['e2e/a.spec.ts'] }] })
    // Adopted means accepted: the hints that described the pending edit are gone.
    expect(last.integrity).toMatchObject({ hints: [] })
    // The rerun signal carries the human's authorship so the journal reads right.
    expect(ctx.signalGate.consume()).toMatchObject({ kind: 'rerun', body: { adoptedSpecEdits: ['e2e/a.spec.ts'] } })
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
