import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CoverageJobRunStore } from './store'
import { startCoverageJob, CoverageJobConflictError } from './runner'

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
  it('runs a summary job to done and records the result', async () => {
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
        runEngine: async () => { throw new Error('should not run') },
      },
    )
    expect(manifest.status).toBe('running')
    await completion
    const done = store.get(manifest.jobId)!
    expect(done.status).toBe('done')
    expect(done.result?.requirementCount).toBe(1)
    expect(done.log).toContain('summarizing')
  })

  it('runs a coverage job and records applied/proposed counts', async () => {
    const { manifest, completion } = startCoverageJob(
      { featuresDir: 'f', logsDir: tmpDir, feature: 'checkout', kind: 'coverage', reviewMode: true },
      {
        store,
        now,
        newJobId: ids,
        regenerate: async () => { throw new Error('nope') },
        runEngine: async () => ({ feature: 'checkout', applied: [], proposed: [{ testName: 't', requirements: ['R1'], source: 'deterministic' }], orphanTestsBefore: ['t'], ledger: {} as never }),
      },
    )
    await completion
    const done = store.get(manifest.jobId)!
    expect(done.status).toBe('done')
    expect(done.result).toMatchObject({ applied: 0, proposed: 1, reviewMode: true })
    expect(done.reviewMode).toBe(true)
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
      { store, now, newJobId: ids, regenerate: async () => { await gate; return { feature: 'checkout', summary: { requirements: [], docsHash: 'h', sourceDocs: [], generatedAt: now() }, written: [] } } },
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
        { store, now, newJobId: ids, runEngine: async () => ({ feature: 'checkout', applied: [], proposed: [], orphanTestsBefore: [], ledger: {} as never }) },
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
