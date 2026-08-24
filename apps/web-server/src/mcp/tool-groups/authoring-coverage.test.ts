import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { slugify } from '../../features/runs/logic/runtime/summary-types'
import { registerCoverageAuthoringTools } from './authoring-coverage'
import { BUSY_ACTIVE, captureTools, fakeGettingStartedDemo } from './__fixtures__/tool-group-harness'

// The offloaded coverage surface: the calling client does the reading and the
// inference, Canary hands out context and writes the answer through its own
// canonical writers. Each pass is a PAIR of tools — start_* mints the job and
// returns the prompt, submit_* applies the result — so every test here drives
// the real pair against real files instead of hand-building a job manifest.
//
// The error handling is deliberately asymmetric, and would be easy to "tidy"
// into uniformity. Both start_* tools re-raise anything that is neither a
// missing feature nor a single-flight conflict: those two are normal answers a
// client can act on, whereas a store that cannot be written is not — reported as
// a tool error it would read to an agent as "nothing is wrong, just try again".
// The submit_* tools render every throw as a tool error instead, because by then
// the client is holding work it needs to be told how to re-submit.

let tmpDir: string
let featuresDir: string
let logsDir: string

const SPEC_HEADER = `import { test, expect } from '@playwright/test'\n`
const CREATE_TEST = `test('creates a todo', async () => {\n  expect(1).toBe(1)\n})\n`
const DELETE_TEST = `test('deletes a todo', async () => {\n  expect(2).toBe(2)\n})\n`

function harness(over: Record<string, unknown> = {}) {
  const published: unknown[] = []
  const tools = captureTools(registerCoverageAuthoringTools, {
    featuresDir,
    store: { logsDir },
    workspaceEvents: { publish: (e: unknown) => published.push(e) },
    ...over,
  })
  return { ...tools, published }
}

/** A feature with one source doc (so a summary pass has something to read) and
 *  one untagged spec (so a mapping pass has something to map). */
