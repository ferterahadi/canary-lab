import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startExternalCoverage, submitExternalCoverage, startExternalSummary, submitExternalSummary } from './external'
import { readPrdSummary } from '../prd-summary'
import { CoverageJobConflictError } from './runner'
import { CoverageJobRunStore } from './store'
import { regeneratePrdSummary as regeneratePrdSummaryReal } from '../service'
import { fakeSummarize } from '../__fixtures__/fake-coverage-agents'
import type { WorkspaceEvent, WorkspaceEventPublisher } from '../../../../../shared/workspace-events'

// Coverage generation is LLM-only; inject the fake summarizer via the dep seam.
const regeneratePrdSummary = (args: Parameters<typeof regeneratePrdSummaryReal>[0]) =>
  regeneratePrdSummaryReal(args, { summarize: fakeSummarize })

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
  await regeneratePrdSummary({ featuresDir, feature: name, now: '2026-01-01T00:00:00Z' })
}

function collector() {
  const events: WorkspaceEvent[] = []
  const publisher: WorkspaceEventPublisher = { publish: (e) => events.push(e) }
  return { events, publisher }
}

describe('startExternalCoverage', () => {
  it('throws FeatureNotFoundError for an unknown feature', () => {
    const store = new CoverageJobRunStore(logsDir)
    expect(() =>
      startExternalCoverage({ featuresDir, logsDir, feature: 'nonexistent', sessionId: 's1' }, { store }),
    ).toThrow('nonexistent')
  })

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
      { featuresDir, logsDir, feature: 'checkout', sessionId: 's1', clientKind: 'claude', conversationName: 'cov chat' },
      { store },
    )
    expect(res.kind).toBe('started')
    if (res.kind !== 'started') return
    expect(res.manifest.producer).toBe('external')
    expect(res.manifest.kind).toBe('coverage')
    expect(res.manifest.status).toBe('running')
    expect(res.manifest.sessionRef).toBeUndefined()
    expect(res.manifest.externalClientKind).toBe('claude')
    expect(res.manifest.externalSessionId).toBe('s1')
    // Context carries the requirements, the tests, and the reusable mapping prompt.
    expect(res.context.requirements.map((r) => r.id)).toContain('R1')
    expect(res.context.tests.map((t) => t.testName)).toContain('create makes a new todo item')
    expect(res.context.prompt).toContain('create makes a new todo item')
    // Job is persisted and visible to a fresh store instance (file-backed).
    expect(new CoverageJobRunStore(logsDir).get(res.manifest.jobId)?.producer).toBe('external')
  })

  it('emits coverage-changed on start so an open UI flips to Generating live', async () => {
    writeFeature('checkout')
    await seedSummary('checkout')
    const store = new CoverageJobRunStore(logsDir)
    const { events, publisher } = collector()
    const res = startExternalCoverage(
      { featuresDir, logsDir, feature: 'checkout', sessionId: 's1' },
      { store, workspaceEvents: publisher },
    )
    expect(res.kind).toBe('started')
    expect(events).toEqual([{ type: 'coverage-changed', feature: 'checkout' }])
  })

  it('does not emit when start is rejected for a missing summary', () => {
    writeFeature('checkout')
    const store = new CoverageJobRunStore(logsDir)
    const { events, publisher } = collector()
    startExternalCoverage({ featuresDir, logsDir, feature: 'checkout', sessionId: 's1' }, { store, workspaceEvents: publisher })
    expect(events).toHaveLength(0)
  })

  it('includes externalSessionUrl in the manifest when sessionUrl is provided', async () => {
    writeFeature('checkout')
    await seedSummary('checkout')
    const store = new CoverageJobRunStore(logsDir)
    const res = startExternalCoverage(
      { featuresDir, logsDir, feature: 'checkout', sessionId: 's1', sessionUrl: 'https://claude.ai/chat/abc' },
      { store },
    )
    expect(res.kind).toBe('started')
    if (res.kind !== 'started') return
    expect(res.manifest.externalSessionUrl).toBe('https://claude.ai/chat/abc')
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

describe('startExternalSummary', () => {
  it('throws FeatureNotFoundError for an unknown feature', () => {
    const store = new CoverageJobRunStore(logsDir)
    expect(() =>
      startExternalSummary({ featuresDir, logsDir, feature: 'nonexistent', sessionId: 's1' }, { store }),
    ).toThrow('nonexistent')
  })

  it('returns needs-docs (and creates no job) when the feature has no source doc', () => {
    const dir = writeFeature('checkout')
    fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true })
    const store = new CoverageJobRunStore(logsDir)
    const res = startExternalSummary({ featuresDir, logsDir, feature: 'checkout', sessionId: 's1' }, { store })
    expect(res.kind).toBe('needs-docs')
    expect(store.list()).toHaveLength(0)
  })

  it('creates an external summary job (producer external, kind summary, no sessionRef) and returns the authoring context', () => {
    writeFeature('checkout')
    const store = new CoverageJobRunStore(logsDir)
    const res = startExternalSummary(
      { featuresDir, logsDir, feature: 'checkout', sessionId: 's1', clientKind: 'claude', conversationName: 'sum chat' },
      { store },
    )
    expect(res.kind).toBe('started')
    if (res.kind !== 'started') return
    expect(res.manifest.producer).toBe('external')
    expect(res.manifest.kind).toBe('summary')
    expect(res.manifest.status).toBe('running')
    expect(res.manifest.sessionRef).toBeUndefined()
    expect(res.manifest.externalClientKind).toBe('claude')
    // Context lists the source docs to read + the reusable summarization prompt;
    // no prior summary yet → empty preserve list.
    expect(res.context.docs.map((d) => d.relPath)).toContain('spec.md')
    expect(res.context.previousRequirementIds).toEqual([])
    expect(res.context.prompt).toContain('spec.md')
    expect(new CoverageJobRunStore(logsDir).get(res.manifest.jobId)?.kind).toBe('summary')
  })

  it('emits coverage-changed on start so an open UI flips to Generating live', () => {
    writeFeature('checkout')
    const store = new CoverageJobRunStore(logsDir)
    const { events, publisher } = collector()
    startExternalSummary({ featuresDir, logsDir, feature: 'checkout', sessionId: 's1' }, { store, workspaceEvents: publisher })
    expect(events).toEqual([{ type: 'coverage-changed', feature: 'checkout' }])
  })

  it('does not emit when start is rejected for missing docs', () => {
    const dir = writeFeature('checkout')
    fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true })
    const store = new CoverageJobRunStore(logsDir)
    const { events, publisher } = collector()
    startExternalSummary({ featuresDir, logsDir, feature: 'checkout', sessionId: 's1' }, { store, workspaceEvents: publisher })
    expect(events).toHaveLength(0)
  })

  it('is single-flight: rejects when a summary job is already running for the feature', () => {
    writeFeature('checkout')
    const store = new CoverageJobRunStore(logsDir)
    store.save({ jobId: 'cj-running', feature: 'checkout', kind: 'summary', status: 'running', startedAt: new Date().toISOString(), log: '' })
    expect(() =>
      startExternalSummary({ featuresDir, logsDir, feature: 'checkout', sessionId: 's1' }, { store }),
    ).toThrow(CoverageJobConflictError)
  })
})

