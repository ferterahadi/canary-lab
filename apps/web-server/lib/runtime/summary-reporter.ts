import fs from 'fs'
import path from 'path'
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter'
import {
  classifyJournalOutcome,
  enrichSummaryWithLogs,
  stripAnsi,
  updateLatestPendingJournalOutcome,
  writeHealIndex,
  type SummaryForJournalOutcome,
} from './log-enrichment'
import { getSummaryPath } from './paths'

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

interface TestEntry {
  name: string
  status: string
  passed: boolean
  error?: {
    message: string
    snippet?: string
  }
  durationMs?: number
  location?: string
  locations?: string[]
  retry?: number
  logFiles?: string[]
}

interface RunningStep {
  title: string
  category: string
  location?: string
  locations?: string[]
}

type PlaybackEvent =
  | {
      type: 'test-begin'
      time: string
      test: { name: string; title: string; location: string }
    }
  | {
      type: 'step-begin' | 'step-end'
      time: string
      test: { name: string; title: string }
      step: RunningStep
    }
  | {
      type: 'test-end'
      time: string
      test: { name: string; title: string; location: string }
      status: string
      passed: boolean
      durationMs: number
      retry: number
      error?: { message: string; snippet?: string }
      attachments?: Array<{ name: string; contentType?: string; path?: string }>
    }

class SummaryReporter implements Reporter {
  private results: TestEntry[] = []
  private running: { name: string; location: string; step?: RunningStep } | null = null
  private stepStack: RunningStep[] = []
  private failedStepLocationsByTest = new Map<string, string[]>()
  private failureCount = 0
  private lastEnrichedFailureCount = -1
  private readonly mergeExistingSummary = process.env.CANARY_LAB_TARGETED_RERUN === '1'
  private readonly initialSummary = readExistingSummary()

  constructor() {
    if (this.mergeExistingSummary) this.seedFromExistingSummary()
  }

  onTestBegin(test: TestCase): void {
    this.stepStack = []
    this.failedStepLocationsByTest.delete(`test-case-${slugify(test.title)}`)
    this.running = {
      name: `test-case-${slugify(test.title)}`,
      location: `${test.location.file}:${test.location.line}`,
    }
    this.writePlaybackEvent({
      type: 'test-begin',
      time: new Date().toISOString(),
      test: {
        name: this.running.name,
        title: test.title,
        location: this.running.location,
      },
    })
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
    this.writePlaybackEvent({
      type: 'step-begin',
      time: new Date().toISOString(),
      test: { name, title: test.title },
      step: runningStep,
    })
    this.writeSummary(false)
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    const name = `test-case-${slugify(test.title)}`
    if (!this.running || this.running.name !== name) return
    const ended = stepToRunningStep(step)
    if (ended.locations?.length && step.error) {
      this.failedStepLocationsByTest.set(name, ended.locations)
    }
    const idx = findLastStepIndex(this.stepStack, ended)
    if (idx >= 0) this.stepStack.splice(idx, 1)
    const current = this.stepStack.at(-1)
    this.running = current
      ? { ...this.running, step: current }
      : { name: this.running.name, location: this.running.location }
    this.writePlaybackEvent({
      type: 'step-end',
      time: new Date().toISOString(),
      test: { name, title: test.title },
      step: ended,
    })
    this.writeSummary(false)
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const passed = result.status === 'passed'
    const failed = result.status !== 'passed' && result.status !== 'skipped'
    const name = `test-case-${slugify(test.title)}`
    if (this.running?.name === name) {
      this.running = null
      this.stepStack = []
    }
    this.removeResult(name)
    const error = !passed && result.error
      ? {
          message: stripAnsi(result.error.message ?? '').slice(0, 1000),
          ...(result.error.snippet
            ? { snippet: stripAnsi(result.error.snippet).slice(0, 500) }
            : {}),
        }
      : undefined
    const locations = failed
      ? failureLocations(result, this.failedStepLocationsByTest.get(name))
      : []
    const entry: TestEntry = {
      name,
      status: result.status,
      passed,
      ...(error ? { error } : {}),
      durationMs: result.duration,
      location: `${test.location.file}:${test.location.line}`,
      ...(locations.length > 0 ? { locations } : {}),
      retry: result.retry,
    }
    this.results.push(entry)
    if (failed) this.failureCount++
    this.writePlaybackEvent({
      type: 'test-end',
      time: new Date().toISOString(),
      test: {
        name,
        title: test.title,
        location: `${test.location.file}:${test.location.line}`,
      },
      status: result.status,
      passed,
      durationMs: result.duration,
      retry: result.retry,
      ...(error ? { error } : {}),
      ...(result.attachments?.length
        ? {
            attachments: result.attachments.map((a) => ({
              name: a.name,
              ...(a.contentType ? { contentType: a.contentType } : {}),
              ...(a.path ? { path: a.path } : {}),
            })),
          }
        : {}),
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
    this.reconcileJournalOutcome()
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
        if (isFailureResult(r) && byName.has(r.name)) {
          r.logFiles = byName.get(r.name)
        }
      }
    }
    writeHealIndex(parsed ?? undefined)
    this.lastEnrichedFailureCount = this.failureCount
  }

