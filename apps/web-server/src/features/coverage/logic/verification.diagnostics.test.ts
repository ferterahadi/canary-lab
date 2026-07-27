import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FeatureConfig } from '../../../../../../shared/launcher/types'
import type { RunSummaryFailedEntry } from '../../runs/logic/run-store'
import {
  buildVerificationDiagnostics,
  createVerificationConfig,
  deriveVerificationTargets,
  getVerificationConfig,
  listVerificationConfigs,
  resolveVerificationRun,
  updateVerificationConfig,
} from './verification'

let tmpDir: string

let featureDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-verify-')))
  featureDir = path.join(tmpDir, 'features', 'checkout')
  fs.mkdirSync(featureDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function feature(): FeatureConfig {
  return {
    name: 'checkout',
    description: 'checkout',
    envs: ['local', 'production'],
    featureDir,
    repos: [
      {
        name: 'api',
        localPath: featureDir,
        startCommands: [
          {
            name: 'api-server',
            command: 'npm run dev',
            envs: ['local'],
            healthCheck: {
              local: { http: { url: 'http://localhost:4000/' } },
              production: { http: { url: 'https://api.example.com/healthz' } },
            },
          },
        ],
      },
    ],
  }
}

describe('verification diagnostics', () => {
  it('summarizes failed tests with trace extracts, artifacts, target URL mapping, and stripped raw output', () => {
    const runDir = path.join(tmpDir, 'runs', 'run-1')
    const traceDir = path.join(runDir, 'traces', 'checkout', 'trace-extract')
    fs.mkdirSync(traceDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, 'playwright.log'), `${'x'.repeat(16_010)}\x1b[31mTAIL\x1b[0m`)
    fs.writeFileSync(path.join(runDir, 'traces', 'checkout', 'summary.md'), `${'s'.repeat(8_010)} 503 from https://api.example.com/orders`)
    fs.writeFileSync(path.join(traceDir, 'network-failed.txt'), [
      'GET https://api.example.com/orders 503',
      '',
      ...Array.from({ length: 25 }, (_, idx) => `extra ${idx}`),
    ].join('\n'))
    fs.writeFileSync(path.join(traceDir, 'console-errors.txt'), 'Console exploded\n')

    const diagnostics = buildVerificationDiagnostics({
      runId: 'run-1',
      manifest: {
        runId: 'run-1',
        feature: 'checkout',
        startedAt: '2026-05-24T00:00:00.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
        verification: {
          playwrightEnvsetId: 'production',
          targetUrls: {
            api: 'https://api.example.com',
            fallback: 'https://fallback.example.com',
          },
          targets: [],
        },
      },
      summary: {
        complete: true,
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'orders fail',
            location: 'tests/orders.spec.ts:12:3',
            error: {
              message: 'Request failed with 503 at https://api.example.com/orders',
              snippet: 'status was 503',
            },
            traceSummaryFile: 'traces/checkout/summary.md',
          } as RunSummaryFailedEntry & { traceSummaryFile: string },
        ],
      },
      playwrightArtifacts: [
        {
          testName: 'orders fail',
          artifacts: [
            {
              name: 'trace.zip',
              kind: 'trace',
              path: path.join(runDir, 'trace.zip'),
              url: '/api/runs/run-1/artifacts/trace.zip',
              sizeBytes: 100,
              mtimeMs: 1,
            },
          ],
        },
      ],
    }, runDir)

    expect(diagnostics.summary).toBe('1 Playwright test failed during deployment verification.')
    expect(diagnostics.rawPlaywrightOutput).toBe(`${'x'.repeat(15_996)}TAIL`)
    expect(diagnostics.failedTests[0]).toMatchObject({
      name: 'orders fail',
      location: 'tests/orders.spec.ts:12:3',
      testFile: 'tests/orders.spec.ts',
      targetUrl: 'https://api.example.com',
      endpoint: 'https://api.example.com/orders',
      httpStatus: 503,
      errorMessage: 'Request failed with 503 at https://api.example.com/orders',
      assertionFailure: 'status was 503',
      consoleErrors: ['Console exploded'],
      artifacts: [{ name: 'trace.zip', kind: 'trace', url: '/api/runs/run-1/artifacts/trace.zip' }],
    })
    expect(diagnostics.failedTests[0].networkErrors).toHaveLength(20)
    expect(diagnostics.failedTests[0].rawPlaywrightError?.endsWith('Console exploded')).toBe(true)
  })

  it('falls back when failures have no endpoint, location, trace, artifacts, or raw output', () => {
    const runDir = path.join(tmpDir, 'runs', 'run-2')
    fs.mkdirSync(runDir, { recursive: true })

    const diagnostics = buildVerificationDiagnostics({
      runId: 'run-2',
      manifest: {
        runId: 'run-2',
        feature: 'checkout',
        startedAt: '2026-05-24T00:00:00.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
        verification: {
          playwrightEnvsetId: 'production',
          targetUrls: { fallback: 'https://fallback.example.com' },
          targets: [],
        },
      },
      summary: {
        complete: true,
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'plain failure',
            error: { message: 'Expected text to be visible' },
          },
        ],
      },
      playwrightArtifacts: [
        { testName: 'other test', artifacts: [] },
      ],
    }, runDir)

    expect(diagnostics.rawPlaywrightOutput).toBeUndefined()
    expect(diagnostics.failedTests[0]).toEqual({
      name: 'plain failure',
      targetUrl: 'https://fallback.example.com',
      errorMessage: 'Expected text to be visible',
      rawPlaywrightError: 'Expected text to be visible',
    })
  })

  it('falls back to the first target when an endpoint does not match a configured target URL', () => {
    const runDir = path.join(tmpDir, 'runs', 'run-unmatched')
    const extractDir = path.join(runDir, 'traces', 'checkout', 'trace-extract')
    fs.mkdirSync(extractDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, 'traces', 'checkout', 'summary.md'), 'GET https://other.example.com/api returned 502')

    const diagnostics = buildVerificationDiagnostics({
      runId: 'run-unmatched',
      manifest: {
        runId: 'run-unmatched',
        feature: 'checkout',
        startedAt: '2026-05-24T00:00:00.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
        verification: {
          playwrightEnvsetId: 'production',
          targetUrls: { fallback: 'https://fallback.example.com' },
          targets: [],
        },
      },
      summary: {
        complete: true,
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'unmatched endpoint',
            traceSummaryFile: 'traces/checkout/summary.md',
          } as RunSummaryFailedEntry & { traceSummaryFile: string },
        ],
      },
    }, runDir)

    expect(diagnostics.failedTests[0]).toMatchObject({
      endpoint: 'https://other.example.com/api',
      targetUrl: 'https://fallback.example.com',
      httpStatus: 502,
    })
  })

  it('omits optional diagnostic fields when a failed entry has no error details or target URLs', () => {
    const runDir = path.join(tmpDir, 'runs', 'run-empty-failure')
    fs.mkdirSync(runDir, { recursive: true })

    const diagnostics = buildVerificationDiagnostics({
      runId: 'run-empty-failure',
      manifest: {
        runId: 'run-empty-failure',
        feature: 'checkout',
        startedAt: '2026-05-24T00:00:00.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
        verification: {
          playwrightEnvsetId: 'production',
          targetUrls: {},
          targets: [],
        },
      },
      summary: {
        complete: true,
        total: 1,
        passed: 0,
        failed: [{ name: 'empty failure' }],
      },
    }, runDir)

    expect(diagnostics.failedTests).toEqual([{ name: 'empty failure' }])
  })

  it('uses the plural diagnostics summary and handles details without a summary object', () => {
    const withTwoFailures = buildVerificationDiagnostics({
      runId: 'run-two',
      manifest: {
        runId: 'run-two',
        feature: 'checkout',
        startedAt: '2026-05-24T00:00:00.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
      },
      summary: {
        complete: true,
        total: 2,
        passed: 0,
        failed: [{ name: 'one' }, { name: 'two' }],
      },
    }, path.join(tmpDir, 'missing-run-two'))
    expect(withTwoFailures.summary).toBe('2 Playwright tests failed during deployment verification.')

    const withoutSummary = buildVerificationDiagnostics({
      runId: 'run-no-summary',
      manifest: {
        runId: 'run-no-summary',
        feature: 'checkout',
        startedAt: '2026-05-24T00:00:00.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
      },
    }, path.join(tmpDir, 'missing-run-no-summary'))
    expect(withoutSummary.failedTests).toEqual([])
  })

  it('summarizes verification failures that did not record failed Playwright tests', () => {
    const diagnostics = buildVerificationDiagnostics({
      runId: 'run-3',
      manifest: {
        runId: 'run-3',
        feature: 'checkout',
        startedAt: '2026-05-24T00:00:00.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
      },
      summary: {
        complete: false,
        total: 0,
        passed: 0,
        failed: [],
      },
    }, path.join(tmpDir, 'missing-run'))

    expect(diagnostics).toMatchObject({
      summary: 'Verification failed, but no failed Playwright test was recorded.',
      targetUrls: {},
      failedTests: [],
    })
  })
})
