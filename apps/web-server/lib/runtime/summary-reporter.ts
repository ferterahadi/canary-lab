import fs from 'fs'
import path from 'path'
import type {
  FullResult,
  Reporter,
  Suite,
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
import { extractTraceSummary } from './trace-enrichment'

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
  /** Repo-relative path to the curated failure-summary.md produced from this
   *  test's Playwright trace.zip. Populated in onEnd after async extraction. */
  traceSummaryFile?: string
}

interface KnownTestEntry {
  name: string
  title: string
  titlePath?: string[]
  location?: string
}

interface RunningStep {
  title: string
  category: string
  location?: string
  locations?: string[]
}

interface RunningTest {
  name: string
  location: string
  step?: RunningStep
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
  private readonly mergeExistingSummary = process.env.CANARY_LAB_TARGETED_RERUN === '1'
  private readonly initialSummary = readExistingSummary()
  private results: TestEntry[] = []
  private knownTests: KnownTestEntry[] = knownTestsFromExistingSummary(this.initialSummary)
  private sawSuiteInventory = this.knownTests.length > 0
  private runningTests = new Map<string, RunningTest>()
  private stepStacksByTest = new Map<string, RunningStep[]>()
  private failedStepLocationsByTest = new Map<string, string[]>()
  private failureCount = 0
  private lastEnrichedFailureCount = -1
  // Absolute path to the Playwright `trace.zip` attachment for each failed
  // test, keyed by the test's slug-name. Populated in `onTestEnd` from
  // `result.attachments` and consumed in `onEnd` to drive trace-summary
  // extraction (async, parallel) before the final heal-index write.
  private tracePathsByName = new Map<string, string>()

  constructor() {
    if (this.mergeExistingSummary) this.seedFromExistingSummary()
  }

  onBegin(_config: unknown, suite: Suite): void {
    this.sawSuiteInventory = true
    for (const test of suite.allTests()) this.rememberKnownTest(test)
    this.writeSummary(false)
  }

