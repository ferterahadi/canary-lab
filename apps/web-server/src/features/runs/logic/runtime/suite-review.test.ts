import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSuiteReview, suiteReviewRevision } from './suite-review'
import { adoptSpecEdits, snapshotSuite } from './run-suite-snapshot'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-suite-review-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
function write(dir: string, file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), content)
}
function fixture(opts: Parameters<typeof makeHealLoopContext>[0]['opts'] = {}) {
  const { ctx, sink } = makeHealLoopContext({ root, opts })
  write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', () => expect(true).toBe(true))\n")
  write(ctx.feature.featureDir, 'helper.ts', 'export const value = 1\n')
  snapshotSuite(ctx)
  write(ctx.feature.featureDir, 'e2e/a.spec.ts', "test('a', () => expect(1).toBe(1))\n")
  ctx.signalGate.beginWaiting()
  return { ctx, sink, before: ctx.suiteDir, live: ctx.feature.featureDir }
}

describe('exact suite review', () => {
  it('compares the snapshot, includes helpers/additions/deletions, and preserves EOF changes', async () => {
    const { before, live } = fixture()
    write(before, 'deleted.txt', 'old\n')
    write(live, 'added.txt', '')
    write(live, 'helper.ts', 'export const value = 1')
    const review = await buildSuiteReview(before, live)
    expect(review.files).toEqual([
      { file: 'added.txt', change: 'added' }, { file: 'deleted.txt', change: 'deleted' },
      { file: 'e2e/a.spec.ts', change: 'modified' }, { file: 'helper.ts', change: 'modified' },
    ])
    expect(review.patch).toContain('No newline at end of file')
    expect(review.patch).toContain('-old')
    expect(review.patch).toContain('--- /dev/null')
    expect(review.revision).toBe(suiteReviewRevision(before, live))
    expect(review.patch).not.toContain('cl-text-diff-')
  })

  it('omits secrets, runtime metadata and symlinks exactly like the suite copier', async () => {
    const { before, live } = fixture()
    const revision = suiteReviewRevision(before, live)
    for (const file of ['envsets/local/app.env', '.env', '.env.bak.1789653324105', 'node_modules/a.js', '.git/HEAD', 'docs/_coverage-state.json']) write(live, file, 'SECRET')
    fs.symlinkSync(path.join(live, 'envsets/local/app.env'), path.join(live, 'secret-link'))
    expect(suiteReviewRevision(before, live)).toBe(revision)
    expect((await buildSuiteReview(before, live)).patch).not.toContain('SECRET')
  })

  it.each([Buffer.from([0, 1]), Buffer.from([255])])('refuses changed binary content without pretending a text diff is sufficient', async (content) => {
    const { before, live } = fixture()
    write(live, 'fixture.bin', content)
    await expect(buildSuiteReview(before, live)).rejects.toThrow(/binary/)
  })

  it('includes empty deletions and returns no changed files for identical trees', async () => {
    const { before, live } = fixture()
    expect((await buildSuiteReview(live, live)).files).toEqual([])
    write(before, 'empty.txt', '')
    expect((await buildSuiteReview(before, live)).files).toContainEqual({ file: 'empty.txt', change: 'deleted' })
  })
})

describe('adoption bound to reviewed bytes', () => {
  it('adopts the reviewed files, records human authorship, and signals once', async () => {
    const { ctx, sink, before, live } = fixture()
    write(live, 'helper.ts', 'export const value = 2\n')
    const revision = suiteReviewRevision(before, live)
    expect(await adoptSpecEdits(ctx, revision)).toMatchObject({ ok: true, rerun: 'signalled' })
    expect(fs.readFileSync(path.join(before, 'helper.ts'), 'utf8')).toContain('= 2')
    expect(sink.patches.at(-1)).toMatchObject({ specEdits: { adopted: [{ by: 'human' }] } })
    expect(ctx.signalGate.consume()?.kind).toBe('rerun')
    expect(await adoptSpecEdits(ctx, revision)).toMatchObject({ ok: false })
    expect(ctx.signalGate.consume()).toBeNull()
  })

  it.each(['e2e/a.spec.ts', 'helper.ts', 'new-support.ts'])('rejects a late edit to %s and keeps old evidence', async (file) => {
    const { ctx, before, live } = fixture()
    const revision = suiteReviewRevision(before, live)
    const original = fs.readFileSync(path.join(before, 'e2e/a.spec.ts'), 'utf8')
    write(live, file, 'late edit\n')
    expect(await adoptSpecEdits(ctx, revision)).toEqual({ ok: false, reason: 'review-changed' })
    expect(fs.readFileSync(path.join(before, 'e2e/a.spec.ts'), 'utf8')).toBe(original)
    expect(ctx.signalGate.consume()).toBeNull()
  })

  it('rejects a baseline change and an unavailable baseline', async () => {
    const { ctx, before, live } = fixture()
    const revision = suiteReviewRevision(before, live)
    write(before, 'helper.ts', 'changed baseline')
    expect(await adoptSpecEdits(ctx, revision)).toMatchObject({ reason: 'review-changed' })
    ctx.suiteDir = live
    expect(await adoptSpecEdits(ctx, revision)).toMatchObject({ reason: 'review-changed' })
  })

  it('detects edits during copying before replacing the original snapshot', async () => {
    const { ctx, before, live } = fixture()
    const revision = suiteReviewRevision(before, live)
    const copy = fs.copyFileSync
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, target, mode) => {
      if (String(source).endsWith('a.spec.ts')) fs.writeFileSync(String(source), 'changed during copy')
      copy(source, target, mode)
    })
    expect(await adoptSpecEdits(ctx, revision)).toMatchObject({ reason: 'review-changed' })
    expect(fs.readFileSync(path.join(before, 'e2e/a.spec.ts'), 'utf8')).toContain('expect(true)')
    expect(ctx.signalGate.consume()).toBeNull()
  })

  it('preserves the snapshot when copying fails', async () => {
    const { ctx, before, live } = fixture()
    const revision = suiteReviewRevision(before, live)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('disk full') })
    expect(await adoptSpecEdits(ctx, revision)).toMatchObject({ reason: 'snapshot-failed' })
    expect(fs.readFileSync(path.join(before, 'e2e/a.spec.ts'), 'utf8')).toContain('expect(true)')
    expect(ctx.signalGate.consume()).toBeNull()
  })

  it('keeps edits made during re-baselining pending instead of calling them adopted', async () => {
    const captureRunStart = vi.fn(async () => ({}))
    const { ctx, sink, before, live } = fixture({ dirtySpecHooks: { captureRunStart, finalizeRun: vi.fn() } })
    const revision = suiteReviewRevision(before, live)
    captureRunStart.mockImplementation(async () => {
      write(live, 'e2e/a.spec.ts', "test('late edit', () => {})\n")
      return {}
    })
    expect(await adoptSpecEdits(ctx, revision)).toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(before, 'e2e/a.spec.ts'), 'utf8')).not.toContain('late edit')
    expect(sink.patches.at(-1)).toMatchObject({ specEdits: { pending: [{ file: 'e2e/a.spec.ts' }] } })
  })

  it('restores the original directory if staging cannot be promoted', async () => {
    const { ctx, before, live } = fixture()
    const revision = suiteReviewRevision(before, live)
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (String(source).endsWith('/candidate')) throw new Error('rename failed')
      rename(source, target)
    })
    expect(await adoptSpecEdits(ctx, revision)).toMatchObject({ reason: 'snapshot-failed' })
    expect(fs.readFileSync(path.join(before, 'e2e/a.spec.ts'), 'utf8')).toContain('expect(true)')
  })
})
