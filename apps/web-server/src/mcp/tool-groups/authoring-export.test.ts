import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { decode } from '@toon-format/toon'
import type { RunDetail } from '../../features/runs/logic/run-store'
import {
  createEvaluationExportTask,
  deleteEvaluationExportTask,
  evaluationExportTaskPaths,
} from '../../features/evaluation/logic/evaluation-export-store'
import { certificateDigest, registerEvaluationExportTools } from './authoring-export'
import type { BehaviorCertificate } from '../../../../../shared/verification-strength/certificate'
import { BUSY_ACTIVE, captureTools, fakeGettingStartedDemo } from './__fixtures__/tool-group-harness'

// The externally-authored evaluation export: create a task for a finished run,
// submit client wording, then read/download/delete the rendered archive.
//
// Real logs dir, real archive: the whole point of this surface is that Canary
// renders the report, so a mocked writer would prove nothing about the file the
// user downloads. Three behaviours here are evidence rules rather than taste —
// a rewrite must keep the EXACT count and order of the cases the report schema
// handed out (no merging, deduping or dropping), a failed run exports as-is with
// its status intact, and an export is only offered for a run that has finished.

let tmpDir: string
let logsDir: string

/** One declared test named `pays`, passed — enough for a single-case roster.
 *  `knownTests` is the roster source, so it is what decides the case count the
 *  client must match. */
function runDetail(over: Record<string, unknown> = {}, manifest: Record<string, unknown> = {}): RunDetail {
  return {
    runId: 'run-1',
    manifest: {
      runId: 'run-1', feature: 'checkout', env: 'local',
      startedAt: '2026-05-25T08:00:00.000Z', endedAt: '2026-05-25T08:01:00.000Z',
      status: 'passed', healCycles: 0, services: [],
      ...manifest,
    },
    summary: {
      complete: true, total: 1, passed: 1,
      knownTests: [{ name: 'test-case-pays', title: 'pays' }],
      passedNames: ['test-case-pays'],
      failed: [],
    },
    ...over,
  } as unknown as RunDetail
}

function harness(detail: RunDetail | null = runDetail(), over: Record<string, unknown> = {}) {
  return captureTools(registerEvaluationExportTools, {
    store: { logsDir, get: (runId: string) => (detail && runId === detail.runId ? detail : undefined) },
    ...over,
  })
}

/** Starts a task the way a client does and returns its id. `language` is always
 *  present in production (the input schema defaults it), so it is always passed. */
async function startTask(detail: RunDetail = runDetail(), args: Record<string, unknown> = {}): Promise<string> {
  const { call } = harness(detail)
  const out = await call('start_external_evaluation_export', {
    runId: detail.runId, language: 'English', session_id: 's-1', client_kind: 'claude', ...args,
  })
  return (out.task as { taskId: string }).taskId
}