  private writeSummary(complete: boolean): void {
    const passedResults = this.results.filter((r) => r.passed)
    const skippedResults = this.results.filter((r) => r.status === 'skipped')
    const summary = {
      complete,
      total: this.results.length,
      passed: passedResults.length,
      passedNames: passedResults.map((r) => r.name),
      ...(skippedResults.length
        ? {
            skipped: skippedResults.length,
            skippedNames: skippedResults.map((r) => r.name),
          }
        : {}),
      ...(this.running ? { running: this.running } : {}),
      failed: this.results
        .filter(isFailureResult)
        .map((r) => ({
          name: r.name,
          ...(r.error ? { error: r.error } : {}),
          ...(typeof r.durationMs === 'number' ? { durationMs: r.durationMs } : {}),
          ...(typeof r.location === 'string' ? { location: r.location } : {}),
          ...(r.locations?.length ? { locations: r.locations } : {}),
          ...(typeof r.retry === 'number' ? { retry: r.retry } : {}),
          ...(r.logFiles ? { logFiles: r.logFiles } : {}),
        })),
    }

    const finalPath = getSummaryPath()
    fs.mkdirSync(path.dirname(finalPath), { recursive: true })
    const tmpPath = `${finalPath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2) + '\n')
    fs.renameSync(tmpPath, finalPath)
  }

  private seedFromExistingSummary(): void {
    let parsed: ExistingSummary
    try {
      parsed = JSON.parse(fs.readFileSync(getSummaryPath(), 'utf-8')) as ExistingSummary
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return

    const seen = new Set<string>()
    const passedNames = Array.isArray(parsed.passedNames) ? parsed.passedNames : []
    for (const name of passedNames) {
      if (typeof name !== 'string' || !name || seen.has(name)) continue
      seen.add(name)
      this.results.push({ name, status: 'passed', passed: true })
    }

    const skippedNames = Array.isArray(parsed.skippedNames) ? parsed.skippedNames : []
    for (const name of skippedNames) {
      if (typeof name !== 'string' || !name || seen.has(name)) continue
      seen.add(name)
      this.results.push({ name, status: 'skipped', passed: false })
    }

    const failed = Array.isArray(parsed.failed) ? parsed.failed : []
    for (const entry of failed) {
      if (!entry || typeof entry !== 'object') continue
      const name = typeof entry.name === 'string' ? entry.name : ''
      if (!name || seen.has(name)) continue
      seen.add(name)
      this.results.push({
        name,
        status: 'failed',
        passed: false,
        ...(isErrorShape(entry.error) ? { error: entry.error } : {}),
        ...(typeof entry.durationMs === 'number' ? { durationMs: entry.durationMs } : {}),
        ...(typeof entry.location === 'string' ? { location: entry.location } : {}),
        ...(Array.isArray(entry.locations) ? { locations: entry.locations.filter((f: unknown): f is string => typeof f === 'string') } : {}),
        ...(typeof entry.retry === 'number' ? { retry: entry.retry } : {}),
        ...(Array.isArray(entry.logFiles) ? { logFiles: entry.logFiles.filter((f: unknown): f is string => typeof f === 'string') } : {}),
      })
    }
    this.failureCount = this.results.filter(isFailureResult).length
    this.lastEnrichedFailureCount = this.failureCount
  }

  private removeResult(name: string): void {
    const idx = this.results.findIndex((r) => r.name === name)
    if (idx < 0) return
    const [removed] = this.results.splice(idx, 1)
    if (removed && isFailureResult(removed)) this.failureCount = Math.max(0, this.failureCount - 1)
  }

  private writePlaybackEvent(event: PlaybackEvent): void {
    const summaryPath = getSummaryPath()
    const eventPath = path.join(path.dirname(summaryPath), 'playwright-events.jsonl')
    fs.mkdirSync(path.dirname(eventPath), { recursive: true })
    fs.appendFileSync(eventPath, JSON.stringify(event) + '\n')
  }

  private reconcileJournalOutcome(): void {
    const finalSummary = readExistingSummary()
    if (!finalSummary) return
    try {
      updateLatestPendingJournalOutcome({
        journalPath: journalPathForSummary(),
        runId: runIdForSummary(),
        outcome: classifyJournalOutcome(this.initialSummary ?? { failed: [] }, finalSummary),
      })
    } catch {
      // Summary writing is the reporter's primary job; journal outcome
      // reconciliation is best-effort when the file is absent or mid-edit.
    }
  }
}

interface ExistingSummary {
  passedNames?: unknown
  skippedNames?: unknown
  failed?: unknown
}

function isFailureResult(entry: Pick<TestEntry, 'status'>): boolean {
  return entry.status !== 'passed' && entry.status !== 'skipped'
}

function readExistingSummary(): (ExistingSummary & SummaryForJournalOutcome) | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSummaryPath(), 'utf-8')) as ExistingSummary & SummaryForJournalOutcome
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function journalPathForSummary(): string {
  return path.join(path.dirname(getSummaryPath()), 'diagnosis-journal.md')
}

function runIdForSummary(): string | undefined {
  const manifestPath = process.env.CANARY_LAB_MANIFEST_PATH
    ?? path.join(path.dirname(getSummaryPath()), 'manifest.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { runId?: unknown }
    return typeof parsed.runId === 'string' ? parsed.runId : undefined
  } catch {
    return undefined
  }
}

function isErrorShape(value: unknown): value is { message: string; snippet?: string } {
  if (!value || typeof value !== 'object') return false
  const err = value as { message?: unknown; snippet?: unknown }
  return typeof err.message === 'string' && (err.snippet === undefined || typeof err.snippet === 'string')
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

function failureLocations(result: TestResult, failedStepLocations?: string[]): string[] {
  const out: string[] = []
  const add = (location: string | undefined) => {
    const normalized = normalizeLocation(location)
    if (!normalized || out.includes(normalized)) return
    out.push(normalized)
  }
  const addLocation = (location: { file: string; line: number } | undefined) => {
    if (!location) return
    add(`${location.file}:${location.line}`)
  }

  addLocation(result.error?.location)
  for (const error of result.errors ?? []) {
    addLocation(error.location)
    for (const location of stackLocations(error.stack)) add(location)
  }
  for (const location of failedStepLocations ?? []) add(location)
  return out
}

function stackLocations(stack: string | undefined): string[] {
  if (!stack) return []
  const out: string[] = []
  const locationRe = /(?:\(|\s)(\/[^():\n]+:\d+(?::\d+)?)(?:\)|\s|$)/g
  for (const match of stack.matchAll(locationRe)) {
    const location = match[1]
    if (!out.includes(location)) out.push(location)
  }
  return out
}

function normalizeLocation(location: string | undefined): string | null {
  if (!location) return null
  const match = location.match(/^(\/[^:\n]+:\d+)(?::\d+)?$/)
  return match ? match[1] : location
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
