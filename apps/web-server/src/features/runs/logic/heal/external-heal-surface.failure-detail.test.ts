import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { RunDetail } from '../../../../../../../shared/run-detail'
import {
  buildExternalFailureDetail,
  buildExternalHealContext,
  buildExternalRunSnapshot,
  buildExternalRunSnapshotSlim,
  slimRepeatHealContext,
  writeHealSignal,
} from './external-heal-surface'
import { buildRunPaths, runDirFor } from '../runtime/run-paths'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-external-surface-')

let tmpDir: string

let logsDir: string

beforeEach(() => {
  tmpDir = tempDir()
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
        headline: 'Waiting for heal signal',
        updatedAt: '2026-05-25T08:01:00.000Z',
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

  it('inlines an error.txt in full (no truncation) when within the inline budget', () => {
    // No truncation cap anymore. Write just under the 8 KB inline budget → the
    // whole file inlines, no pointer.
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    const errorDir = path.join(paths.failedDir, failedSlug)
    fs.mkdirSync(errorDir, { recursive: true })

    const content = 'x'.repeat(8 * 1024 - 1)
    fs.writeFileSync(path.join(errorDir, 'error.txt'), content)

    const detail = buildExternalFailureDetail({
      detail: detailFor(runId),
      logsDir,
      failureId: failedSlug,
    })

    expect(detail).not.toBeNull()
    // Inlined in full — never truncated, and no pointer fallback needed.
    expect(detail?.errorText).toBe(content)
    expect(detail).not.toHaveProperty('errorTextPath')
    expect(JSON.stringify(detail)).not.toContain('[truncated')
  })

  it('points to error.txt instead of inlining when it exceeds the inline budget', () => {
    // Over the 8 KB budget we POINT to the file so the agent Reads it in chunks,
    // rather than swallowing it in one tool result — text is never cut.
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    const errorDir = path.join(paths.failedDir, failedSlug)
    fs.mkdirSync(errorDir, { recursive: true })

    const errorFile = path.join(errorDir, 'error.txt')
    fs.writeFileSync(errorFile, 'x'.repeat(8 * 1024 + 1))

    const detail = buildExternalFailureDetail({
      detail: detailFor(runId),
      logsDir,
      failureId: failedSlug,
    })

    expect(detail).not.toBeNull()
    expect(detail).not.toHaveProperty('errorText')
    expect(detail?.errorTextPath).toBe(errorFile)
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

  it('returns null traceSummaryMarkdown when failure-summary.md is missing (inlineOrPointer null branch)', () => {
    // traceDir EXISTS (so inlineOrPointer is called for failure-summary.md),
    // but the file is absent → safeRead returns null → inlineOrPointer returns null.
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
    // failure-summary.md absent → inlineOrPointer returns null → not inlined.
    expect(detail).not.toHaveProperty('traceSummaryMarkdown')
    expect(detail).not.toHaveProperty('traceSummaryPath')
  })

  it('omits errorText when error.txt is absent', () => {
    // inlineOrPointer for error.txt returns null when the file does not exist,
    // so neither errorText nor errorTextPath is set.
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
    // error.txt absent → inlineOrPointer returns null → errorText not inlined.
    expect(detail).not.toHaveProperty('errorText')
    expect(detail).not.toHaveProperty('errorTextPath')
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
        lifecycle: { phase: 'waiting-for-signal', headline: 'Waiting', updatedAt: '2026-05-25T08:01:00.000Z' },
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
        lifecycle: { phase: 'waiting-for-signal', headline: 'Waiting', updatedAt: '2026-05-25T08:00:00.000Z' },
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
