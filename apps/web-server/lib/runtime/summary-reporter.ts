import fs from 'fs'
import path from 'path'
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter'
import { enrichSummaryWithLogs, stripAnsi, writeHealIndex } from './log-enrichment'
import { getSummaryPath } from './paths'

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

interface RunningStep {
  title: string
  category: string
  location?: string
  locations?: string[]
}

class SummaryReporter implements Reporter {
  private results: TestEntry[] = []
  private running: { name: string; location: string; step?: RunningStep } | null = null
  private stepStack: RunningStep[] = []
  private failureCount = 0
  private lastEnrichedFailureCount = -1

  onTestBegin(test: TestCase): void {
    this.stepStack = []
    this.running = {
      name: `test-case-${slugify(test.title)}`,
      location: `${test.location.file}:${test.location.line}`,
    }
    this.writeSummary(false)
  }

  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    const name = `test-case-${slugify(test.title)}`
    if (!this.running || this.running.name !== name) {
      this.running = {
        name,
        location: `${test.location.file}:${test.location.line}`,
      }
    }
    const runningStep = stepToRunningStep(step)
    this.stepStack.push(runningStep)
    this.running = { ...this.running, step: runningStep }
    this.writeSummary(false)
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    const name = `test-case-${slugify(test.title)}`
    if (!this.running || this.running.name !== name) return
    const ended = stepToRunningStep(step)
    const idx = findLastStepIndex(this.stepStack, ended)
    if (idx >= 0) this.stepStack.splice(idx, 1)
    const current = this.stepStack.at(-1)
    this.running = current
      ? { ...this.running, step: current }
      : { name: this.running.name, location: this.running.location }
    this.writeSummary(false)
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const passed = result.status === 'passed'
    const name = `test-case-${slugify(test.title)}`
    if (this.running?.name === name) {
      this.running = null
      this.stepStack = []
    }
    if (!passed) this.failureCount++
    this.results.push({
      name,
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

    if (this.failureCount > 0 && process.env.CANARY_LAB_BENCHMARK_MODE !== 'baseline') {
      this.runEnrichment()
    }
  }

  onEnd(_result: FullResult): void {
    this.running = null
    this.stepStack = []
    this.writeSummary(true)
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
      ...(this.running ? { running: this.running } : {}),
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

function stepToRunningStep(step: TestStep): RunningStep {
  const locations = stepLocationChain(step)
  return {
    title: step.title,
    category: step.category,
    ...(step.location ? { location: `${step.location.file}:${step.location.line}` } : {}),
    ...(locations.length > 0 ? { locations } : {}),
  }
}

function stepLocationChain(step: TestStep): string[] {
  const chain: string[] = []
  let cur: TestStep | undefined = step
  while (cur) {
    if (cur.location) chain.push(`${cur.location.file}:${cur.location.line}`)
    cur = cur.parent
  }
  return chain
}

function findLastStepIndex(steps: RunningStep[], target: RunningStep): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    if (
      s.title === target.title &&
      s.category === target.category &&
      s.location === target.location
    ) {
      return i
    }
  }
  return -1
}

export default SummaryReporter