const CASE = { title: 'Shopper pays', whatWasChecked: 'checked', whyItMatters: 'matters', confidence: 'High' }

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-export-')))
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('start_external_evaluation_export', () => {
  it('persists an external task and hands back the submission schema', async () => {
    const { call } = harness()

    const out = await call('start_external_evaluation_export', {
      runId: 'run-1', language: 'English', session_id: 's-1', client_kind: 'claude',
    })

    const task = out.task as Record<string, unknown>
    expect(task).toMatchObject({ runId: 'run-1', feature: 'checkout', producer: 'external', status: 'running' })
    expect(fs.existsSync(evaluationExportTaskPaths(logsDir, String(task.taskId))!.taskJson)).toBe(true)
    expect(out.runSnapshotVia).toBe('get_run("run-1")')
    // The schema is the contract the submission is checked against, so it has to
    // carry the count rule with it — a client that only reads this must not
    // discover the roster size by trial and error.
    const schema = out.reportSchema as { rewrite: { cases: unknown[] }; requiredBehavior: string[] }
    expect(schema.rewrite.cases).toHaveLength(1)
    expect(schema.requiredBehavior.join(' ')).toMatch(/EXACTLY 1 entry.*never change their count or order/s)
  })

  it('records the conversation and the client session link when given', async () => {
    const { call } = harness()

    const out = await call('start_external_evaluation_export', {
      runId: 'run-1', language: 'Bahasa Indonesia', session_id: 's-1', client_kind: 'codex',
      conversation_name: 'export chat', external_session_url: 'https://claude.ai/chat/abc',
    })

    expect(out.task).toMatchObject({
      conversationName: 'export chat',
      externalSessionUrl: 'https://claude.ai/chat/abc',
      language: 'Bahasa Indonesia',
      clientKind: 'codex',
    })
  })

  it('leaves both out when the client did not name them', async () => {
    const { call } = harness()

    const out = await call('start_external_evaluation_export', {
      runId: 'run-1', language: 'English', session_id: 's-1', client_kind: 'other',
    })

    expect(out.task).not.toHaveProperty('conversationName')
    expect(out.task).not.toHaveProperty('externalSessionUrl')
  })

  it('getting-started: rejects the start as busy while another demo owns the workspace', async () => {
    const gs = fakeGettingStartedDemo({ kind: 'busy', active: BUSY_ACTIVE, message: 'busy with run' })
    const { call } = harness(runDetail(), { gettingStartedDemo: gs.demo })

    const out = await call('start_external_evaluation_export', {
      runId: 'run-1', language: 'English', session_id: 's-1', client_kind: 'claude',
    })

    expect(out.type).toBe('getting_started_busy')
    expect(out.active).toEqual(BUSY_ACTIVE)
    expect(gs.attached).toEqual([])
  })

  it('getting-started: a successful start attaches the new task; a gated start never claims', async () => {
    // The claim sits AFTER the terminal/boot gates so a rejected start never
    // needs releasing — a boot session must bounce without touching the card.
    const gs = fakeGettingStartedDemo({ kind: 'claimed', sessionId: 'gs-exp' })
    const boot = runDetail({}, { executionType: 'boot', status: 'aborted' })
    const { text } = harness(boot, { gettingStartedDemo: gs.demo })
    await text('start_external_evaluation_export', {
      runId: 'run-1', language: 'English', session_id: 's-1', client_kind: 'claude',
    })
    expect(gs.claims).toEqual([])

    const { call } = harness(runDetail(), { gettingStartedDemo: gs.demo })
    const out = await call('start_external_evaluation_export', {
      runId: 'run-1', language: 'English', session_id: 's-1', client_kind: 'claude',
    })
    expect(gs.claims).toEqual([{ workflow: 'export', feature: 'checkout' }])
    expect(gs.attached).toEqual([
      { sessionId: 'gs-exp', target: { kind: 'export', id: (out.task as { taskId: string }).taskId, feature: 'checkout' } },
    ])
  })

  it('offers an export for a failed run, which is the case that most needs one', async () => {
    const failed = runDetail({}, { status: 'failed' })
    const { call } = harness(failed)

    const out = await call('start_external_evaluation_export', {
      runId: 'run-1', language: 'English', session_id: 's-1', client_kind: 'claude',
    })

    expect(out.task).toMatchObject({ status: 'running' })
  })

  it('reports an unknown run by name', async () => {
    const { text } = harness(null)

    expect(await text('start_external_evaluation_export', {
      runId: 'ghost', language: 'English', session_id: 's-1', client_kind: 'claude',
    })).toBe('run not found: ghost')
  })

  it('refuses while the run is still going', async () => {
    // Mid-run there is no verdict to report, so an export would describe a run
    // that has not happened yet.
    const { text } = harness(runDetail({}, { status: 'running' }))

    expect(await text('start_external_evaluation_export', {
      runId: 'run-1', language: 'English', session_id: 's-1', client_kind: 'claude',
    })).toBe('evaluation export is available after the run finishes')
  })

  it('refuses a boot session — terminal, but nothing was tested', async () => {
    // A fresh workspace ships exactly one run: an ABORTED BOOT session with a
    // null summary. "Terminal" alone admits it, and exporting it produces a
    // plausible-looking but empty evaluation with no hint what went wrong.
    const { text } = harness(runDetail({ summary: null }, { status: 'aborted', executionType: 'boot' }))

    expect(await text('start_external_evaluation_export', {
      runId: 'run-1', language: 'English', session_id: 's-1', client_kind: 'claude',
    })).toBe('run run-1 is a boot session, not a suite run — run the suite first (start_run), then export that run')
  })

  it('refuses a benchmark run for the same reason', async () => {
    const { text } = harness(runDetail({}, { status: 'passed', executionType: 'benchmark' }))

    expect(await text('start_external_evaluation_export', {
      runId: 'run-1', language: 'English', session_id: 's-1', client_kind: 'claude',
    })).toBe('run run-1 is a benchmark session, not a suite run — run the suite first (start_run), then export that run')
  })
})

