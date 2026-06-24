import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RunDetail } from '../run-store'
import { buildExternalFailureDetail, buildExternalHealContext, buildExternalRunSnapshot, normalizeRunCounts, slimRepeatHealContext, writeHealSignal } from './external-heal-surface'
import { buildRunPaths, runDirFor } from '../runtime/run-paths'

let tmpDir: string
let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-external-surface-')))
  logsDir = path.join(tmpDir, 'logs')
})

function detailFor(runId: string): RunDetail {
  return {
    runId,
    manifest: {
      runId,
      feature: 'checkout',
      env: 'local',
      startedAt: '2026-05-25T08:00:00.000Z',
      status: 'healing',
      healCycles: 2,
      services: [],
      repoBranches: [{ name: 'app', path: '/repo/app', branch: 'main', detached: false, dirty: false }],
      lifecycle: {
        phase: 'waiting-for-signal',
        updatedAt: '2026-05-25T08:01:00.000Z',
        message: 'Waiting for heal signal',
        severity: 'info',
      },
    },
    summary: {
      complete: false,
      total: 3,
      passed: 1,
      passedNames: ['already passed'],
      knownTests: [
        { name: 'already passed' },
        { name: 'checkout fails' },
        { name: 'not run yet' },
      ],
      failed: [
        {
          name: 'checkout fails',
          error: { message: 'boom', snippet: 'expect(x)' },
          location: 'e2e/checkout.spec.ts:12:3',
          retry: 1,
          logFiles: ['failed/checkout-fails/svc-app.log'],
          errorFile: 'failed/checkout-fails/error.txt',
        },
      ],
      skipped: 0,
    } as RunDetail['summary'] & { knownTests: Array<{ name: string }> },
    playwrightArtifacts: [
      {
        testName: 'checkout fails',
        artifacts: [
          {
            name: 'trace',
            kind: 'trace',
            path: '/tmp/trace.zip',
            url: '/api/runs/run-1/artifacts/checkout-fails/trace.zip',
            sizeBytes: 3,
            mtimeMs: 1,
          },
        ],
      },
    ],
  }
}

describe('buildExternalHealContext', () => {
  it('builds compact agent-first heal context used by MCP and HTTP routes', () => {
    const runId = 'run-1'
    const runDir = runDirFor(logsDir, runId)
    const paths = buildRunPaths(runDir)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(paths.manifestPath, JSON.stringify(detailFor(runId).manifest))
    fs.writeFileSync(paths.healIndexPath, '# Heal Index\n')
    fs.writeFileSync(paths.diagnosisJournalPath, '# Journal\n')
    // Per-failure artifact dirs so the pointer bundle resolves traceDir / playwrightMcpDir.
    const failedSlug = 'checkout fails'
    const traceDir = path.join(paths.failedDir, failedSlug, 'trace-extract')
    const pwMcpDir = path.join(paths.failedDir, failedSlug, 'playwright-mcp')
    fs.mkdirSync(traceDir, { recursive: true })
    fs.writeFileSync(path.join(traceDir, 'failure-summary.md'), '# failure\n')
    fs.mkdirSync(pwMcpDir, { recursive: true })
    fs.writeFileSync(path.join(pwMcpDir, 'console-errors.txt'), 'boom\n')

    const context = buildExternalHealContext({
      detail: detailFor(runId),
      logsDir,
      projectRoot: tmpDir,
    })

    expect(context).toMatchObject({
      runId,
      feature: 'checkout',
      env: 'local',
      status: 'healing',
      counts: { statusLine: '1/3 passed, 1 failed, 1 not run' },
      healIndex: { path: paths.healIndexPath },
      journal: { path: paths.diagnosisJournalPath },
      failedTests: [
        {
          failureId: 'checkout fails',
          name: 'checkout fails',
          error: { message: 'boom', snippet: 'expect(x)' },
          location: 'e2e/checkout.spec.ts:12:3',
          retry: 1,
          logFiles: ['failed/checkout-fails/svc-app.log'],
          errorPath: 'failed/checkout-fails/error.txt',
          traceDir,
          playwrightMcpDir: pwMcpDir,
          artifacts: [
            {
              name: 'trace',
              kind: 'trace',
              url: '/api/runs/run-1/artifacts/checkout-fails/trace.zip',
            },
          ],
        },
      ],
      healPrompt: {
        source: 'canary-lab/heal-agent-map',
      },
    })
    // Slim packet: markdown blobs are deferred to paths, never inlined in the compact context.
    expect(context.healIndex).not.toHaveProperty('markdown')
    expect(context.journal).not.toHaveProperty('markdown')
    expect(JSON.stringify(context)).not.toContain('# Heal Index')
    expect(JSON.stringify(context)).not.toContain('# Journal')
    expect(context).not.toHaveProperty('summary')
    expect(context).not.toHaveProperty('healIndexMarkdown')
    expect(context).not.toHaveProperty('journalMarkdown')
    expect(context).not.toHaveProperty('artifactsBase')
    expect(context.counts).not.toHaveProperty('notRunNames')
    expect(JSON.stringify(context)).not.toContain('not run yet')
  })

  it('keeps compact counts when normalizing duplicate title names', () => {
    const context = buildExternalHealContext({
      detail: {
        ...detailFor('run-duplicates'),
        summary: {
          complete: false,
          total: 2,
          passed: 1,
          passedNames: ['test-case-validates-input'],
          passedIds: ['test-id-a'],
          knownTests: [
            { id: 'test-id-a', name: 'test-case-validates-input' },
            { id: 'test-id-b', name: 'test-case-validates-input' },
          ],
          failed: [],
        } as any,
      },
      logsDir,
      projectRoot: tmpDir,
    })

    expect(context.counts).toMatchObject({
      totalKnown: 2,
      passed: 1,
      failed: 0,
      notRun: 1,
      statusLine: '1/2 passed, 0 failed, 1 not run',
    })
    expect(context.counts).not.toHaveProperty('notRunNames')
  })
})

