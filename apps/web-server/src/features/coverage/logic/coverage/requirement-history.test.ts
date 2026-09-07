import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirtySpecStore } from '../../../runs/logic/dirty-specs/store'
import { historyForTests, readFeatureRunHistory } from './requirement-history'

// The time axis reads run EVIDENCE, never a stored opinion: which run last saw a
// set of tests all pass (provenAt), and which spec-edit classifications touched
// which tests (testsChangedAt), joined to requirements by the caller through the
// live @req tags. Real files in a tmp logs dir — the same records the run loop
// writes (runs/index.json, <run>/e2e-summary.json, <run>/manifest.json, the
// dirty-specs record).

let logsDir: string

beforeEach(() => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rh-')))
  fs.mkdirSync(path.join(logsDir, 'runs'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

function seedIndex(entries: Array<Record<string, unknown>>): void {
  fs.writeFileSync(path.join(logsDir, 'runs', 'index.json'), JSON.stringify(entries.map((e) => ({ status: 'passed', feature: 'checkout', ...e }))))
}

function seedRun(runId: string, files: { summary?: unknown; manifest?: unknown }): void {
  const dir = path.join(logsDir, 'runs', runId)
  fs.mkdirSync(dir, { recursive: true })
  if (files.summary !== undefined) fs.writeFileSync(path.join(dir, 'e2e-summary.json'), JSON.stringify(files.summary))
  if (files.manifest !== undefined) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(files.manifest))
}

const TESTS = [
  { name: 'totals add up', file: 'e2e/totals.spec.ts' },
  { name: 'tax shown', file: 'e2e/tax.spec.ts' },
]

describe('readFeatureRunHistory + historyForTests — provenAt', () => {
  it('names the NEWEST run in which every asked test passed, timed by the run end', () => {
    seedIndex([
      { runId: 'r1', startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T00:10:00Z' },
      { runId: 'r2', startedAt: '2026-09-02T00:00:00Z', endedAt: '2026-09-02T00:10:00Z' },
      { runId: 'r3', startedAt: '2026-09-03T00:00:00Z', endedAt: '2026-09-03T00:10:00Z' },
    ])
    seedRun('r1', { summary: { passedNames: ['test-case-totals-add-up', 'test-case-tax-shown'], failed: [] } })
    seedRun('r2', { summary: { passedNames: ['test-case-totals-add-up', 'test-case-tax-shown'], failed: [] } })
    seedRun('r3', { summary: { passedNames: ['test-case-tax-shown'], failed: [{ name: 'test-case-totals-add-up' }] } })
    const history = readFeatureRunHistory(logsDir, 'checkout')
    expect(historyForTests(history, TESTS, ['totals add up']).provenAt).toEqual({ runId: 'r2', at: '2026-09-02T00:10:00Z' })
    expect(historyForTests(history, TESTS, ['tax shown']).provenAt).toEqual({ runId: 'r3', at: '2026-09-03T00:10:00Z' })
    expect(historyForTests(history, TESTS, ['totals add up', 'tax shown']).provenAt).toEqual({ runId: 'r2', at: '2026-09-02T00:10:00Z' })
  })

  it('a test the run never reached is not a pass — no proof from that run', () => {
    seedIndex([{ runId: 'r1', startedAt: '2026-09-01T00:00:00Z' }])
    seedRun('r1', { summary: { passedNames: [], failed: [] } })
    const history = readFeatureRunHistory(logsDir, 'checkout')
    expect(historyForTests(history, TESTS, ['totals add up']).provenAt).toBeUndefined()
    expect(historyForTests(history, TESTS, []).provenAt).toBeUndefined()
  })

  it('skips boot sessions, benchmark arms, other features, and runs without a readable summary; a run without endedAt is timed by its start', () => {
    seedIndex([
      { runId: 'boot', startedAt: '2026-09-05T00:00:00Z', executionType: 'boot' },
      { runId: 'bench', startedAt: '2026-09-04T00:00:00Z', executionType: 'benchmark' },
      { runId: 'other', startedAt: '2026-09-03T00:00:00Z', feature: 'returns' },
      { runId: 'noread', startedAt: '2026-09-02T00:00:00Z' },
      { runId: 'r1', startedAt: '2026-09-01T00:00:00Z' },
    ])
    for (const id of ['boot', 'bench', 'other']) seedRun(id, { summary: { passedNames: ['test-case-totals-add-up'], failed: [] } })
    seedRun('r1', { summary: { passedNames: ['test-case-totals-add-up'], failed: [] } })
    const history = readFeatureRunHistory(logsDir, 'checkout')
    expect(historyForTests(history, TESTS, ['totals add up']).provenAt).toEqual({ runId: 'r1', at: '2026-09-01T00:00:00Z' })
  })

  it('reads at most `maxRuns` newest runs — the walk is bounded', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ runId: `r${i}`, startedAt: `2026-09-0${i + 1}T00:00:00Z` }))
    seedIndex(entries)
    for (const e of entries) seedRun(e.runId, { summary: { passedNames: e.runId === 'r0' ? ['test-case-totals-add-up'] : [], failed: [] } })
    expect(historyForTests(readFeatureRunHistory(logsDir, 'checkout', { maxRuns: 2 }), TESTS, ['totals add up']).provenAt).toBeUndefined()
    expect(historyForTests(readFeatureRunHistory(logsDir, 'checkout'), TESTS, ['totals add up']).provenAt?.runId).toBe('r0')
  })
})