describe('submit_external_evaluation_export', () => {
  it('renders the client wording into a stored archive and completes the task', async () => {
    const taskId = await startTask()
    const { call } = harness()

    const out = await call('submit_external_evaluation_export', {
      taskId,
      rewrite: { featureTitle: 'Checkout', summary: 'One scenario passed.', cases: [CASE] },
    })

    const archivePath = evaluationExportTaskPaths(logsDir, taskId)!.zipPath
    expect(out).toMatchObject({
      taskId,
      status: 'completed',
      downloadReady: true,
      archivePath,
      reportInsideArchive: 'evaluation.html',
    })
    // The digest is what the agent relays in chat, so it carries the authored
    // wording rather than a pointer at the UI.
    expect(out.evaluation).toEqual({
      featureTitle: 'Checkout',
      summary: 'One scenario passed.',
      cases: [{ title: 'Shopper pays', confidence: 'High' }],
    })
    expect(String(out.nextSteps)).toContain('Present this evaluation to the user in chat')
    expect(String(out.nextSteps)).toContain('Give the user archivePath as the exact local file location')
    expect(String(out.nextSteps)).not.toContain('npx canary-lab export download')
    const zip = fs.readFileSync(archivePath, 'utf8')
    expect(zip).toContain('One scenario passed.')
  })

  it('falls back to the run\'s feature name when the client authored no title', async () => {
    const taskId = await startTask()
    const { call } = harness()

    const out = await call('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'One scenario passed.', cases: [CASE] },
    })

    expect((out.evaluation as { featureTitle: string }).featureTitle).toBe('checkout')
  })

  it('keeps every submitted case, in the submitted order', async () => {
    // Two declared tests, two cases: the digest must mirror them 1:1 so a client
    // can see that nothing was folded together on the way through.
    const twoTests = runDetail({
      summary: {
        complete: true, total: 2, passed: 2,
        knownTests: [{ name: 'test-case-pays', title: 'pays' }, { name: 'test-case-refunds', title: 'refunds' }],
        passedNames: ['test-case-pays', 'test-case-refunds'],
        failed: [],
      },
    })
    const taskId = await startTask(twoTests)
    const { call } = harness(twoTests)

    const out = await call('submit_external_evaluation_export', {
      taskId,
      rewrite: {
        summary: 'Both scenarios passed.',
        cases: [{ ...CASE, title: 'Shopper pays' }, { ...CASE, title: 'Shopper is refunded' }],
      },
    })

    expect((out.evaluation as { cases: Array<{ title: string }> }).cases.map((c) => c.title))
      .toEqual(['Shopper pays', 'Shopper is refunded'])
  })

  it('refuses a rewrite that dropped a case, naming the count it must match', async () => {
    const twoTests = runDetail({
      summary: {
        complete: true, total: 2, passed: 2,
        knownTests: [{ name: 'test-case-pays', title: 'pays' }, { name: 'test-case-refunds', title: 'refunds' }],
        passedNames: ['test-case-pays', 'test-case-refunds'],
        failed: [],
      },
    })
    const taskId = await startTask(twoTests)
    const { text } = harness(twoTests)

    const out = await text('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'Both scenarios passed.', cases: [CASE] },
    })

    expect(out).toContain('rewrite.cases must contain exactly 2 entries')
    expect(out).toContain('(got 1)')
    // Naming the rule matters as much as the count: a client that merges two
    // near-identical runs into one case has quietly shrunk the reported suite.
    expect(out).toContain('Do NOT merge, dedupe, or drop')
    // And a rejected submission leaves the task open rather than half-completed.
    const still = await harness(twoTests).call('get_evaluation_export', { taskId })
    expect(still).toMatchObject({ status: 'running', downloadReady: false })
    expect(fs.existsSync(evaluationExportTaskPaths(logsDir, taskId)!.zipPath)).toBe(false)
  })

  it('refuses an extra case against a one-test roster', async () => {
    const taskId = await startTask()
    const { text } = harness()

    const out = await text('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'One scenario passed.', cases: [CASE, CASE] },
    })

    expect(out).toContain('rewrite.cases must contain exactly 1 entry')
    expect(out).toContain('(got 2)')
  })

  it('applies text slots over the deterministic wording', async () => {
    const taskId = await startTask()
    const { call } = harness()

    const out = await call('submit_external_evaluation_export', {
      taskId,
      textSlots: [
        { id: 'summary', text: 'Localised summary.' },
        { id: 'cases.0.title', text: 'Pembeli membayar' },
      ],
    })

    // Slots are the count-safe route: the case list comes from the roster, so
    // only the wording the client supplied changes.
    expect(out.evaluation).toMatchObject({
      summary: 'Localised summary.',
      cases: [{ title: 'Pembeli membayar' }],
    })
  })

  it('asks for wording when the client sent neither slots nor a rewrite', async () => {
    const taskId = await startTask()
    const { text } = harness()

    expect(await text('submit_external_evaluation_export', { taskId })).toBe('submit textSlots[] or rewrite')
    expect(await text('submit_external_evaluation_export', { taskId, textSlots: [] }))
      .toBe('submit textSlots[] or rewrite')
  })

  it('exports a failed run as-is, with the failure still in the report', async () => {
    const failed = runDetail({
      summary: {
        complete: true, total: 1, passed: 0,
        knownTests: [{ name: 'test-case-pays', title: 'pays' }],
        failed: [{ name: 'test-case-pays', error: { message: 'expected 200, got 500' } }],
      },
    }, { status: 'failed' })
    const taskId = await startTask(failed)
    const { call } = harness(failed)

    const out = await call('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'One scenario failed.', cases: [CASE] },
    })

    // Nothing heals or softens first: the export is the run's verdict.
    expect(out).toMatchObject({ status: 'completed', downloadReady: true })
    const zip = fs.readFileSync(evaluationExportTaskPaths(logsDir, taskId)!.zipPath, 'utf8')
    expect(zip).toContain('expected 200, got 500')
  })

  it('reports an unknown task by name', async () => {
    const { text } = harness()

    expect(await text('submit_external_evaluation_export', { taskId: 'eval-ghost', rewrite: { summary: 's', cases: [] } }))
      .toBe('evaluation export task not found: eval-ghost')
  })

  it('refuses to submit into a task Canary Lab is authoring itself', async () => {
    // An internal task's wording comes from Canary's own render; letting a client
    // overwrite it would make the stored report untraceable to either author.
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-internal-1', runId: 'run-1', feature: 'checkout', mode: 'localized',
      producer: 'internal', status: 'running',
      createdAt: '2026-05-25T08:02:00.000Z', updatedAt: '2026-05-25T08:02:00.000Z',
      downloadReady: false, archiveBase: 'canary-lab-evaluation-checkout-run-1',
    })
    const { text } = harness()

    expect(await text('submit_external_evaluation_export', {
      taskId: 'eval-internal-1', rewrite: { summary: 's', cases: [CASE] },
    })).toBe('only external export tasks can be submitted through this tool')
  })

  it('reports a run that has gone missing since the task was created', async () => {
    const taskId = await startTask()
    const { text } = harness(null)

    expect(await text('submit_external_evaluation_export', { taskId, rewrite: { summary: 's', cases: [CASE] } }))
      .toBe('run not found: run-1')
  })

  it('reports a task deleted while the archive was being built', async () => {
    const taskId = await startTask()
    const { text } = harness()

    // The handler reads the task and enters the async archive build before it
    // yields, so by the time control is back here the submit is inside exactly
    // the window Log Cleanup can delete the task in. Driven off that guaranteed
    // suspension point rather than a timer.
    const pending = text('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'One scenario passed.', cases: [CASE] },
    })
    expect(deleteEvaluationExportTask(logsDir, taskId)).toBe(true)

    expect(await pending).toBe(`evaluation export task disappeared mid-submit: ${taskId}`)
  })

  it('reports a failed archive write instead of letting it escape', async () => {
    const taskId = await startTask()
    const taskDir = evaluationExportTaskPaths(logsDir, taskId)!.taskDir
    // A read-only task dir: the zip is a NEW file, so it cannot be created.
    fs.chmodSync(taskDir, 0o500)
    try {
      const { text } = harness()

      expect(await text('submit_external_evaluation_export', {
        taskId, rewrite: { summary: 'One scenario passed.', cases: [CASE] },
      })).toMatch(/EACCES|permission denied/i)
    } finally {
      fs.chmodSync(taskDir, 0o700)
    }
  })
})