describe('stuck-cycle escalation', () => {
  function seedJournal(runId: string, iterations: number, failing: string): void {
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    fs.mkdirSync(path.dirname(paths.diagnosisJournalPath), { recursive: true })
    const blocks = Array.from({ length: iterations }, (_, i) =>
      `## Iteration ${i + 1} — 2026-05-25T08:0${i}:00Z\n\n- failingTests: ${failing}\n`)
    fs.writeFileSync(paths.diagnosisJournalPath, blocks.join('\n'))
  }

  it('attaches an escalation block once the same failing set has survived 3 cycles', () => {
    // Current failing set = "checkout fails"; two prior iterations failed on the
    // same set → streak = 3 → escalation fires.
    seedJournal('run-1', 2, 'checkout fails')
    const context = buildExternalHealContext({ detail: detailFor('run-1'), logsDir, projectRoot: tmpDir })
    expect(context.escalation).toBeDefined()
    expect(context.escalation?.consecutiveSameFailures).toBe(3)
    expect(context.escalation?.failingSet).toEqual(['checkout fails'])
    expect(context.escalation?.readFirst.some((p) => p.includes('snapshot-at-failure.txt'))).toBe(true)
    expect(context.escalation?.tactics.join(' ')).toContain('signal_run')
  })

  it('omits escalation when the failing set has only repeated twice (one prior attempt)', () => {
    seedJournal('run-1', 1, 'checkout fails')
    const context = buildExternalHealContext({ detail: detailFor('run-1'), logsDir, projectRoot: tmpDir })
    expect(context.escalation).toBeUndefined()
  })

  it('omits escalation when the failing set changed (prior cycle was a different set)', () => {
    seedJournal('run-1', 2, 'some other test')
    const context = buildExternalHealContext({ detail: detailFor('run-1'), logsDir, projectRoot: tmpDir })
    expect(context.escalation).toBeUndefined()
  })

  it('slimRepeatHealContext keeps the escalation and drops the generic breadcrumb when stuck', () => {
    seedJournal('run-1', 2, 'checkout fails')
    const full = buildExternalHealContext({ detail: detailFor('run-1'), logsDir, projectRoot: tmpDir })
    const slim = slimRepeatHealContext(full)
    expect(slim.escalation).toBeDefined()
    expect(slim).not.toHaveProperty('guidance')
    expect(slim).not.toHaveProperty('healPrompt')
    expect(slim).not.toHaveProperty('nextSteps')
  })
})

