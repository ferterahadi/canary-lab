import fs from 'fs'
import path from 'path'
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import { getSummaryPath } from './paths'
import { enrichSummaryWithLogs, writeHealIndex } from './log-enrichment'

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

interface TestEntry {
  name: string
  passed: boolean
  error?: {
    message: string
    snippet?: string
  }
  durationMs: number
  location: string
  retry: number
}

class SummaryReporter implements Reporter {
  private results: TestEntry[] = []

  onTestEnd(test: TestCase, result: TestResult): void {
    this.results.push({
      name: `test-case-${slugify(test.title)}`,
      passed: result.status === 'passed',
      ...(result.status !== 'passed' && result.error
        ? {
            error: {
              message: (result.error.message ?? '').slice(0, 1000),
              ...(result.error.snippet
                ? { snippet: result.error.snippet.slice(0, 500) }
                : {}),
            },
          }
        : {}),
      durationMs: result.duration,
      location: `${test.location.file}:${test.location.line}`,
      retry: result.retry,
    })
    this.writeSummary(false)
    if (process.env.CANARY_LAB_BENCHMARK_MODE !== 'baseline') {
      // Cheap: extracts XML-scoped slices from svc logs + writes small files +
      // builds the markdown index. Keeps mid-run heal workflows healthy (user
      // can Ctrl+C and spawn the agent before the run finishes).
      enrichSummaryWithLogs()
      writeHealIndex()
    }
  }

  onEnd(_result: FullResult): void {
    this.writeSummary(true)
    if (process.env.CANARY_LAB_BENCHMARK_MODE !== 'baseline') {
      enrichSummaryWithLogs()
      writeHealIndex()
    }
  }

  private writeSummary(complete: boolean): void {
    const summary = {
      complete,
      total: this.results.length,
      passed: this.results.filter((r) => r.passed).length,
      failed: this.results
        .filter((r) => !r.passed)
        .map((r) => ({
          name: r.name,
          error: r.error,
          durationMs: r.durationMs,
          location: r.location,
          retry: r.retry,
        })),
    }

    const finalPath = getSummaryPath()
    fs.mkdirSync(path.dirname(finalPath), { recursive: true })
    const tmpPath = `${finalPath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2) + '\n')
    fs.renameSync(tmpPath, finalPath)
  }
}

export default SummaryReporter