describe('list_evaluation_exports', () => {
  it('lists tasks as a TOON table and filters to one run', async () => {
    const other = runDetail({ runId: 'run-2' }, { runId: 'run-2' })
    const completedTaskId = await startTask()
    await startTask(other)
    const { call, text } = harness()
    await call('submit_external_evaluation_export', {
      taskId: completedTaskId, rewrite: { summary: 'One scenario passed.', cases: [CASE] },
    })

    const all = decode(await text('list_evaluation_exports')) as Array<Record<string, string>>
    const scoped = decode(await text('list_evaluation_exports', { runId: 'run-2' })) as Array<Record<string, string>>

    expect(all.map((row) => row.runId).sort()).toEqual(['run-1', 'run-2'])
    expect(all.find((row) => row.taskId === completedTaskId)).toMatchObject({
      archivePath: evaluationExportTaskPaths(logsDir, completedTaskId)!.zipPath,
      reportInsideArchive: 'evaluation.html',
    })
    expect(scoped.map((row) => row.runId)).toEqual(['run-2'])
  })
})

describe('get_evaluation_export', () => {
  it('returns the stored task view', async () => {
    const taskId = await startTask()
    const { call } = harness()

    const task = await call('get_evaluation_export', { taskId })
    expect(task).toMatchObject({ taskId, runId: 'run-1', producer: 'external', status: 'running' })
    expect(task).not.toHaveProperty('archivePath')
  })

  it('returns the exact existing archive path after completion', async () => {
    const taskId = await startTask()
    const { call } = harness()
    await call('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'One scenario passed.', cases: [CASE] },
    })

    expect(await call('get_evaluation_export', { taskId })).toMatchObject({
      archivePath: evaluationExportTaskPaths(logsDir, taskId)!.zipPath,
      reportInsideArchive: 'evaluation.html',
    })
  })

  it('does not advertise an archive path after the zip was removed', async () => {
    const taskId = await startTask()
    const { call } = harness()
    await call('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'One scenario passed.', cases: [CASE] },
    })
    fs.unlinkSync(evaluationExportTaskPaths(logsDir, taskId)!.zipPath)

    expect(await call('get_evaluation_export', { taskId })).not.toHaveProperty('archivePath')
  })

  it('reports an unknown task by name', async () => {
    const { text } = harness()

    expect(await text('get_evaluation_export', { taskId: 'eval-ghost' }))
      .toBe('evaluation export task not found: eval-ghost')
  })
})

