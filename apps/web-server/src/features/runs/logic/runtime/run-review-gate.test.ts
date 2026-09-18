import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNoPendingRunReview } from './run-review-gate'
import { suiteReviewRevision } from './suite-review'
import type { RunDetail, RunStore } from '../run-store'
import type { RunManifest } from './manifest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function setup(status: RunManifest['status'] = 'aborted') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-review-gate-'))
  roots.push(root)
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