describe('readFeatureRunHistory + historyForTests — test changes', () => {
  it('reads a run\'s pending spec edits per affected test, with the differential verdict attached', () => {
    seedIndex([{ runId: 'r1', startedAt: '2026-09-01T00:00:00Z' }])
    seedRun('r1', {
      summary: { passedNames: [], failed: [] },
      manifest: {
        runId: 'r1', feature: 'checkout', startedAt: '2026-09-01T00:00:00Z', status: 'passed', healCycles: 0, services: [],
        specEdits: {
          checkedAt: '2026-09-01T00:20:00Z',
          pending: [{
            file: 'e2e/totals.spec.ts',
            affectedTests: ['totals add up', 'tax shown'],
            change: 'modified',
            strength: {
              baseline: 'run-start',
              verdict: 'weaker',
              tests: [
                { kind: 'changed', name: 'totals add up', verdict: 'weaker', changes: [] },
                { kind: 'changed', name: 'tax shown', verdict: 'equivalent', changes: [] },
              ],
            },
          }],
          adopted: [],
        },
      },
    })
    const history = readFeatureRunHistory(logsDir, 'checkout')
    expect(historyForTests(history, TESTS, ['totals add up']).testChanges).toEqual([
      { at: '2026-09-01T00:20:00Z', tests: ['totals add up'], verdict: 'weaker', runId: 'r1' },
    ])
    expect(historyForTests(history, TESTS, ['tax shown']).testChanges).toEqual([
      { at: '2026-09-01T00:20:00Z', tests: ['tax shown'], verdict: 'changed', runId: 'r1' },
    ])
  })

  it('an unreadable side or an unclassifiable test reads as cannot-classify; a hash-only edit as changed', () => {
    seedIndex([{ runId: 'r1', startedAt: '2026-09-01T00:00:00Z' }])
    seedRun('r1', {
      summary: { passedNames: [], failed: [] },
      manifest: {
        runId: 'r1', feature: 'checkout', startedAt: '2026-09-01T00:00:00Z', status: 'passed', healCycles: 0, services: [],
        specEdits: {
          checkedAt: '2026-09-01T00:20:00Z',
          pending: [
            { file: 'e2e/totals.spec.ts', affectedTests: ['totals add up'], change: 'modified', strength: { baseline: 'head', verdict: 'unclassifiable', tests: [], reasons: ['the live side does not parse'] } },
            { file: 'e2e/tax.spec.ts', affectedTests: ['tax shown'], change: 'modified' },
            { file: 'e2e/misc.spec.ts', affectedTests: ['misc'], change: 'modified', strength: { baseline: 'head', verdict: 'unclassifiable', tests: [{ kind: 'changed', name: 'misc', verdict: 'unclassifiable', changes: [] }] } },
          ],
          adopted: [],
        },
      },
    })
    const tests = [...TESTS, { name: 'misc', file: 'e2e/misc.spec.ts' }]
    const history = readFeatureRunHistory(logsDir, 'checkout')
    expect(historyForTests(history, tests, ['totals add up']).testChanges[0].verdict).toBe('cannot-classify')
    expect(historyForTests(history, tests, ['tax shown']).testChanges[0].verdict).toBe('changed')
    expect(historyForTests(history, tests, ['misc']).testChanges[0].verdict).toBe('cannot-classify')
  })

  it('an adopted edit names files, so every test now in those files changed at the adoption time', () => {
    seedIndex([{ runId: 'r1', startedAt: '2026-09-01T00:00:00Z' }])
    seedRun('r1', {
      summary: { passedNames: [], failed: [] },
      manifest: {
        runId: 'r1', feature: 'checkout', startedAt: '2026-09-01T00:00:00Z', status: 'passed', healCycles: 0, services: [],
        specEdits: { checkedAt: '2026-09-01T00:30:00Z', pending: [], adopted: [{ at: '2026-09-01T00:25:00Z', by: 'human', files: ['e2e/tax.spec.ts'] }] },
      },
    })
    const history = readFeatureRunHistory(logsDir, 'checkout')
    expect(historyForTests(history, TESTS, ['tax shown']).testChanges).toEqual([
      { at: '2026-09-01T00:25:00Z', tests: ['tax shown'], verdict: 'changed', runId: 'r1' },
    ])
    expect(historyForTests(history, TESTS, ['totals add up']).testChanges).toEqual([])
  })

  it('a dirty-specs record (an edit between runs) counts from when the feature went dirty', async () => {
    seedIndex([])
    const store = new DirtySpecStore(logsDir, () => '2026-09-06T12:00:00Z')
    const featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rh-feat-'))
    fs.mkdirSync(path.join(featureDir, 'e2e'))
    fs.writeFileSync(path.join(featureDir, 'e2e', 'totals.spec.ts'), 'test("totals add up", async () => {})\n')
    // Baseline the clean suite, then edit the spec and recompute → dirty.
    await store.captureRunStart('checkout', featureDir)
    fs.writeFileSync(path.join(featureDir, 'e2e', 'totals.spec.ts'), 'test("totals add up", async () => { await expect(1).toBe(1) })\n')
    const rec = await store.recompute('checkout', featureDir)
    expect(rec.status).toBe('dirty')
    const history = readFeatureRunHistory(logsDir, 'checkout')
    const changes = historyForTests(history, TESTS, ['totals add up']).testChanges
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ at: '2026-09-06T12:00:00Z', tests: ['totals add up'] })
    expect(changes[0].runId).toBeUndefined()
    fs.rmSync(featureDir, { recursive: true, force: true })
  })

  it('a clean feature with no manifests yields an empty history', () => {
    seedIndex([{ runId: 'r1', startedAt: '2026-09-01T00:00:00Z' }])
    seedRun('r1', { summary: { passedNames: [], failed: [] } })
    const history = readFeatureRunHistory(logsDir, 'checkout')
    expect(historyForTests(history, TESTS, ['totals add up']).testChanges).toEqual([])
  })
})
