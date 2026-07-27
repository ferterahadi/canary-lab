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

  it('surfaces a boot failure (service log + restart-oriented nextSteps) when no tests ran', () => {
    const runId = 'run-boot-fail'
    const runDir = runDirFor(logsDir, runId)
    const paths = buildRunPaths(runDir)
    fs.mkdirSync(runDir, { recursive: true })
    const bootFailure = {
      service: 'app',
      safeName: 'app',
      reason: 'process-exited' as const,
      detail: 'Service process exited before HTTP readiness (url=http://localhost:3000/health).',
      logPath: paths.serviceLog('app'),
    }
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
        bootFailure,
        lifecycle: {
          phase: 'waiting-for-signal',
          headline: 'Waiting for heal signal',
          updatedAt: '2026-05-25T08:01:00.000Z',
        },
      },
      // A boot failure means Playwright never ran — no summary.
      summary: undefined,
      playwrightArtifacts: [],
    }
    fs.writeFileSync(paths.manifestPath, JSON.stringify(detail.manifest))

    const context = buildExternalHealContext({ detail, logsDir, projectRoot: tmpDir })

    expect(context.bootFailure).toEqual(bootFailure)
    expect(context.failedTests).toEqual([])
    // nextSteps must steer the agent to the service log + a restart signal,
    // not the test-triage procedure.
    const nextSteps = (context.nextSteps ?? []).join('\n')
    expect(nextSteps).toContain(bootFailure.logPath)
    expect(nextSteps).toContain('restart')
    expect(nextSteps).not.toContain('failedTests[]')
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
