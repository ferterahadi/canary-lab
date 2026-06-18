import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CoverageJobRunStore } from './store'
import { startCoverageJob, CoverageJobConflictError } from './runner'
import type { CoverageJobStore } from './store'

let tmpDir: string
let store: CoverageJobRunStore
let n: number

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cov-jobs-')))
  store = new CoverageJobRunStore(tmpDir)
  n = 0
})
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

const ids = () => `job-${++n}`
const now = () => '2026-01-01T00:00:00Z'

describe('startCoverageJob', () => {
  it('runs a summary job to done, then auto-chains a coverage job (R14)', async () => {
    let engineRuns = 0
    const { manifest, completion } = startCoverageJob(
      { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'summary' },
      {
        store,
        now,
        newJobId: ids,
        regenerate: async ({ onOutput }) => {
          onOutput?.('summarizing\n')
          return { feature: 'checkout', summary: { requirements: [{ id: 'R1', title: 't', text: 'x', pathTypes: ['happy'] }], docsHash: 'h', sourceDocs: [], generatedAt: now() }, written: [] }
        },
        runEngine: async () => { engineRuns += 1; return { feature: 'checkout', applied: [], orphanTestsBefore: [], ledger: {} as never } },
      },
    )
    expect(manifest.status).toBe('running')
    await completion
    const done = store.get(manifest.jobId)!
    expect(done.status).toBe('done')
    expect(done.result?.requirementCount).toBe(1)
    expect(done.log).toContain('summarizing')
    // Summary + Coverage are one exercise: the summary job spawned a coverage job.
    expect(done.chainedJobId).toBeTruthy()
    const chained = store.get(done.chainedJobId!)!
    expect(chained.kind).toBe('coverage')
    expect(chained.chainedFromJobId).toBe(manifest.jobId)
    expect(engineRuns).toBe(1)
  })

  it('runs a coverage job and records the applied tag-write count (no review gate)', async () => {
    const { manifest, completion } = startCoverageJob(
      { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'coverage' },
      {
        store,
        now,
        newJobId: ids,
        regenerate: async () => { throw new Error('nope') },
        runEngine: async () => ({ feature: 'checkout', applied: [{ testName: 't', requirements: ['R1'], source: 'deterministic' }], orphanTestsBefore: ['t'], ledger: {} as never }),
      },
    )
    await completion
    const done = store.get(manifest.jobId)!
    expect(done.status).toBe('done')
    expect(done.result).toMatchObject({ applied: 1 })
    // A standalone coverage job does not chain anything.
    expect(done.chainedJobId).toBeUndefined()
  })

  it('marks the job failed when the work throws', async () => {
    const { manifest, completion } = startCoverageJob(
      { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'summary' },
      { store, now, newJobId: ids, regenerate: async () => { throw new Error('boom') } },
    )
    await completion
    const failed = store.get(manifest.jobId)!
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('boom')
  })

  it('enforces single-flight per feature+kind', async () => {
    // First job stays running (never resolves until we let it).
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const first = startCoverageJob(
      { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'summary' },
      {
        store, now, newJobId: ids,
        regenerate: async () => { await gate; return { feature: 'checkout', summary: { requirements: [], docsHash: 'h', sourceDocs: [], generatedAt: now() }, written: [] } },
        // The summary auto-chains coverage on success — stub the engine so the
        // chain doesn't reach the real one against the fake featuresDir.
        runEngine: async () => ({ feature: 'checkout', applied: [], orphanTestsBefore: [], ledger: {} as never }),
      },
    )

    // A second summary job for the same feature is rejected.
    expect(() =>
      startCoverageJob(
        { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'summary' },
        { store, now, newJobId: ids, regenerate: async () => ({ feature: 'checkout', summary: { requirements: [], docsHash: 'h', sourceDocs: [], generatedAt: now() }, written: [] }) },
      ),
    ).toThrow(CoverageJobConflictError)

    // A DIFFERENT kind for the same feature is allowed (independent axes).
    expect(() =>
      startCoverageJob(
        { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'coverage' },
        { store, now, newJobId: ids, runEngine: async () => ({ feature: 'checkout', applied: [], orphanTestsBefore: [], ledger: {} as never }) },
      ),
    ).not.toThrow()

    release()
    await first.completion
    // Once finished, a new summary job is allowed again.
    expect(() =>
      startCoverageJob(
        { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'summary' },
        { store, now, newJobId: ids, regenerate: async () => ({ feature: 'checkout', summary: { requirements: [], docsHash: 'h', sourceDocs: [], generatedAt: now() }, written: [] }) },
      ),
    ).not.toThrow()
  })
})

describe('CoverageJobRunStore.reconcileInterrupted', () => {
  it('flips a running job left by a dead process to aborted', () => {
    store.save({ jobId: 'j1', feature: 'f', kind: 'summary', status: 'running', startedAt: now(), log: '' })
    store.reconcileInterrupted(now)
    expect(store.get('j1')?.status).toBe('aborted')
    expect(store.activeFor('f', 'summary')).toBeNull() // lock freed
  })
})