describe('slimRepeatHealContext', () => {
  it('drops the static procedure + map and leaves the failure packet plus a guidance breadcrumb', () => {
    const runId = 'run-1'
    const runDir = runDirFor(logsDir, runId)
    const paths = buildRunPaths(runDir)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(paths.manifestPath, JSON.stringify(detailFor(runId).manifest))
    fs.writeFileSync(paths.healIndexPath, '# Heal Index\n')

    const full = buildExternalHealContext({ detail: detailFor(runId), logsDir, projectRoot: tmpDir })
    // Sanity: cycle-1 context carries both static blobs.
    expect(full.nextSteps?.length).toBeGreaterThan(0)
    expect(full.healPrompt).toBeDefined()

    const slim = slimRepeatHealContext(full)
    // Static guidance + map are stripped; the breadcrumb points back to get_heal_context.
    expect(slim).not.toHaveProperty('nextSteps')
    expect(slim).not.toHaveProperty('healPrompt')
    expect(slim.guidance).toContain('get_heal_context')
    // The per-cycle failure packet is preserved.
    expect(slim.failedTests).toEqual(full.failedTests)
    expect(slim.counts).toEqual(full.counts)
    expect(slim.healIndex).toEqual(full.healIndex)
  })
})

describe('buildExternalFailureDetail', () => {
  it('returns one failure with pointers plus the capped inline trace summary and error text', () => {
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    const traceDir = path.join(paths.failedDir, failedSlug, 'trace-extract')
    const pwMcpDir = path.join(paths.failedDir, failedSlug, 'playwright-mcp')
    fs.mkdirSync(traceDir, { recursive: true })
    fs.writeFileSync(path.join(traceDir, 'failure-summary.md'), '# curated\n')
    fs.mkdirSync(pwMcpDir, { recursive: true })
    fs.writeFileSync(path.join(pwMcpDir, 'console-errors.txt'), 'boom\n')
    fs.writeFileSync(path.join(paths.failedDir, failedSlug, 'error.txt'), 'AssertionError: boom\n')

    const detail = buildExternalFailureDetail({
      detail: detailFor(runId),
      logsDir,
      failureId: failedSlug,
    })

    expect(detail).toMatchObject({
      runId,
      failureId: failedSlug,
      name: failedSlug,
      location: 'e2e/checkout.spec.ts:12:3',
      errorPath: 'failed/checkout-fails/error.txt',
      traceDir,
      playwrightMcpDir: pwMcpDir,
      traceSummaryMarkdown: '# curated\n',
      errorText: 'AssertionError: boom\n',
    })
  })

  it('returns null for an unknown failureId', () => {
    expect(
      buildExternalFailureDetail({ detail: detailFor('run-1'), logsDir, failureId: 'nope' }),
    ).toBeNull()
  })

  it('truncates errorText when the error file exceeds FAILURE_DETAIL_MAX_BYTES (line 369)', () => {
    // safeReadCapped caps content at 24 * 1024 bytes. Write an error.txt that is
    // larger than that limit → the truncation path at line 369 fires.
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    const errorDir = path.join(paths.failedDir, failedSlug)
    fs.mkdirSync(errorDir, { recursive: true })

    // Write > 24 * 1024 bytes of content.
    const oversized = 'x'.repeat(24 * 1024 + 100)
    fs.writeFileSync(path.join(errorDir, 'error.txt'), oversized)

    const detail = buildExternalFailureDetail({
      detail: detailFor(runId),
      logsDir,
      failureId: failedSlug,
    })

    expect(detail).not.toBeNull()
    expect(detail?.errorText).toContain('[truncated')
    // The first 24 * 1024 bytes are preserved; the tail is replaced by the truncation suffix.
    expect(detail?.errorText?.startsWith('x'.repeat(24 * 1024))).toBe(true)
    // The oversized tail ('x'.repeat(100)) is NOT in the output (it was cut off).
    expect(detail?.errorText?.endsWith('x'.repeat(100))).toBe(false)
  })

  it('omits traceSummaryMarkdown when pointer.traceDir is null (line 216 FALSE branch)', () => {
    // No trace-extract dir created → existingDir returns null → pointer.traceDir is
    // undefined → the ternary `pointer.traceDir ? ... : null` takes the null path.
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    // Only create the error file; leave trace-extract absent entirely.
    const errorDir = path.join(paths.failedDir, failedSlug)
    fs.mkdirSync(errorDir, { recursive: true })
    fs.writeFileSync(path.join(errorDir, 'error.txt'), 'boom\n')

    const detail = buildExternalFailureDetail({
      detail: detailFor(runId),
      logsDir,
      failureId: failedSlug,
    })

    expect(detail).not.toBeNull()
    // traceDir absent → traceSummaryMarkdown not inlined.
    expect(detail).not.toHaveProperty('traceSummaryMarkdown')
    expect(detail?.traceDir).toBeUndefined()
  })

  it('omits traceSummaryMarkdown when trace-extract is a file not a dir (existingDir FALSE branch)', () => {
    // existingDir: `fs.statSync(dir).isDirectory()` returns false when the path is a
    // file → returns null → pointer.traceDir is undefined → no traceSummaryMarkdown.
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    const errorDir = path.join(paths.failedDir, failedSlug)
    fs.mkdirSync(errorDir, { recursive: true })
    // Write a FILE at the path that existingDir expects to be a directory.
    fs.writeFileSync(path.join(errorDir, 'trace-extract'), 'not-a-dir\n')
    fs.writeFileSync(path.join(errorDir, 'error.txt'), 'boom\n')

    const detail = buildExternalFailureDetail({
      detail: detailFor(runId),
      logsDir,
      failureId: failedSlug,
    })

    expect(detail).not.toBeNull()
    expect(detail?.traceDir).toBeUndefined()
  })

  it('omits playwrightMcpDir when playwright-mcp is an empty dir (nonEmptyDir FALSE branch)', () => {
    // nonEmptyDir: `fs.readdirSync(dir).length > 0` is false for an empty dir → returns
    // null → pointer.playwrightMcpDir is undefined.
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    const errorDir = path.join(paths.failedDir, failedSlug)
    // Create an EMPTY playwright-mcp dir — no files inside.
    const pwMcpDir = path.join(errorDir, 'playwright-mcp')
    fs.mkdirSync(pwMcpDir, { recursive: true })
    fs.writeFileSync(path.join(errorDir, 'error.txt'), 'boom\n')

    const detail = buildExternalFailureDetail({
      detail: detailFor(runId),
      logsDir,
      failureId: failedSlug,
    })

    expect(detail).not.toBeNull()
    expect(detail?.playwrightMcpDir).toBeUndefined()
  })

  it('returns null traceSummaryMarkdown when failure-summary.md is missing (safeReadCapped null branch, line 367)', () => {
    // traceDir EXISTS (so line 216 takes the TRUE ternary branch and calls safeReadCapped),
    // but failure-summary.md is absent → safeRead returns null → line 367 TRUE fires.
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    const errorDir = path.join(paths.failedDir, failedSlug)
    // Create a NON-EMPTY trace-extract dir but WITHOUT failure-summary.md.
    const traceDir = path.join(errorDir, 'trace-extract')
    fs.mkdirSync(traceDir, { recursive: true })
    fs.writeFileSync(path.join(traceDir, 'other-file.txt'), 'not-summary\n') // keeps dir non-empty
    fs.writeFileSync(path.join(errorDir, 'error.txt'), 'boom\n')

    const detail = buildExternalFailureDetail({
      detail: detailFor(runId),
      logsDir,
      failureId: failedSlug,
    })

    expect(detail).not.toBeNull()
    expect(detail?.traceDir).toBe(traceDir)
    // failure-summary.md absent → safeReadCapped returns null → not inlined.
    expect(detail).not.toHaveProperty('traceSummaryMarkdown')
  })

  it('omits errorText when error.txt is absent (line 228 FALSE branch)', () => {
    // safeReadCapped for error.txt returns null when the file does not exist.
    // Line 228: `...(errorText !== null ? { errorText } : {})` → FALSE branch.
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    // Create the failure dir but leave error.txt absent entirely.
    const errorDir = path.join(paths.failedDir, failedSlug)
    fs.mkdirSync(errorDir, { recursive: true })

    const detail = buildExternalFailureDetail({
      detail: detailFor(runId),
      logsDir,
      failureId: failedSlug,
    })

    expect(detail).not.toBeNull()
    // error.txt absent → safeReadCapped returns null → errorText not inlined.
    expect(detail).not.toHaveProperty('errorText')
  })

  it('omits errorPath and falls back to empty artifacts when entry fields are absent (lines 192/196 FALSE branches)', () => {
    // Line 192: `...(entry.errorFile ? { errorPath: entry.errorFile } : {})` → FALSE when no errorFile.
    // Line 196: `playwrightArtifacts?.find(...)` → `?? []` when playwrightArtifacts is undefined.
    const runId = 'run-2'
    const detail: RunDetail = {
      runId,
      manifest: {
        runId,
        feature: 'checkout',
        env: 'local',
        startedAt: '2026-05-25T08:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        repoBranches: [],
        lifecycle: { phase: 'waiting-for-signal', updatedAt: '2026-05-25T08:01:00.000Z', message: 'Waiting', severity: 'info' },
      },
      summary: {
        complete: false,
        total: 1,
        passed: 0,
        // failed entry has NO errorFile and NO logFiles — exercises the FALSE branches.
        failed: [{ name: 'checkout fails', error: { message: 'boom', snippet: '' }, location: 'e2e/a.ts:1:1', retry: 0 }],
      },
      // playwrightArtifacts is undefined → the `?? []` fallback (line 196 FALSE branch).
      playwrightArtifacts: undefined,
    }

    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    const errorDir = path.join(paths.failedDir, failedSlug)
    fs.mkdirSync(errorDir, { recursive: true })
    fs.writeFileSync(path.join(errorDir, 'error.txt'), 'boom\n')

    const result = buildExternalFailureDetail({ detail, logsDir, failureId: failedSlug })

    expect(result).not.toBeNull()
    // No errorFile on the entry → errorPath is absent.
    expect(result).not.toHaveProperty('errorPath')
    // playwrightArtifacts is undefined → artifacts falls back to [].
    expect(result?.artifacts).toEqual([])
  })

  it('falls back to empty failed list when summary is absent (line 216 FALSE branch)', () => {
    // Line 216: `(detail.summary?.failed ?? []).find(...)` — when detail.summary is undefined,
    // `detail.summary?.failed` is undefined → the `?? []` branch fires → find returns undefined → null.
    const runId = 'run-3'
    const detail: RunDetail = {
      runId,
      manifest: {
        runId,
        feature: 'checkout',
        env: 'local',
        startedAt: '2026-05-25T08:00:00.000Z',
        status: 'healing',
        healCycles: 0,
        services: [],
        repoBranches: [],
        lifecycle: { phase: 'waiting-for-signal', updatedAt: '2026-05-25T08:00:00.000Z', message: 'Waiting', severity: 'info' },
      },
      // summary is undefined → detail.summary?.failed is undefined → ?? [] fires.
      summary: undefined,
      playwrightArtifacts: undefined,
    }

    const result = buildExternalFailureDetail({ detail, logsDir, failureId: 'any-failure' })

    // summary is undefined → failed list is [] → find returns undefined → result is null.
    expect(result).toBeNull()
  })
})