function writeFeature(name = 'checkout', specBody = CREATE_TEST): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: ['local'], repos: [], featureDir: __dirname } }`,
  )
  fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), SPEC_HEADER + specBody)
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Todos\na user can create a todo\n')
  return dir
}

function readJob(jobId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(logsDir, 'coverage-jobs', jobId, 'job.json'), 'utf-8')) as Record<string, unknown>
}

/** Seeds the PRD summary through the tools themselves, so the requirement spine
 *  a mapping links to is minted by the same reconciler the surface ships. */
async function seedSummary(feature = 'checkout'): Promise<void> {
  const { call } = harness()
  const started = await call('start_external_summary', { feature, session_id: 's-sum' })
  const out = await call('submit_external_summary', {
    jobId: started.jobId,
    requirements: [{ title: 'Create todo', text: 'a user can create a todo', pathTypes: ['happy'] }],
  })
  expect(out.requirementCount).toBe(1)
}

async function startCoverageJob(feature = 'checkout'): Promise<string> {
  const { call } = harness()
  const started = await call('start_external_coverage', { feature, session_id: 's-cov' })
  expect(started.status).toBe('running')
  return started.jobId as string
}

/** The proven axis joins each test to the latest recorded run, so `provenPct`
 *  only rides back on a submit once the feature has one. The summary keys tests
 *  by log-marker slug, not by title — hence the real `slugify`, so a title this
 *  helper is later reused with cannot silently miss the join. */
function recordPassingRun(feature: string, testTitles: string[]): void {
  fs.mkdirSync(path.join(logsDir, 'runs', 'r1'), { recursive: true })
  fs.writeFileSync(
    path.join(logsDir, 'runs', 'index.json'),
    JSON.stringify([{ runId: 'r1', feature, startedAt: '2026-03-01T00:00:00Z', status: 'passed' }]),
  )
  fs.writeFileSync(
    path.join(logsDir, 'runs', 'r1', 'e2e-summary.json'),
    JSON.stringify({ passedNames: testTitles.map((t) => `test-case-${slugify(t)}`), failed: [] }),
  )
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-authcov-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('start_external_summary', () => {
  it('asks the user for a PRD instead of minting a job it cannot ground', async () => {
    const dir = writeFeature()
    fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true })
    const { call } = harness()

    const out = await call('start_external_summary', { feature: 'checkout', session_id: 's1' })

    expect(out.status).toBe('needs-docs')
    // The steering has to name the user, not a retry: an invented PRD would
    // ground every later coverage number in fiction.
    expect(out.next).toContain('ASK THE USER')
    expect(out.next).toContain('write_feature_doc("checkout"')
    expect(out).not.toHaveProperty('jobId')
    expect(fs.existsSync(path.join(logsDir, 'coverage-jobs'))).toBe(false)
  })

  it('hands back the docs to read and pins the client conversation on the job', async () => {
    writeFeature()
    const { call } = harness()

    const out = await call('start_external_summary', {
      feature: 'checkout',
      session_id: 's1',
      client_kind: 'claude',
      conversation_name: 'summary chat',
      external_session_url: 'https://claude.ai/chat/abc',
    })

    expect(out.status).toBe('running')
    expect(out.canaryLabBehavior).toBe('tracking-only')
    expect(out.nextSteps).toEqual(['submit_external_summary'])
    expect(out.next).toContain(out.jobId as string)
    const context = out.context as { docs: Array<{ relPath: string }>; previousRequirementIds: string[] }
    expect(context.docs.map((d) => d.relPath)).toContain('spec.md')
    expect(context.previousRequirementIds).toEqual([])
    // The optional identity fields reach the persisted manifest — that record is
    // what the UI's job monitor reads, so dropping them loses the session link.
    const job = readJob(out.jobId as string)
    expect(job.externalConversationName).toBe('summary chat')
    expect(job.externalSessionUrl).toBe('https://claude.ai/chat/abc')
    expect(job.externalClientKind).toBe('claude')
  })

  it('refuses an unknown feature by name', async () => {
    const { text } = harness()

    expect(await text('start_external_summary', { feature: 'ghost', session_id: 's1' })).toBe('feature not found: ghost')
  })

  it('names the job already in flight so the client can wait for the right one', async () => {
    writeFeature()
    const { call, text } = harness()
    const first = await call('start_external_summary', { feature: 'checkout', session_id: 's1' })

    const out = await text('start_external_summary', { feature: 'checkout', session_id: 's2' })

    expect(out).toContain('a summary job is already running for checkout')
    expect(out).toContain(`(existing job ${first.jobId as string})`)
  })

  it('re-raises a store failure rather than passing it off as a normal answer', async () => {
    writeFeature()
    fs.chmodSync(logsDir, 0o500)
    try {
      const { text } = harness()

      await expect(text('start_external_summary', { feature: 'checkout', session_id: 's1' }))
        .rejects.toThrow(/EACCES|permission denied/i)
    } finally {
      fs.chmodSync(logsDir, 0o700)
    }
  })
})

describe('submit_external_summary', () => {
  it('writes the summary sidecar and points at the mapping pass', async () => {
    const dir = writeFeature()
    const { call } = harness()
    const started = await call('start_external_summary', { feature: 'checkout', session_id: 's1' })

    const out = await call('submit_external_summary', {
      jobId: started.jobId,
      requirements: [{ title: 'Create todo', text: 'a user can create a todo', pathTypes: ['happy'] }],
    })

    expect(out.status).toBe('done')
    expect(out.requirementCount).toBe(1)
    expect(out.written).toContain(path.join('docs', '_prd-summary.json'))
    expect(out.nextSteps).toEqual(['start_external_coverage'])
    expect(out.next).toContain('start_external_coverage("checkout")')
    // Canary mints the id — the client never renumbers the spine.
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'docs', '_prd-summary.json'), 'utf-8')) as {
      requirements: Array<{ id: string; title: string }>
      variantDimension?: unknown
    }
    expect(summary.requirements[0]).toMatchObject({ id: 'R1', title: 'Create todo' })
    expect(summary.variantDimension).toBeUndefined()
  })

  it('carries a declared variant dimension into the written summary', async () => {
    const dir = writeFeature()
    const { call } = harness()
    const started = await call('start_external_summary', { feature: 'checkout', session_id: 's1' })

    await call('submit_external_summary', {
      jobId: started.jobId,
      requirements: [{ title: 'Notify', text: 'a user is notified', pathTypes: ['happy'], variants: ['email', 'sms'] }],
      variantDimension: { name: 'channel', values: ['email', 'sms'] },
    })

    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'docs', '_prd-summary.json'), 'utf-8')) as {
      variantDimension?: { name: string; values: string[] }
    }
    expect(summary.variantDimension).toEqual({ name: 'channel', values: ['email', 'sms'] })
  })

  it('reports a feature deleted while the client was reading', async () => {
    writeFeature()
    const { call, text } = harness()
    const started = await call('start_external_summary', { feature: 'checkout', session_id: 's1' })
    fs.rmSync(path.join(featuresDir, 'checkout'), { recursive: true, force: true })

    const out = await text('submit_external_summary', {
      jobId: started.jobId,
      requirements: [{ title: 'Create todo', text: 'a user can create a todo', pathTypes: ['happy'] }],
    })

    expect(out).toBe('feature not found: checkout')
  })

  it('reports an unknown job id instead of throwing at the client', async () => {
    const { text } = harness()

    expect(await text('submit_external_summary', { jobId: 'cj-nope', requirements: [] }))
      .toBe('coverage job not found: cj-nope')
  })
})

describe('start_external_coverage', () => {
  it('sends the client to the summary pass when there is no spine to map to', async () => {
    writeFeature()
    const { call } = harness()

    const out = await call('start_external_coverage', { feature: 'checkout', session_id: 's1' })

    expect(out.status).toBe('needs-summary')
    expect(out.next).toContain('start_external_summary')
    expect(out).not.toHaveProperty('jobId')
    expect(fs.existsSync(path.join(logsDir, 'coverage-jobs'))).toBe(false)
  })

  it('hands back the requirements, the specs to read, and the fan-out steering', async () => {
    const dir = writeFeature()
    await seedSummary()
    const { call } = harness()

    const out = await call('start_external_coverage', {
      feature: 'checkout',
      session_id: 's1',
      client_kind: 'codex',
      conversation_name: 'mapping chat',
      external_session_url: 'https://chatgpt.com/c/xyz',
    })

    expect(out.status).toBe('running')
    expect(out.canaryLabBehavior).toBe('tracking-only')
    expect(out.nextSteps).toEqual(['submit_external_coverage'])
    const context = out.context as { requirements: Array<{ id: string }>; tests: Array<{ testName: string; file?: string }> }
    expect(context.requirements.map((r) => r.id)).toEqual(['R1'])
    // An absolute spec path, because the client reads the file itself.
    expect(context.tests).toEqual([expect.objectContaining({
      testName: 'creates a todo',
      file: path.join(dir, 'e2e', 'a.spec.ts'),
    })])
    // The completeness rule is the price of client-side fan-out, so the steering
    // states it on the way out rather than only in the rejection.
    expect(out.next).toContain('every test in mappings[] or unmappable[]')
    expect(out.next).toContain(out.jobId as string)
    const job = readJob(out.jobId as string)
    expect(job.externalConversationName).toBe('mapping chat')
    expect(job.externalSessionUrl).toBe('https://chatgpt.com/c/xyz')
  })

  it('refuses an unknown feature by name', async () => {
    const { text } = harness()

    expect(await text('start_external_coverage', { feature: 'ghost', session_id: 's1' })).toBe('feature not found: ghost')
  })

  it('names the job already in flight so the client can wait for the right one', async () => {
    writeFeature()
    await seedSummary()
    const jobId = await startCoverageJob()
    const { text } = harness()

    const out = await text('start_external_coverage', { feature: 'checkout', session_id: 's2' })

    expect(out).toContain('a coverage job is already running for checkout')
    expect(out).toContain(`(existing job ${jobId})`)
  })

  it('re-raises a store failure rather than passing it off as a normal answer', async () => {
    writeFeature()
    await seedSummary()
    // Seeding the summary already created the job store's directory, so the
    // write this blocks is the one inside it.
    const jobsDir = path.join(logsDir, 'coverage-jobs')
    fs.chmodSync(jobsDir, 0o500)
    try {
      const { text } = harness()

      await expect(text('start_external_coverage', { feature: 'checkout', session_id: 's1' }))
        .rejects.toThrow(/EACCES|permission denied/i)
    } finally {
      fs.chmodSync(jobsDir, 0o700)
    }
  })
})

describe('submit_external_coverage', () => {
  it('writes the tag through the canonical writer and reports a clean apply', async () => {
    const dir = writeFeature()
    await seedSummary()
    const jobId = await startCoverageJob()
    const { call } = harness()

    const out = await call('submit_external_coverage', {
      jobId,
      mappings: [{ testName: 'creates a todo', requirements: ['R1'], pathTypes: ['happy'] }],
    })

    expect(out.status).toBe('done')
    expect(out.applied).toBe(1)
    expect(out.coveragePct).toBe(100)
    expect(out.nextSteps).toEqual(['get_feature_coverage'])
    expect(out.next).toContain('Wrote 1 covers tag(s).')
    // Nothing flagged and no run on record, so neither optional field rides along
    // — a `flagged: 0` would read as a validation verdict the client must chase.
    expect(out).not.toHaveProperty('flagged')
    expect(out).not.toHaveProperty('provenPct')
    const spec = fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')
    expect(spec).toContain('@req-R1')
    expect(spec).toContain('expect(1).toBe(1)') // body untouched
  })

  it('surfaces a flagged count without withholding the mapping', async () => {
    writeFeature()
    await seedSummary()
    const jobId = await startCoverageJob()
    const { call } = harness()

    const out = await call('submit_external_coverage', {
      jobId,
      mappings: [{ testName: 'creates a todo', requirements: ['R1'], pathTypes: ['happy'], confidence: 0.2 }],
    })

    // Flag, don't drop: the tag is written and the count is advisory.
    expect(out.applied).toBe(1)
    expect(out.flagged).toBe(1)
    expect(out.next).toContain('1 flagged by deterministic validation')
  })

  it('accepts a test the client read and found no requirement for', async () => {
    writeFeature('checkout', CREATE_TEST + DELETE_TEST)
    await seedSummary()
    const jobId = await startCoverageJob()
    const { call } = harness()

    const out = await call('submit_external_coverage', {
      jobId,
      mappings: [{ testName: 'creates a todo', requirements: ['R1'], pathTypes: ['happy'] }],
      unmappable: [{ testName: 'deletes a todo', reason: 'no requirement covers deletion yet' }],
    })

    expect(out.status).toBe('done')
    expect(out.applied).toBe(1)
  })

  it('rejects an answer that leaves a test unaccounted for, naming it', async () => {
    writeFeature('checkout', CREATE_TEST + DELETE_TEST)
    await seedSummary()
    const jobId = await startCoverageJob()
    const { text } = harness()

    const out = await text('submit_external_coverage', {
      jobId,
      mappings: [{ testName: 'creates a todo', requirements: ['R1'], pathTypes: ['happy'] }],
    })

    // Silence from a subagent is indistinguishable from "read it, found nothing",
    // and scoring the test uncovered on silence is a verdict without evidence.
    expect(out).toContain('accounts for 1 of 2 tests')
    expect(out).toContain('Missing: deletes a todo')
  })

  it('reports a feature deleted while the client was mapping', async () => {
    writeFeature()
    await seedSummary()
    const jobId = await startCoverageJob()
    fs.rmSync(path.join(featuresDir, 'checkout'), { recursive: true, force: true })
    const { text } = harness()

    const out = await text('submit_external_coverage', {
      jobId,
      mappings: [{ testName: 'creates a todo', requirements: ['R1'] }],
    })

    expect(out).toBe('feature not found: checkout')
  })

  it('rides the proven axis back once the feature has a recorded run', async () => {
    writeFeature()
    await seedSummary()
    const jobId = await startCoverageJob()
    recordPassingRun('checkout', ['creates a todo'])
    const { call } = harness()

    const out = await call('submit_external_coverage', {
      jobId,
      mappings: [{ testName: 'creates a todo', requirements: ['R1'], pathTypes: ['happy'] }],
    })

    // Claimed AND proven: the tag was written and the test passed in the latest
    // run, which is the whole distinction the second percentage exists to carry.
    expect(out.coveragePct).toBe(100)
    expect(out.provenPct).toBe(100)
  })
})

describe('Getting Started demo tracking (start_external_summary / start_external_coverage)', () => {
  it('rejects both starts as busy while another demo owns the workspace', async () => {
    // The claim gate sits BEFORE the docs/summary checks, so no seeding needed.
    writeFeature()
    const gs = fakeGettingStartedDemo({ kind: 'busy', active: BUSY_ACTIVE, message: 'busy with run' })
    const { call } = harness({ gettingStartedDemo: gs.demo })

    for (const tool of ['start_external_summary', 'start_external_coverage'] as const) {
      const out = await call(tool, { feature: 'checkout', session_id: 's1' })
      expect(out.type).toBe('getting_started_busy')
      expect(out.active).toEqual(BUSY_ACTIVE)
      expect(out.message).toBe('busy with run')
      // The steering must forbid a second workflow, not suggest a retry.
      expect((out.nextSteps as string[]).join(' ')).toContain('do not start another Getting Started workflow')
    }
    // Rejected before any job was minted — nothing to attach or abandon.
    expect(gs.attached).toEqual([])
    expect(gs.abandoned).toEqual([])
    expect(fs.existsSync(path.join(logsDir, 'coverage-jobs'))).toBe(false)
  })

  it('each start claims the coverage card and attaches its own job', async () => {
    writeFeature()
    const gsSummary = fakeGettingStartedDemo({ kind: 'claimed', sessionId: 'gs-sum' })
    const { call } = harness({ gettingStartedDemo: gsSummary.demo })

    const summary = await call('start_external_summary', { feature: 'checkout', session_id: 's1' })
    expect(gsSummary.claims).toEqual([{ workflow: 'coverage', feature: 'checkout' }])
    expect(gsSummary.attached).toEqual([
      { sessionId: 'gs-sum', target: { kind: 'coverage-job', id: summary.jobId, feature: 'checkout' } },
    ])
    expect(gsSummary.abandoned).toEqual([])

    await call('submit_external_summary', {
      jobId: summary.jobId,
      requirements: [{ title: 'Create todo', text: 'a user can create a todo', pathTypes: ['happy'] }],
    })
    // The mapping pass re-claims under the same card — a fresh session id.
    const gsCoverage = fakeGettingStartedDemo({ kind: 'claimed', sessionId: 'gs-cov' })
    const { call: callCoverage } = harness({ gettingStartedDemo: gsCoverage.demo })
    const coverage = await callCoverage('start_external_coverage', { feature: 'checkout', session_id: 's2' })
    expect(gsCoverage.attached).toEqual([
      { sessionId: 'gs-cov', target: { kind: 'coverage-job', id: coverage.jobId, feature: 'checkout' } },
    ])
  })

  it('a start that mints no job releases the claim instead of locking the card', async () => {
    // needs-docs (no PRD) and needs-summary (no spine) both answer without a
    // job — an unreleased claim would block every card until a restart.
    const dir = writeFeature()
    fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true })
    const gsSummary = fakeGettingStartedDemo({ kind: 'claimed', sessionId: 'gs-sum' })
    const { call } = harness({ gettingStartedDemo: gsSummary.demo })
    const summary = await call('start_external_summary', { feature: 'checkout', session_id: 's1' })
    expect(summary.status).toBe('needs-docs')
    expect(gsSummary.abandoned).toEqual(['gs-sum'])
    expect(gsSummary.attached).toEqual([])

    const gsCoverage = fakeGettingStartedDemo({ kind: 'claimed', sessionId: 'gs-cov' })
    const { call: callCoverage } = harness({ gettingStartedDemo: gsCoverage.demo })
    const coverage = await callCoverage('start_external_coverage', { feature: 'checkout', session_id: 's2' })
    expect(coverage.status).toBe('needs-summary')
    expect(gsCoverage.abandoned).toEqual(['gs-cov'])
    expect(gsCoverage.attached).toEqual([])
  })

  it('a start that throws releases the claim on the way out', async () => {
    // A same-kind job already in flight trips the single-flight conflict AFTER
    // the claim succeeded — the catch must abandon it or the card locks.
    writeFeature()
    const { call } = harness()
    const runningSummary = await call('start_external_summary', { feature: 'checkout', session_id: 's1' })

    const gsSummary = fakeGettingStartedDemo({ kind: 'claimed', sessionId: 'gs-sum' })
    const { text } = harness({ gettingStartedDemo: gsSummary.demo })
    const out = await text('start_external_summary', { feature: 'checkout', session_id: 's2' })
    expect(out).toContain('already running for checkout')
    expect(gsSummary.abandoned).toEqual(['gs-sum'])

    await call('submit_external_summary', {
      jobId: runningSummary.jobId,
      requirements: [{ title: 'Create todo', text: 'a user can create a todo', pathTypes: ['happy'] }],
    })
    await startCoverageJob()
    const gsCoverage = fakeGettingStartedDemo({ kind: 'claimed', sessionId: 'gs-cov' })
    const { text: textCoverage } = harness({ gettingStartedDemo: gsCoverage.demo })
    const covOut = await textCoverage('start_external_coverage', { feature: 'checkout', session_id: 's3' })
    expect(covOut).toContain('already running for checkout')
    expect(gsCoverage.abandoned).toEqual(['gs-cov'])
  })
})