describe('startCoverageJob — non-Error throw paths', () => {
  it('records String(err) as error message when a non-Error is thrown from runEngine', async () => {
    const { manifest, completion } = startCoverageJob(
      { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'coverage' },
      {
        store,
        now,
        newJobId: ids,
        runEngine: async () => { throw 'string-error-value' as unknown as Error },
      },
    )
    await completion
    const failed = store.get(manifest.jobId)!
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('string-error-value')
  })

  it('records String(chainErr) in the log when the chain throws a non-Error', async () => {
    // Wrap the real store so that activeFor throws a non-Error on the second call
    // (the first call is the single-flight guard for the summary job; the second
    // is made inside startCoverageJob for the chained coverage job).
    let activeForCalls = 0
    const wrappedStore: CoverageJobStore = {
      list: () => store.list(),
      get: (id) => store.get(id),
      save: (m) => store.save(m),
      remove: (id) => store.remove(id),
      reconcileInterrupted: (fn) => store.reconcileInterrupted(fn),
      onEvent: (fn) => store.onEvent(fn),
      offEvent: (fn) => store.offEvent(fn),
      activeFor: (feature, kind) => {
        activeForCalls += 1
        // Second call is from the chained startCoverageJob — throw a non-Error.
        if (activeForCalls >= 2) throw 'non-error-chain-value'
        return store.activeFor(feature, kind)
      },
    }

    const { manifest, completion } = startCoverageJob(
      { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'summary' },
      {
        store: wrappedStore,
        now,
        newJobId: ids,
        regenerate: async ({ onOutput }) => {
          onOutput?.('done\n')
          return {
            feature: 'checkout',
            summary: { requirements: [], docsHash: 'h', sourceDocs: [], generatedAt: now() },
            written: [],
          }
        },
        runEngine: async () => ({ feature: 'checkout', applied: [], orphanTestsBefore: [], ledger: {} as never }),
      },
    )
    await completion
    const summary = store.get(manifest.jobId)!
    expect(summary.status).toBe('done')
    expect(summary.log).toContain('coverage not started')
    expect(summary.log).toContain('non-error-chain-value')
  })
})

describe('startCoverageJob — onAgentSession + chain-conflict path', () => {
  it('records sessionRef when onAgentSession fires (R17)', async () => {
    const { manifest, completion } = startCoverageJob(
      { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'coverage' },
      {
        store,
        now,
        newJobId: ids,
        runEngine: async ({ onAgentSession }) => {
          onAgentSession?.({ agent: 'claude', sessionId: 's1' })
          return { feature: 'checkout', applied: [], orphanTestsBefore: [], ledger: {} as never }
        },
      },
    )
    await completion
    const saved = store.get(manifest.jobId)!
    expect(saved.sessionRef).toEqual({ agent: 'claude', sessionId: 's1' })
  })

  it('logs a message but continues when the coverage chain job already runs (CoverageJobConflictError)', async () => {
    // Hold a coverage slot open so the summary→chain attempt hits a conflict.
    let releaseCoverage!: () => void
    const coverageGate = new Promise<void>((r) => { releaseCoverage = r })

    // Start a standalone coverage job that never finishes (holds the single-flight slot).
    const blocker = startCoverageJob(
      { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'coverage' },
      {
        store,
        now,
        newJobId: ids,
        runEngine: async () => { await coverageGate; return { feature: 'checkout', applied: [], orphanTestsBefore: [], ledger: {} as never } },
      },
    )

    // Now start a summary job for the same feature — it will try to chain a
    // coverage job after finishing, but the slot is occupied → CoverageJobConflictError.
    const { manifest: summaryManifest, completion: summaryCompletion } = startCoverageJob(
      { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'summary' },
      {
        store,
        now,
        newJobId: ids,
        regenerate: async ({ onOutput }) => {
          onOutput?.('done\n')
          return { feature: 'checkout', summary: { requirements: [{ id: 'R1', title: 't', text: 'x', pathTypes: ['happy'] }], docsHash: 'h', sourceDocs: [], generatedAt: now() }, written: [] }
        },
        // The chained coverage job is started via the same deps object; the
        // runEngine stub is not called because the slot is occupied.
        runEngine: async () => { throw new Error('should not be called') },
      },
    )

    await summaryCompletion

    const summary = store.get(summaryManifest.jobId)!
    expect(summary.status).toBe('done')
    // The chain was skipped — no chainedJobId recorded.
    expect(summary.chainedJobId).toBeUndefined()
    // Log must mention the skip.
    expect(summary.log).toContain('coverage not started')

    // Clean up the blocker.
    releaseCoverage()
    await blocker.completion
  })
})
