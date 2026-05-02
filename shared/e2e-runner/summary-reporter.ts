import fs from 'fs'
import path from 'path'
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import { getSummaryPath } from './paths'
import { enrichSummaryWithLogs, stripAnsi, writeHealIndex } from './log-enrichment'

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
  logFiles?: string[]
}

class SummaryReporter implements Reporter {
  private results: TestEntry[] = []
  private failureCount = 0
  private lastEnrichedFailureCount = -1

  onTestEnd(test: TestCase, result: TestResult): void {
    const passed = result.status === 'passed'
    if (!passed) this.failureCount++
    this.results.push({
      name: `test-case-${slugify(test.title)}`,
      passed,
      ...(!passed && result.error
        ? {
            error: {
              message: stripAnsi(result.error.message ?? '').slice(0, 1000),
              ...(result.error.snippet
                ? { snippet: stripAnsi(result.error.snippet).slice(0, 500) }
                : {}),
            },
          }
        : {}),
      durationMs: result.duration,
      location: `${test.location.file}:${test.location.line}`,
      retry: result.retry,
    })
    this.writeSummary(false)
    // Enrich + write heal-index only when failures exist. Keeps green runs fast
    // (the enrichment passes are pure waste with nothing to heal). Mid-run
    // Ctrl+C still works — the index is regenerated on every new failure.
    if (this.failureCount > 0 && process.env.CANARY_LAB_BENCHMARK_MODE !== 'baseline') {
      this.runEnrichment()
    }
  }

  onEnd(_result: FullResult): void {
    this.writeSummary(true)
    // Skip the redundant pass when onTestEnd already enriched on this same
    // failure set. Only run if new failures arrived since the last enrich.
    if (
      this.failureCount > 0 &&
      this.failureCount !== this.lastEnrichedFailureCount &&
      process.env.CANARY_LAB_BENCHMARK_MODE !== 'baseline'
    ) {
      this.runEnrichment()
    }
  }

  private runEnrichment(): void {
    const parsed = enrichSummaryWithLogs()
    // Mirror enrichment-attached logFiles back onto in-memory results so a
    // subsequent writeSummary() (e.g. from onEnd) doesn't clobber them.
    if (parsed?.summary.failed) {
      const byName = new Map(
        parsed.summary.failed.map((f) => [f.name, f.logFiles] as const),
      )
      for (const r of this.results) {
        if (!r.passed && byName.has(r.name)) {
          r.logFiles = byName.get(r.name)
        }
      }
    }
    writeHealIndex(parsed ?? undefined)
    this.lastEnrichedFailureCount = this.failureCount
  }

  private writeSummary(complete: boolean): void {
    const summary = {
      complete,
      total: this.results.length,
      passed: this.results.filter((r) => r.passed).length,
      passedNames: this.results.filter((r) => r.passed).map((r) => r.name),
      failed: this.results
        .filter((r) => !r.passed)
        .map((r) => ({
          name: r.name,
          error: r.error,
          durationMs: r.durationMs,
          location: r.location,
          retry: r.retry,
          ...(r.logFiles ? { logFiles: r.logFiles } : {}),
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