describe('buildExternalRunSnapshot', () => {
  it('preserves the full external heal snapshot shape for debugging fallback', () => {
    const runId = 'run-1'
    const runDir = runDirFor(logsDir, runId)
    const paths = buildRunPaths(runDir)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(paths.manifestPath, JSON.stringify(detailFor(runId).manifest))
    fs.writeFileSync(paths.healIndexPath, '# Heal Index\n')
    fs.writeFileSync(paths.diagnosisJournalPath, '# Journal\n')

    const snapshot = buildExternalRunSnapshot({
      detail: detailFor(runId),
      logsDir,
      projectRoot: tmpDir,
    })

    expect(snapshot).toMatchObject({
      runId,
      feature: 'checkout',
      summary: {
        knownTests: [
          { name: 'already passed' },
          { name: 'checkout fails' },
          { name: 'not run yet' },
        ],
      },
      counts: {
        notRunNames: ['not run yet'],
        statusLine: '1/3 passed, 1 failed, 1 not run',
      },
      healIndexMarkdown: '# Heal Index\n',
      journalMarkdown: '# Journal\n',
      artifactsBase: '/api/runs/run-1/artifacts/',
      healPrompt: {
        source: 'canary-lab/heal-agent-map',
      },
    })
  })
})

describe('normalizeRunCounts', () => {
  it('returns zero counts and an empty status line when the summary is null', () => {
    const counts = normalizeRunCounts(null)
    expect(counts).toMatchObject({
      totalKnown: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      notRun: 0,
      statusLine: '0/0 passed, 0 failed, 0 not run',
    })
  })

  it('skips malformed knownTests entries (non-objects, missing names, non-string names)', () => {
    const summary = {
      complete: false,
      total: 1,
      passed: 1,
      passedNames: ['real test'],
      knownTests: [
        null,
        'not-an-object',
        42,
        { id: 'orphan' }, // missing name → dropped
        { id: 'wrong-name-type', name: 123 }, // non-string name → coerced to '' then dropped
        { name: '' }, // empty name → dropped
        { name: 'real test' },
      ],
      failed: [],
      skipped: 0,
    } as unknown as RunDetail['summary']

    const counts = normalizeRunCounts(summary)
    expect(counts.totalKnown).toBe(1)
    expect(counts.passed).toBe(1)
    expect(counts.notRun).toBe(0)
    expect(counts.notRunNames).toEqual([])
  })

  it('includes a skipped segment in the status line when any tests are skipped', () => {
    const summary = {
      complete: false,
      total: 3,
      passed: 1,
      passedNames: ['a'],
      knownTests: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      failed: [],
      skipped: 1,
      skippedNames: ['b'],
    } as unknown as RunDetail['summary']

    const counts = normalizeRunCounts(summary)
    expect(counts.skipped).toBe(1)
    expect(counts.statusLine).toBe('1/3 passed, 0 failed, 1 skipped, 1 not run')
  })

  it('treats non-finite fallback totals as zero', () => {
    const counts = normalizeRunCounts({
      complete: false,
      total: Number.NaN,
      passed: 0,
      failed: [],
      skipped: 0,
    })

    expect(counts.totalKnown).toBe(0)
    expect(counts.statusLine).toBe('0/0 passed, 0 failed, 0 not run')
  })

  it('uses numeric fallback totals when known tests are absent', () => {
    const counts = normalizeRunCounts({
      complete: false,
      total: 4,
      passed: 1,
      failed: [{ name: 'failed test' }],
      skipped: 1,
    })

    expect(counts.totalKnown).toBe(4)
    expect(counts.notRun).toBe(1)
    expect(counts.statusLine).toBe('1/4 passed, 1 failed, 1 skipped, 1 not run')
  })
})

describe('writeHealSignal', () => {
  it('writes restart, rerun, and heal signal files through one helper', () => {
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))

    expect(writeHealSignal({ logsDir, runId, kind: 'restart', body: { reason: 'restart' } })).toEqual({
      kind: 'restart',
      path: paths.restartSignal,
    })
    expect(writeHealSignal({ logsDir, runId, kind: 'rerun', body: { reason: 'rerun' } })).toEqual({
      kind: 'rerun',
      path: paths.rerunSignal,
    })
    expect(writeHealSignal({ logsDir, runId, kind: 'heal', body: { reason: 'heal' } })).toEqual({
      kind: 'heal',
      path: paths.healSignal,
    })

    expect(fs.readFileSync(paths.restartSignal, 'utf-8')).toBe(JSON.stringify({ reason: 'restart' }))
    expect(fs.readFileSync(paths.rerunSignal, 'utf-8')).toBe(JSON.stringify({ reason: 'rerun' }))
    expect(fs.readFileSync(paths.healSignal, 'utf-8')).toBe(JSON.stringify({ reason: 'heal' }))
  })
})
