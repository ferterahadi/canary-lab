import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RunDetail } from '../run-store'
import { buildExternalFailureDetail, buildExternalHealContext, buildExternalRunSnapshot, buildExternalRunSnapshotSlim, normalizeRunCounts, slimRepeatHealContext, writeHealSignal } from './external-heal-surface'
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

describe('buildExternalRunSnapshotSlim — null healIndex/journal branches (lines 252-253)', () => {
  it('returns null healIndex and null journal when heal-index and journal files are absent', () => {
    // healIndexMarkdown = null (no file) → healIndex: null
    // journalMarkdown = null (no file) → journal: null
    const runId = 'run-slim'
    const runDir = runDirFor(logsDir, runId)
    const paths = buildRunPaths(runDir)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(paths.manifestPath, JSON.stringify(detailFor(runId).manifest))
    // Do NOT write healIndexPath or diagnosisJournalPath → both markdown fields are null

    const slim = buildExternalRunSnapshotSlim({ detail: detailFor(runId), logsDir, projectRoot: tmpDir })
    expect(slim.healIndex).toBeNull()
    expect(slim.journal).toBeNull()
  })
})

describe('buildExternalFailureDetail — pointer branches (line 348)', () => {
  it('sets errorTextPath (not errorText) when error.txt exceeds the inline threshold', () => {
    // inlineOrPointer returns { path } when file > FAILURE_DETAIL_INLINE_MAX_BYTES (8KB).
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    const errorDir = path.join(paths.failedDir, failedSlug)
    fs.mkdirSync(errorDir, { recursive: true })
    // Write error.txt > 8KB to trigger the pointer branch.
    fs.writeFileSync(path.join(errorDir, 'error.txt'), 'x'.repeat(9 * 1024))

    const detail = buildExternalFailureDetail({
      detail: detailFor(runId),
      logsDir,
      failureId: failedSlug,
    })

    expect(detail).not.toBeNull()
    expect(detail).not.toHaveProperty('errorText')
    expect(detail).toHaveProperty('errorTextPath')
  })

  it('sets traceSummaryPath (not traceSummaryMarkdown) when failure-summary.md exceeds the inline threshold', () => {
    // inlineOrPointer returns { path } when failure-summary.md > 8KB.
    const runId = 'run-1'
    const paths = buildRunPaths(runDirFor(logsDir, runId))
    const failedSlug = 'checkout fails'
    const errorDir = path.join(paths.failedDir, failedSlug)
    const traceDir = path.join(errorDir, 'trace-extract')
    fs.mkdirSync(traceDir, { recursive: true })
    // Write failure-summary.md > 8KB so inlineOrPointer returns { path }.
    fs.writeFileSync(path.join(traceDir, 'failure-summary.md'), '# Summary\n' + 'x'.repeat(9 * 1024))
    fs.writeFileSync(path.join(errorDir, 'error.txt'), 'err\n')

    const detail = buildExternalFailureDetail({
      detail: detailFor(runId),
      logsDir,
      failureId: failedSlug,
    })

    expect(detail).not.toBeNull()
    expect(detail).not.toHaveProperty('traceSummaryMarkdown')
    expect(detail).toHaveProperty('traceSummaryPath')
  })
})
