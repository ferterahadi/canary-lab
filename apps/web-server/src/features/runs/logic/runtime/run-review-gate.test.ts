import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertNoPendingRunReview, pendingRunReview } from './run-review-gate'
import { suiteReviewRevision } from './suite-review'
import type { RunStore } from '../run-store'
import type { RunDetail } from '../../../../../../../shared/run-detail'
import type { RunManifest } from '../../../../../../../shared/run-manifest'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('canary-review-gate-')
afterEach(() => { vi.restoreAllMocks() })

function setup(status: RunManifest['status'] = 'aborted') {
  const root = tempDir()
  const live = path.join(root, 'feature')
  const snapshot = path.join(root, 'run', 'suite')
  for (const dir of [live, snapshot]) {
    fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'e2e', 'contract.spec.ts'), "test('contract', () => expect(1).toBe(1))")
  }
  const manifest = { runId: 'original', feature: 'example', status, suiteSnapshot: { kind: 'taken', dir: snapshot } } as RunManifest
  const store = {
    list: () => [{ runId: 'original', feature: 'example', startedAt: '2026-01-01', status, executionType: 'run' }],
    get: () => ({ runId: 'original', manifest }),
  } as Pick<RunStore, 'list' | 'get'>
  return { live, snapshot, manifest, store }
}