  onTestBegin(test: TestCase): void {
    const known = this.rememberKnownTest(test)
    this.failedStepLocationsByTest.delete(known.name)
    const running = {
      name: known.name,
      location: known.location ?? `${test.location.file}:${test.location.line}`,
    }
    this.stepStacksByTest.set(known.name, [])
    this.runningTests.set(known.name, running)
    this.writePlaybackEvent({
      type: 'test-begin',
      time: new Date().toISOString(),
      test: {
        name: running.name,
        title: test.title,
        location: running.location,
      },
    })
    this.writeSummary(false)
  }

  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    const name = this.rememberKnownTest(test).name
    let running = this.runningTests.get(name)
    if (!running) {
      running = {
        name,
        location: `${test.location.file}:${test.location.line}`,
      }
      this.runningTests.set(name, running)
    }
    const runningStep = stepToRunningStep(step)
    const stepStack = this.stepStacksByTest.get(name) ?? []
    stepStack.push(runningStep)
    this.stepStacksByTest.set(name, stepStack)
    this.runningTests.set(name, { ...running, step: runningStep })
    this.writePlaybackEvent({
      type: 'step-begin',
      time: new Date().toISOString(),
      test: { name, title: test.title },
      step: runningStep,
    })
    this.writeSummary(false)
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    const name = this.rememberKnownTest(test).name
    const running = this.runningTests.get(name)
    if (!running) return
    const ended = stepToRunningStep(step)
    if (ended.locations?.length && step.error) {
      this.failedStepLocationsByTest.set(name, ended.locations)
    }
    const stepStack = this.stepStacksByTest.get(name) ?? []
    const idx = findLastStepIndex(stepStack, ended)
    if (idx >= 0) stepStack.splice(idx, 1)
    this.stepStacksByTest.set(name, stepStack)
    const current = stepStack.at(-1)
    this.runningTests.set(name, current
      ? { ...running, step: current }
      : { name: running.name, location: running.location })
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
    const known = this.rememberKnownTest(test)
    const name = known.name
    this.runningTests.delete(name)
    this.stepStacksByTest.delete(name)
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
      location: known.location ?? `${test.location.file}:${test.location.line}`,
      ...(locations.length > 0 ? { locations } : {}),
      retry: result.retry,
    }
    this.results.push(entry)
    if (failed) this.failureCount++
    if (failed) {
      const tracePath = findTraceAttachmentPath(result.attachments)
      if (tracePath) this.tracePathsByName.set(name, tracePath)
    }
    this.writePlaybackEvent({
      type: 'test-end',
      time: new Date().toISOString(),
          test: {
            name,
            title: test.title,
            location: known.location ?? `${test.location.file}:${test.location.line}`,
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

  async onEnd(_result: FullResult): Promise<void> {
    this.runningTests.clear()
    this.stepStacksByTest.clear()
    this.writeSummary(true)
    this.reconcileJournalOutcome()
    if (
      this.failureCount > 0 &&
      this.failureCount !== this.lastEnrichedFailureCount &&
      process.env.CANARY_LAB_BENCHMARK_MODE !== 'baseline'
    ) {
      this.runEnrichment()
    }
    if (
      this.tracePathsByName.size > 0 &&
      process.env.CANARY_LAB_BENCHMARK_MODE !== 'baseline'
    ) {
      await this.runTraceEnrichment()
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

  /**
   * For each failed test that produced a Playwright `trace.zip`, run
   * `npx playwright trace` to extract a curated `failure-summary.md` into
   * `<runDir>/failed/<slug>/trace-extract/`. Extractions run in parallel —
   * each one is independent and bounded by an internal timeout. After all
   * settle, the heal-index is rewritten so the curated trace summary
   * appears as a bullet under each failure.
   *
   * Best-effort: a failure to extract one trace does not block the others
   * and does not throw — the file simply won't appear in the index. Service
   * log slices remain as fallback signal.
   */
  private async runTraceEnrichment(): Promise<void> {
    const runDir = path.dirname(getSummaryPath())
    const tasks: Array<Promise<{ name: string; relPath: string } | null>> = []
    for (const [name, traceZipPath] of this.tracePathsByName) {
      const outputDir = path.join(runDir, 'failed', name, 'trace-extract')
      tasks.push(
        extractTraceSummary({ traceZipPath, outputDir, testName: name })
          .then((res) => ({
            name,
            relPath: path.relative(runDir, res.summaryPath),
          }))
          .catch(() => null),
      )
    }
    const settled = await Promise.all(tasks)
    let any = false
    for (const r of settled) {
      if (!r) continue
      any = true
      const entry = this.results.find((e) => e.name === r.name)
      if (entry) entry.traceSummaryFile = r.relPath
    }
    if (!any) return
    // Rewrite the summary so `traceSummaryFile` lands on each failed entry,
    // then rebuild the heal-index so the agent sees the trace bullet.
    this.writeSummary(true)
    const parsed = enrichSummaryWithLogs()
    if (parsed?.summary.failed) {
      for (const failed of parsed.summary.failed) {
        const entry = this.results.find((e) => e.name === failed.name)
        if (entry?.traceSummaryFile) {
          failed.traceSummaryFile = entry.traceSummaryFile
        }
      }
    }
    writeHealIndex(parsed ?? undefined)
  }

  private writeSummary(complete: boolean): void {
    const passedResults = this.results.filter((r) => r.passed)
    const skippedResults = this.results.filter((r) => r.status === 'skipped')
    const includeKnownTests = this.sawSuiteInventory
    const summary = {
      complete,
      total: includeKnownTests ? this.knownTests.length : this.results.length,
      passed: passedResults.length,
      passedNames: passedResults.map((r) => r.name),
      ...(includeKnownTests ? { knownTests: this.knownTests } : {}),
      ...(skippedResults.length
        ? {
            skipped: skippedResults.length,
            skippedNames: skippedResults.map((r) => r.name),
          }
        : {}),
      ...this.runningSummaryFields(),
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
          ...(r.traceSummaryFile ? { traceSummaryFile: r.traceSummaryFile } : {}),
        })),
    }

    const finalPath = getSummaryPath()
    fs.mkdirSync(path.dirname(finalPath), { recursive: true })
    const tmpPath = `${finalPath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2) + '\n')
    fs.renameSync(tmpPath, finalPath)
  }

  private runningSummaryFields(): { running?: RunningTest; runningTests?: RunningTest[] } {
    const runningTests = [...this.runningTests.values()]
    if (runningTests.length === 0) return {}
    return {
      running: runningTests[0],
      runningTests,
    }
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

  private rememberKnownTest(test: TestCase): KnownTestEntry {
    const entry = knownTestFromTest(test)
    mergeKnownTest(this.knownTests, entry)
    return entry
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
  knownTests?: unknown
}

function isFailureResult(entry: Pick<TestEntry, 'status'>): boolean {
  return entry.status !== 'passed' && entry.status !== 'skipped'
}

// Playwright records the trace zip as an attachment with `name === 'trace'`
// and a `path` pointing at the per-test artifact dir
// (`<playwright-artifacts>/<pw-slug>/trace.zip`). The slug Playwright uses
// here is its own and doesn't match our `slugify(title)`, so we read the
// path off the attachment directly instead of reconstructing it.
function findTraceAttachmentPath(
  attachments: ReadonlyArray<{ name?: string; path?: string }> | undefined,
): string | null {
  if (!attachments) return null
  for (const a of attachments) {
    if (a?.name === 'trace' && typeof a.path === 'string' && a.path.length > 0) {
      return a.path
    }
  }
  return null
}

function knownTestFromTest(test: TestCase): KnownTestEntry {
  const titlePath = typeof test.titlePath === 'function'
    ? test.titlePath().filter((part): part is string => typeof part === 'string' && part.length > 0)
    : undefined
  return {
    name: `test-case-${slugify(test.title)}`,
    title: test.title,
    ...(titlePath && titlePath.length > 0 ? { titlePath } : {}),
    ...(test.location?.file && typeof test.location.line === 'number'
      ? { location: `${test.location.file}:${test.location.line}` }
      : {}),
  }
}

function knownTestsFromExistingSummary(summary: ExistingSummary | null): KnownTestEntry[] {
  const raw = Array.isArray(summary?.knownTests) ? summary.knownTests : []
  const out: KnownTestEntry[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as {
      name?: unknown
      title?: unknown
      titlePath?: unknown
      location?: unknown
    }
    if (typeof value.name !== 'string' || value.name.length === 0) continue
    if (typeof value.title !== 'string' || value.title.length === 0) continue
    mergeKnownTest(out, {
      name: value.name,
      title: value.title,
      ...(Array.isArray(value.titlePath)
        ? { titlePath: value.titlePath.filter((part): part is string => typeof part === 'string' && part.length > 0) }
        : {}),
      ...(typeof value.location === 'string' && value.location.length > 0 ? { location: value.location } : {}),
    })
  }
  return out
}

function mergeKnownTest(knownTests: KnownTestEntry[], entry: KnownTestEntry): void {
  const idx = knownTests.findIndex((known) => known.name === entry.name)
  if (idx < 0) {
    knownTests.push(entry)
    return
  }
  knownTests[idx] = {
    ...knownTests[idx],
    ...entry,
    titlePath: entry.titlePath && entry.titlePath.length > 0
      ? entry.titlePath
      : knownTests[idx].titlePath,
    location: entry.location ?? knownTests[idx].location,
  }
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
