import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSuiteReview, suiteExecutionRevision, suiteReviewAssessment, suiteReviewRevision } from './suite-review'
import { adoptSpecEdits, restoreReviewedSuiteFiles, snapshotSuite } from './run-suite-snapshot'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-suite-review-')
let root: string
beforeEach(() => { root = tempDir() })
afterEach(() => { vi.restoreAllMocks() })
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
  it('adopts an output declaration from a pre-existing run and keeps later rotations out of review and restore', async () => {
    const { ctx, before, live } = fixture()
    const config = 'feature.config.cjs'
    const state = 'logs/receiver/current.json'
    const rotated = 'logs/receiver/receiver-today.jsonl'
    const authored = 'logs/receiver/example.json'
    write(live, 'e2e/a.spec.ts', fs.readFileSync(path.join(before, 'e2e/a.spec.ts')))
    write(before, state, 'previous run')
    write(live, state, 'current run')
    write(live, rotated, 'event')
    write(live, config, "module.exports.config = { generatedFiles: ['logs/receiver/current.json', 'logs/receiver/receiver-*.jsonl'] }")
    const proposal = suiteReviewAssessment(before, live)
    expect(proposal).toMatchObject({ executionChanged: true, files: [{ file: config }] })
    write(live, rotated, 'another event')
    expect(suiteReviewRevision(before, live)).toBe(proposal.revision)
    expect(await adoptSpecEdits(ctx, proposal.revision)).toMatchObject({ ok: true, adopted: [config] })
    expect(fs.existsSync(path.join(before, state))).toBe(false)
    expect(fs.existsSync(path.join(before, rotated))).toBe(false)
    const settled = suiteReviewAssessment(before, live)
    fs.unlinkSync(path.join(live, rotated))
    write(live, 'logs/receiver/receiver-tomorrow.jsonl', 'new log')
    write(live, state, 'next run')
    expect(suiteReviewAssessment(before, live)).toEqual(settled)
    expect(settled).toMatchObject({ executionChanged: false, files: [] })
    write(live, authored, 'expected response')
    write(live, 'helper.ts', 'modified assertion')
    const review = suiteReviewAssessment(before, live)
    expect(review.files.map((f) => f.file)).toEqual(['helper.ts', authored])
    expect(restoreReviewedSuiteFiles(before, live, review.revision)).toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(live, state), 'utf8')).toBe('next run')
    write(live, config, 'module.exports.config = {}')
    const removal = suiteReviewAssessment(before, live)
    expect(removal.executionChanged).toBe(true)
    expect(removal.files.map((f) => f.file)).toContain(state)
    expect(restoreReviewedSuiteFiles(before, live, removal.revision)).toMatchObject({ ok: true, restored: [config] })
    expect(fs.readFileSync(path.join(live, state), 'utf8')).toBe('next run')
    expect(suiteReviewAssessment(before, live)).toEqual(settled)
  })

  it('uses the declared file policy on a first snapshot, never on directories with matching names', () => {
    const { ctx } = makeHealLoopContext({ root })
    const live = ctx.feature.featureDir
    write(live, 'feature.config.cjs', "module.exports.config = { generatedFiles: ['logs/out-*.json'] }")
    write(live, 'logs/out-state.json', 'output')
    write(live, 'logs/out-dir.json/helper.ts', 'authored')
    snapshotSuite(ctx)
    expect(ctx.suiteDir).not.toBe(live)
    expect(fs.existsSync(path.join(ctx.suiteDir, 'logs/out-state.json'))).toBe(false)
    expect(fs.existsSync(path.join(ctx.suiteDir, 'logs/out-dir.json/helper.ts'))).toBe(true)
    expect(suiteReviewAssessment(ctx.suiteDir, live).files).toEqual([])
  })

  it('derives full review and execution changes from the same inventories with runtime exclusions', () => {
    const { before, live } = fixture()
    write(live, 'e2e/a.spec.ts', fs.readFileSync(path.join(before, 'e2e/a.spec.ts')))
    const excluded = ['runtime/settings.json']
    const original = suiteReviewAssessment(before, live, excluded)
    expect(original).toMatchObject({ executionChanged: false, files: [] })
    for (const file of ['docs/summary.ts', 'feature.config.cjs', 'notes.txt']) write(live, file, 'reviewable, not executable')
    write(live, excluded[0], 'SECRET')
    const documentation = suiteReviewAssessment(before, live, excluded)
    expect(documentation.executionChanged).toBe(false)
    expect(documentation.files.map(({ file }) => file)).toEqual(['docs/summary.ts', 'feature.config.cjs', 'notes.txt'])
    expect(documentation.revision).not.toBe(original.revision)
    expect(documentation.revision).toBe(suiteReviewRevision(before, live, excluded))
    expect(suiteExecutionRevision(before, live, excluded)).toBe(suiteExecutionRevision(before, before, excluded))
    write(live, 'helper.ts', 'new executable input')
    const changed = suiteReviewAssessment(before, live, excluded)
    expect(changed.executionChanged).toBe(true)
    expect(changed.files).toContainEqual({ file: 'helper.ts', change: 'modified' })
    expect(suiteExecutionRevision(before, live, excluded)).not.toBe(suiteExecutionRevision(before, before, excluded))
    expect(suiteReviewAssessment(before, live).files).toContainEqual({ file: excluded[0], change: 'added' })
  })

  it.each(['e2e/fixture.txt', 'helper.mjs', 'helper.cts', 'view.jsx', 'data.json', 'feature.config.js', 'feature.config.ts'])(
    'retains %s as an execution input', (file) => {
      const { before, live } = fixture()
      write(live, 'e2e/a.spec.ts', fs.readFileSync(path.join(before, 'e2e/a.spec.ts')))
      write(live, file, 'new input')
      expect(suiteReviewAssessment(before, live)).toMatchObject({ executionChanged: true, files: [{ file, change: 'added' }] })
    },
  )

  it('propagates missing-tree and content-read failures without an empty successful assessment', () => {
    const { before, live } = fixture()
    expect(() => suiteReviewAssessment(path.join(root, 'missing'), live)).toThrow(/ENOENT/)
    const read = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (String(file) === path.join(live, 'helper.ts')) throw new Error('read refused')
      return read(file, ...args)
    })
    expect(() => suiteReviewAssessment(before, live)).toThrow('read refused')
  })

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

  it('hides envset backups of excluded runtime inputs but still reviews unrelated backup-named files', () => {
    const { before, live } = fixture()
    const inputs = ['.canary-inputs/evidence.json']
    const revision = suiteReviewRevision(before, live, inputs)
    write(live, '.canary-inputs/evidence.json.bak.1794472206971', 'SECRET')
    expect(suiteReviewRevision(before, live, inputs)).toBe(revision)
    write(live, 'notes.txt.bak.1794472206971', 'authored')
    expect(suiteReviewRevision(before, live, inputs)).not.toBe(revision)
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
  it('persists snapshot metadata and the complete receipt together before asynchronous baseline work', async () => {
    const captureRunStart = vi.fn(async () => ({}))
    const { ctx, sink, before, live } = fixture({ dirtySpecHooks: { captureRunStart, finalizeRun: vi.fn() } })
    const revision = suiteReviewRevision(before, live)
    captureRunStart.mockImplementation(async () => {
      expect(sink.patches.at(-1)).toMatchObject({
        suiteSnapshot: { kind: 'taken' },
        specEdits: { reviewDecisions: [{ revision, receipt: { decision: 'accepted', review_revision: revision, git: { status: 'committed', commit: 'review-commit' } } }] },
      })
      return {}
    })
    expect(await adoptSpecEdits(ctx, revision, { status: 'committed', commit: 'review-commit' })).toMatchObject({ ok: true })
    expect(captureRunStart).toHaveBeenCalledOnce()
  })
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