describe('fresh-run review boundary', () => {
  it.each(['clean', 'pending', 'approved'] as const)('reads each suite file once when the gate is %s and observes later changes', (state) => {
    const { store, live, snapshot, manifest } = setup()
    const liveFile = path.join(live, 'e2e/contract.spec.ts')
    const snapshotFile = path.join(snapshot, 'e2e/contract.spec.ts')
    if (state !== 'clean') fs.writeFileSync(liveFile, 'review candidate')
    const revision = suiteReviewRevision(snapshot, live)
    if (state === 'approved') manifest.specEdits = {
      checkedAt: 'now', pending: [], adopted: [],
      reviewDecisions: [{ at: 'approved-at', revision, decision: 'approved-for-new-run' }],
    }
    const read = vi.spyOn(fs, 'readFileSync')
    const review = pendingRunReview(store, 'example', live)
    if (state === 'pending') expect(review).toMatchObject({ review_revision: revision, changedFileCount: 1, runId: 'original' })
    else expect(review).toBeUndefined()
    expect(read.mock.calls.filter(([file]) => file === snapshotFile)).toHaveLength(1)
    expect(read.mock.calls.filter(([file]) => file === liveFile)).toHaveLength(1)
    read.mockClear()
    fs.writeFileSync(liveFile, 'a later edit')
    const later = pendingRunReview(store, 'example', live)
    expect(later).toMatchObject({ changedFileCount: 1, runId: 'original' })
    expect(later?.review_revision).not.toBe(revision)
    expect(read.mock.calls.filter(([file]) => file === snapshotFile)).toHaveLength(1)
    expect(read.mock.calls.filter(([file]) => file === liveFile)).toHaveLength(1)
  })

  it('keeps legacy runs eligible and skips auxiliary executions and non-approval decisions', () => {
    const { store, live, snapshot, manifest } = setup()
    fs.writeFileSync(path.join(live, 'e2e/contract.spec.ts'), 'changed')
    const original = store.list({ feature: 'example' })[0]
    store.list = () => [{ ...original, runId: 'boot', executionType: 'boot' }, { ...original, executionType: undefined }]
    manifest.specEdits = {
      checkedAt: 'now', pending: [], adopted: [], reviewDecisions: [
        { at: 'old', revision: 'old-revision', decision: 'approved-for-new-run' },
        { at: 'now', revision: suiteReviewRevision(snapshot, live), decision: 'restored' },
      ],
    }
    expect(pendingRunReview(store, 'example', live)).toMatchObject({ runId: 'original', changedFileCount: 1 })
  })

  it.each(['aborted', 'failed', 'healing'] as const)('blocks edited specs after %s even when the watcher has not recorded them', (status) => {
    const { store, live } = setup(status)
    fs.writeFileSync(path.join(live, 'e2e', 'contract.spec.ts'), "test.skip('contract', () => {})")
    expect(() => assertNoPendingRunReview(store, 'example', live)).toThrow(/test_review_required.*original/)
  })
  it('also protects helpers and test selection, and permits the reviewed snapshot', () => {
    const { store, live, snapshot } = setup()
    fs.writeFileSync(path.join(live, 'playwright.config.ts'), 'export default { testIgnore: "broken.spec.ts" }')
    expect(() => assertNoPendingRunReview(store, 'example', live)).toThrow(/review_test_changes/)
    fs.cpSync(live, snapshot, { recursive: true })
    expect(() => assertNoPendingRunReview(store, 'example', live)).not.toThrow()
    fs.writeFileSync(path.join(live, 'e2e', 'fixture.ts'), 'export const assert = () => {}')
    expect(() => assertNoPendingRunReview(store, 'example', live)).toThrow()
  })
  it('ignores runtime env changes, documentation, and repo branch selection', () => {
    const { store, live } = setup()
    fs.mkdirSync(path.join(live, 'docs'))
    fs.writeFileSync(path.join(live, 'docs', 'coverage.json'), '{}')
    fs.writeFileSync(path.join(live, '.env'), 'PORT=1234')
    fs.writeFileSync(path.join(live, 'feature.config.cjs'), 'module.exports = {}')
    expect(() => assertNoPendingRunReview(store, 'example', live)).not.toThrow()
  })
  it('allows ordinary authoring after a clean completed run, but retains recorded pending edits', () => {
    const { store, live, manifest } = setup('passed')
    fs.writeFileSync(path.join(live, 'e2e', 'contract.spec.ts'), 'new test')
    expect(() => assertNoPendingRunReview(store, 'example', live)).not.toThrow()
    manifest.specEdits = { checkedAt: 'now', pending: [{ file: 'e2e/contract.spec.ts', change: 'modified', affectedTests: [] }], adopted: [] }
    expect(() => assertNoPendingRunReview(store, 'example', live)).toThrow()
  })
  it('allows first runs and legacy runs that have no snapshot', () => {
    const { store, live, manifest } = setup()
    delete manifest.suiteSnapshot
    expect(() => assertNoPendingRunReview(store, 'example', live)).not.toThrow()
    const empty = { list: () => [], get: () => null } as Pick<RunStore, 'list' | 'get'>
    expect(() => assertNoPendingRunReview(empty, 'example', live)).not.toThrow()
    expect(() => assertNoPendingRunReview({ ...store, get: () => null }, 'example', live)).not.toThrow()
  })
  it('rechecks the original boundary when queued runs launch', () => {
    const { store, live } = setup()
    const original = store.list({ feature: 'example' })
    store.list = () => [
      { ...original[0], runId: 'new-run', status: 'running' },
      { ...original[0], runId: 'queued-sibling', status: 'queued' },
      ...original,
    ]
    fs.writeFileSync(path.join(live, 'e2e', 'contract.spec.ts'), 'weakened test')
    expect(() => assertNoPendingRunReview(store, 'example', live, 'new-run')).toThrow(/original/)
  })

  it.each(['passed', 'failed', 'aborted'] as const)('carries exact terminal approval into a new run after %s', (status) => {
    const { store, live, snapshot, manifest } = setup(status)
    fs.writeFileSync(path.join(live, 'e2e', 'contract.spec.ts'), 'approved candidate')
    const revision = suiteReviewRevision(snapshot, live)
    manifest.specEdits = {
      checkedAt: 'now',
      pending: [{ file: 'e2e/contract.spec.ts', change: 'modified', affectedTests: [] }],
      adopted: [],
      reviewDecisions: [{ at: 'approved-at', revision, decision: 'approved-for-new-run' }],
    }

    expect(assertNoPendingRunReview(store, 'example', live)).toEqual({
      sourceRunId: 'original', revision, approvedAt: 'approved-at',
    })
    fs.appendFileSync(path.join(live, 'e2e', 'contract.spec.ts'), '\nnewer')
    expect(() => assertNoPendingRunReview(store, 'example', live)).toThrow(/test_review_required/)
  })
})