describe('download_evaluation_export', () => {
  it('returns the completed archive as base64', async () => {
    const taskId = await startTask()
    const { call } = harness()
    await call('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'One scenario passed.', cases: [CASE] },
    })

    const out = await call('download_evaluation_export', { taskId })

    expect(out.filename).toBe('canary-lab-evaluation-checkout-run-1.zip')
    expect(out).toMatchObject({
      archivePath: evaluationExportTaskPaths(logsDir, taskId)!.zipPath,
      reportInsideArchive: 'evaluation.html',
      task: {
        archivePath: evaluationExportTaskPaths(logsDir, taskId)!.zipPath,
        reportInsideArchive: 'evaluation.html',
      },
    })
    expect(Buffer.from(String(out.archiveBase64), 'base64').toString('utf8')).toContain('One scenario passed.')
  })

  it('refuses a download before the export has been submitted', async () => {
    const taskId = await startTask()
    const { text } = harness()

    expect(await text('download_evaluation_export', { taskId })).toBe('evaluation export is not ready')
  })

  it('reports an unknown task by name', async () => {
    const { text } = harness()

    expect(await text('download_evaluation_export', { taskId: 'eval-ghost' }))
      .toBe('evaluation export task not found: eval-ghost')
  })
})

describe('the behavior certificate through the export tools', () => {
  async function completed(): Promise<string> {
    const taskId = await startTask()
    await harness().call('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'One scenario passed.', cases: [CASE] },
    })
    return taskId
  }

  it('submit and get carry the digest and the path; download carries the whole file', async () => {
    const taskId = await startTask()
    const { call } = harness()
    const submitted = await call('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'One scenario passed.', cases: [CASE] },
    })
    const paths = evaluationExportTaskPaths(logsDir, taskId)!

    // The digest is what an agent relays: the sentence, the counts, the suite
    // check, what is not proven, how to re-check — never the whole predicate list.
    expect(submitted).toMatchObject({
      certificatePath: paths.certificatePath,
      certificateInsideArchive: 'certificate.json',
      checkerInsideArchive: 'verify-certificate.mjs',
      certificate: {
        format: 'canary-lab/behavior-certificate@2',
        counts: { declared: 1, passed: 1, failed: 0, skipped: 0, interrupted: 0, notRun: 0 },
        suite: { source: 'none', runStartCheck: 'unverifiable' },
        pendingSpecEdits: 'unknown',
        hints: 0,
        robustness: 'none',
      },
    })
    const digest = submitted.certificate as { statement: string; notProven: string[]; verifyOffline: string; tests?: unknown }
    expect(digest.statement).toContain('ran 1 declared test for run run-1')
    expect(digest.notProven[0]).toMatch(/^The absence of weakening/)
    expect(digest.verifyOffline).toContain('node verify-certificate.mjs certificate.json')
    expect(digest).not.toHaveProperty('tests')
    expect(String(submitted.nextSteps)).toContain('not the absence of weakening')

    const got = await call('get_evaluation_export', { taskId })
    expect(got).toMatchObject({ certificatePath: paths.certificatePath, certificate: { format: 'canary-lab/behavior-certificate@2' } })

    const downloaded = await call('download_evaluation_export', { taskId })
    const full = downloaded.certificate as BehaviorCertificate
    expect(downloaded.certificatePath).toBe(paths.certificatePath)
    expect(full.tests).toEqual([expect.objectContaining({ name: 'pays', status: 'passed', predicates: [] })])
    expect(full).toEqual(JSON.parse(fs.readFileSync(paths.certificatePath, 'utf8')))
  })

  it('submit hands the feature root to the certificate, so its claims come from the coverage ledger', async () => {
    // The claim list is the ledger's requirement ids; without featuresDir the
    // certificate can only see @req-* tags, and this roster carries none.
    const featuresDir = path.join(tmpDir, 'features')
    const docsDir = path.join(featuresDir, 'checkout', 'docs')
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(
      path.join(featuresDir, 'checkout', 'feature.config.cjs'),
      `module.exports = { config: { name: 'checkout', description: 'd', envs: ['local'], repos: [], featureDir: __dirname } }`,
    )
    fs.writeFileSync(path.join(docsDir, '_prd-summary.json'), JSON.stringify({
      requirements: [{ id: 'R1', title: 'Pays', text: 'A shopper can pay', pathTypes: ['happy'] }],
      requirementsHash: 'h1', docsHash: 'h2', generatedAt: '2026-01-01T00:00:00.000Z', sourceDocs: [],
    }))
    const detail = runDetail()
    const { call } = harness(detail, { featuresDir })
    const started = await call('start_external_evaluation_export', {
      runId: detail.runId, language: 'English', session_id: 's-1', client_kind: 'claude',
    })
    const taskId = (started.task as { taskId: string }).taskId
    const submitted = await call('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'One scenario passed.', cases: [CASE] },
    })

    expect(submitted.certificate).toMatchObject({ claims: { total: 1, noTests: 1 } })
    const full = JSON.parse(fs.readFileSync(evaluationExportTaskPaths(logsDir, taskId)!.certificatePath, 'utf8')) as BehaviorCertificate
    expect(full.claims).toEqual([expect.objectContaining({ requirement: expect.objectContaining({ id: 'R1', title: 'Pays' }), tests: [], outcome: 'no-tests' })])
  })

  it('an export built before certificates existed still reads as completed, without claiming one', async () => {
    const taskId = await completed()
    fs.unlinkSync(evaluationExportTaskPaths(logsDir, taskId)!.certificatePath)
    const { call } = harness()

    const got = await call('get_evaluation_export', { taskId })
    expect(got).toMatchObject({ status: 'completed', archivePath: evaluationExportTaskPaths(logsDir, taskId)!.zipPath })
    expect(got).not.toHaveProperty('certificate')
    expect(got).not.toHaveProperty('certificatePath')

    const downloaded = await call('download_evaluation_export', { taskId })
    expect(downloaded).not.toHaveProperty('certificate')
    expect(downloaded).not.toHaveProperty('certificatePath')
  })

  it('digest: counts every claim outcome and points the offline check at the suite dir when there is one', () => {
    const certificate = {
      format: 'canary-lab/behavior-certificate@2',
      statement: 's',
      run: { counts: { declared: 2, passed: 1, failed: 1, skipped: 0, interrupted: 0, notRun: 0 } },
      suite: { source: 'run-start-snapshot', digest: 'abc', runStartCheck: 'matches', dir: '/logs/runs/r/suite' },
      claims: [{ outcome: 'all-passed' }, { outcome: 'some-failed' }, { outcome: 'not-run' }, { outcome: 'no-tests' }, { outcome: 'all-passed' }],
      specEdits: { pending: [{}, {}] },
      hints: [{}],
      notProven: ['n1'],
    } as unknown as BehaviorCertificate

    const digest = certificateDigest(certificate, '/logs/evaluation-exports/eval-1/certificate.json')

    expect(digest).toEqual({
      format: 'canary-lab/behavior-certificate@2',
      statement: 's',
      suite: { source: 'run-start-snapshot', digest: 'abc', runStartCheck: 'matches' },
      counts: { declared: 2, passed: 1, failed: 1, skipped: 0, interrupted: 0, notRun: 0 },
      claims: { total: 5, allPassed: 2, someFailed: 1, notRun: 1, noTests: 1 },
      pendingSpecEdits: 2,
      hints: 1,
      robustness: 'none',
      notProven: ['n1'],
      verifyOffline: expect.stringContaining('node verify-certificate.mjs certificate.json --suite "/logs/runs/r/suite"'),
    })
    expect(digest.verifyOffline).toContain('/logs/evaluation-exports/eval-1/certificate.json')

    const perturbed = certificateDigest({
      ...certificate,
      robustness: { jobId: 'rj-1', status: 'done', envelope: {}, cells: { planned: 4, judged: 3, notRun: 1 }, findings: [{}, {}], unconfirmed: [{}], skipped: [{}] },
    } as unknown as BehaviorCertificate, '/c.json')
    expect(perturbed.robustness).toEqual({ jobId: 'rj-1', status: 'done', cells: { planned: 4, judged: 3, notRun: 1 }, findings: 2, unconfirmed: 1 })
  })
})

