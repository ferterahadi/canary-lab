import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RunDetail } from './run-store'
import { buildExternalHealContext, normalizeRunCounts, writeHealSignal } from './external-heal-surface'
import { buildRunPaths, runDirFor } from './runtime/run-paths'

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
  it('builds the shared heal context used by MCP and HTTP routes', () => {
    const runId = 'run-1'
    const runDir = runDirFor(logsDir, runId)
    const paths = buildRunPaths(runDir)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(paths.manifestPath, JSON.stringify(detailFor(runId).manifest))
    fs.writeFileSync(paths.healIndexPath, '# Heal Index\n')
    fs.writeFileSync(paths.diagnosisJournalPath, '# Journal\n')

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
      healIndexMarkdown: '# Heal Index\n',
      journalMarkdown: '# Journal\n',
      artifactsBase: '/api/runs/run-1/artifacts/',
      failedTests: [
        {
          name: 'checkout fails',
          error: { message: 'boom', snippet: 'expect(x)' },
          location: 'e2e/checkout.spec.ts:12:3',
          retry: 1,
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
  })

  it('normalizes counts from the run summary instead of duplicate title names', () => {
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
