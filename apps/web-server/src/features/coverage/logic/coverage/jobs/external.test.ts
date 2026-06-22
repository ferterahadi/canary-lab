import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startExternalCoverage, submitExternalCoverage } from './external'
import { CoverageJobConflictError } from './runner'
import { CoverageJobRunStore } from './store'
import { regeneratePrdSummary } from '../service'
import type { WorkspaceEvent, WorkspaceEventPublisher } from '../../../../../shared/workspace-events'

let tmpDir: string
let featuresDir: string
let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cov-ext-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// One untagged test whose name overlaps the "Create todo" requirement (R1).
const SPEC = `
  import { test, expect } from '@playwright/test'
  test('create makes a new todo item', async () => {
    expect(1).toBe(1)
  })
`

function writeFeature(name: string): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), SPEC)
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Create todo\na user can create a new todo item')
  return dir
}

async function seedSummary(name: string) {
  await regeneratePrdSummary({ featuresDir, feature: name, adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
}

function collector() {
  const events: WorkspaceEvent[] = []
  const publisher: WorkspaceEventPublisher = { publish: (e) => events.push(e) }
  return { events, publisher }
}

describe('startExternalCoverage', () => {
  it('returns needs-summary (and creates no job) when the feature has no PRD summary', () => {
    writeFeature('checkout')
    const store = new CoverageJobRunStore(logsDir)
    const res = startExternalCoverage(
      { featuresDir, logsDir, feature: 'checkout', sessionId: 's1' },
      { store },
    )
    expect(res.kind).toBe('needs-summary')
    expect(store.list()).toHaveLength(0)
  })

  it('creates an external coverage job (producer external, no sessionRef) and returns the mapping context', async () => {
    writeFeature('checkout')
    await seedSummary('checkout')
    const store = new CoverageJobRunStore(logsDir)
    const res = startExternalCoverage(
      { featuresDir, logsDir, feature: 'checkout', sessionId: 's1', clientKind: 'claude-desktop', conversationName: 'cov chat' },
      { store },
    )
    expect(res.kind).toBe('started')
    if (res.kind !== 'started') return
    expect(res.manifest.producer).toBe('external')
    expect(res.manifest.kind).toBe('coverage')
    expect(res.manifest.status).toBe('running')
    expect(res.manifest.sessionRef).toBeUndefined()
    expect(res.manifest.externalClientKind).toBe('claude-desktop')
    expect(res.manifest.externalSessionId).toBe('s1')
    // Context carries the requirements, the tests, and the reusable mapping prompt.
    expect(res.context.requirements.map((r) => r.id)).toContain('R1')
    expect(res.context.tests.map((t) => t.testName)).toContain('create makes a new todo item')
    expect(res.context.prompt).toContain('create makes a new todo item')
    // Job is persisted and visible to a fresh store instance (file-backed).
    expect(new CoverageJobRunStore(logsDir).get(res.manifest.jobId)?.producer).toBe('external')
  })

  it('is single-flight: rejects when a coverage job is already running for the feature', async () => {
    writeFeature('checkout')
    await seedSummary('checkout')
    const store = new CoverageJobRunStore(logsDir)
    store.save({ jobId: 'cj-running', feature: 'checkout', kind: 'coverage', status: 'running', startedAt: new Date().toISOString(), log: '' })
    expect(() =>
      startExternalCoverage({ featuresDir, logsDir, feature: 'checkout', sessionId: 's1' }, { store }),
    ).toThrow(CoverageJobConflictError)
  })
})

describe('submitExternalCoverage', () => {
  it('applies the mapping (writes the @req tag), marks the job done, and emits coverage-changed', async () => {
    const dir = writeFeature('checkout')
    await seedSummary('checkout')
    const store = new CoverageJobRunStore(logsDir)
    const started = startExternalCoverage({ featuresDir, logsDir, feature: 'checkout', sessionId: 's1' }, { store })
    if (started.kind !== 'started') throw new Error('expected started')

    const { events, publisher } = collector()
    const { manifest, result } = submitExternalCoverage(
      {
        featuresDir,
        logsDir,
        jobId: started.manifest.jobId,
        mappings: [{ testName: 'create makes a new todo item', requirements: ['R1'], pathTypes: ['happy'] }],
      },
      { store, workspaceEvents: publisher },
    )

    expect(manifest.status).toBe('done')
    expect(manifest.result?.applied).toBe(1)
    expect(result.applied.map((m) => m.testName)).toContain('create makes a new todo item')
    // The canonical tag-writer wrote the tag into the spec, body untouched.
    const spec = fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')
    expect(spec).toContain('@req-R1')
    expect(spec).toContain('expect(1).toBe(1)')
    // Recomputed ledger sees the test as annotated.
    expect(result.ledger.orphanTestNames).not.toContain('create makes a new todo item')
    // Live update fired.
    expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
  })

  it('drops mappings to unknown requirement ids and unknown test names', async () => {
    const dir = writeFeature('checkout')
    await seedSummary('checkout')
    const store = new CoverageJobRunStore(logsDir)
    const started = startExternalCoverage({ featuresDir, logsDir, feature: 'checkout', sessionId: 's1' }, { store })
    if (started.kind !== 'started') throw new Error('expected started')

    const { result } = submitExternalCoverage(
      {
        featuresDir,
        logsDir,
        jobId: started.manifest.jobId,
        mappings: [
          { testName: 'create makes a new todo item', requirements: ['R999'] }, // unknown id → dropped
          { testName: 'no such test', requirements: ['R1'] }, // unknown test → dropped
        ],
      },
      { store },
    )
    expect(result.applied).toHaveLength(0)
    const spec = fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')
    expect(spec).not.toContain('@req-')
  })

  it('tolerates a job reconciled to aborted by a server restart (still applies + finalizes)', async () => {
    writeFeature('checkout')
    await seedSummary('checkout')
    const store = new CoverageJobRunStore(logsDir)
    const started = startExternalCoverage({ featuresDir, logsDir, feature: 'checkout', sessionId: 's1' }, { store })
    if (started.kind !== 'started') throw new Error('expected started')
    // Simulate the boot-time reconcile flipping the interrupted job to aborted.
    store.save({ ...started.manifest, status: 'aborted', endedAt: new Date().toISOString(), error: 'Interrupted by server restart' })

    const { manifest, result } = submitExternalCoverage(
      {
        featuresDir,
        logsDir,
        jobId: started.manifest.jobId,
        mappings: [{ testName: 'create makes a new todo item', requirements: ['R1'] }],
      },
      { store },
    )
    expect(manifest.status).toBe('done')
    expect(result.applied).toHaveLength(1)
  })

  it('rejects a non-external (internal) coverage job', () => {
    const store = new CoverageJobRunStore(logsDir)
    store.save({ jobId: 'cj-internal', feature: 'checkout', kind: 'coverage', status: 'running', startedAt: new Date().toISOString(), log: '' })
    expect(() =>
      submitExternalCoverage({ featuresDir, logsDir, jobId: 'cj-internal', mappings: [] }, { store }),
    ).toThrow(/only external coverage jobs/)
  })

  it('throws for an unknown job id', () => {
    const store = new CoverageJobRunStore(logsDir)
    expect(() =>
      submitExternalCoverage({ featuresDir, logsDir, jobId: 'nope', mappings: [] }, { store }),
    ).toThrow(/coverage job not found/)
  })
})