describe('submitExternalSummary', () => {
  it('writes the PRD summary, marks the job done, and emits coverage-changed', () => {
    writeFeature('checkout')
    const store = new CoverageJobRunStore(logsDir)
    const started = startExternalSummary({ featuresDir, logsDir, feature: 'checkout', sessionId: 's1' }, { store })
    if (started.kind !== 'started') throw new Error('expected started')

    const { events, publisher } = collector()
    const { manifest, result } = submitExternalSummary(
      {
        featuresDir,
        jobId: started.manifest.jobId,
        requirements: [
          { title: 'Create todo', text: 'a user can create a new todo item', pathTypes: ['happy'] },
        ],
        now: () => '2026-02-02T00:00:00Z',
      },
      { store, workspaceEvents: publisher },
    )

    expect(manifest.status).toBe('done')
    expect(manifest.result?.requirementCount).toBe(1)
    expect(result.summary.requirements[0].id).toBe('R1') // canary minted the id
    expect(result.written).toContain(path.join('docs', '_prd-summary.json'))
    // Summary is persisted + readable.
    const stored = readPrdSummary(path.join(featuresDir, 'checkout'))
    expect(stored?.requirements.map((r) => r.title)).toContain('Create todo')
    expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
  })

  it('preserves a prior requirement id when the client echoes it (id spine)', () => {
    writeFeature('checkout')
    const store = new CoverageJobRunStore(logsDir)
    // First pass mints R1.
    const s1 = startExternalSummary({ featuresDir, logsDir, feature: 'checkout', sessionId: 's1' }, { store })
    if (s1.kind !== 'started') throw new Error('expected started')
    submitExternalSummary(
      { featuresDir, jobId: s1.manifest.jobId, requirements: [{ title: 'Create todo', text: 'create a todo', pathTypes: ['happy'] }] },
      { store },
    )
    // Second pass echoes R1 + adds a new requirement → R1 preserved, new one gets R2.
    const s2 = startExternalSummary({ featuresDir, logsDir, feature: 'checkout', sessionId: 's2' }, { store })
    if (s2.kind !== 'started') throw new Error('expected started')
    expect(s2.context.previousRequirementIds).toContain('R1')
    const { result } = submitExternalSummary(
      {
        featuresDir,
        jobId: s2.manifest.jobId,
        requirements: [
          { id: 'R1', title: 'Create todo', text: 'create a todo', pathTypes: ['happy'] },
          { title: 'Delete todo', text: 'delete a todo', pathTypes: ['happy'] },
        ],
      },
      { store },
    )
    const byTitle = new Map(result.summary.requirements.map((r) => [r.title, r.id]))
    expect(byTitle.get('Create todo')).toBe('R1')
    expect(byTitle.get('Delete todo')).toBe('R2')
  })

  it('rejects a non-external (internal) summary job', () => {
    const store = new CoverageJobRunStore(logsDir)
    store.save({ jobId: 'cj-internal', feature: 'checkout', kind: 'summary', status: 'running', startedAt: new Date().toISOString(), log: '' })
    expect(() =>
      submitExternalSummary({ featuresDir, jobId: 'cj-internal', requirements: [] }, { store }),
    ).toThrow(/only external summary jobs/)
  })

  it('rejects an external job that is a coverage job, not a summary job', () => {
    writeFeature('checkout')
    const store = new CoverageJobRunStore(logsDir)
    store.save({ jobId: 'cj-cov', feature: 'checkout', kind: 'coverage', status: 'running', startedAt: new Date().toISOString(), log: '', producer: 'external' })
    expect(() =>
      submitExternalSummary({ featuresDir, jobId: 'cj-cov', requirements: [] }, { store }),
    ).toThrow(/not a summary job/)
  })

  it('throws for an unknown job id', () => {
    const store = new CoverageJobRunStore(logsDir)
    expect(() =>
      submitExternalSummary({ featuresDir, jobId: 'nope', requirements: [] }, { store }),
    ).toThrow(/coverage job not found/)
  })
})