describe('delete_evaluation_export', () => {
  it('removes the task and its stored archive', async () => {
    const taskId = await startTask()
    const { call } = harness()
    await call('submit_external_evaluation_export', {
      taskId, rewrite: { summary: 'One scenario passed.', cases: [CASE] },
    })

    expect(await call('delete_evaluation_export', { taskId, confirm: true })).toEqual({ deleted: true, taskId })
    expect(fs.existsSync(evaluationExportTaskPaths(logsDir, taskId)!.taskDir)).toBe(false)
  })

  it('reports an unknown task by name', async () => {
    const { text } = harness()

    expect(await text('delete_evaluation_export', { taskId: 'eval-ghost', confirm: true }))
      .toBe('evaluation export task not found: eval-ghost')
  })

  it('gates the delete on confirm, and declares itself destructive', () => {
    const { configs } = harness()
    const config = configs.get('delete_evaluation_export')!

    // Asserted against the SCHEMA, not by calling the handler: this harness
    // invokes handlers directly, so zod never runs and every test above passes
    // `confirm: true` of its own accord. Relaxing the literal to an optional
    // boolean would therefore go unnoticed — and this tool deletes the archive a
    // run's whole evaluation lives in.
    expect(() => (config.inputSchema!.confirm as ZodTypeAny).parse(false)).toThrow()
    expect(() => (config.inputSchema!.confirm as ZodTypeAny).parse(undefined)).toThrow()
    expect((config.inputSchema!.confirm as ZodTypeAny).parse(true)).toBe(true)
    expect(config.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false })
  })
})
