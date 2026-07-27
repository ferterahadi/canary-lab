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
import { classifyJournalOutcome, enrichSummaryWithLogs, stripAnsi, updateLatestPendingJournalOutcome, writeHealIndex } from './log-enrichment'
import { getSummaryPath } from './paths'
import { extractTraceSummary } from './trace-enrichment'
import { ExistingSummary, KnownTestEntry, idForExistingResult, knownTestFromTest, knownTestsFromExistingSummary, mergeKnownTest, readExistingSummary, stringAt } from './summary-known-tests'
import { failureLocations, findLastStepIndex, findTraceAttachmentPath, isErrorShape, isFailureResult, journalPathForSummary, runIdForSummary, stepToRunningStep } from './summary-locations'
import type { PlaybackEvent, RunningStep, RunningTest, TestEntry } from './summary-types'

export { slugify } from './summary-types'
export type { RunningStep, TestEntry } from './summary-types'

export { testIdFor } from './summary-known-tests'

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
    this.failedStepLocationsByTest.delete(known.id)
    const running = {
      id: known.id,
      name: known.name,
      location: known.location ?? `${test.location.file}:${test.location.line}`,
    }
    this.stepStacksByTest.set(known.id, [])
    this.runningTests.set(known.id, running)
    this.writePlaybackEvent({
      type: 'test-begin',
      time: new Date().toISOString(),
      test: {
        id: known.id,
        name: running.name,
        title: test.title,
        location: running.location,
      },
    })
    this.writeSummary(false)
  }

  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    const known = this.rememberKnownTest(test)
    let running = this.runningTests.get(known.id)
    if (!running) {
      running = {
        id: known.id,
        name: known.name,
        location: `${test.location.file}:${test.location.line}`,
      }
      this.runningTests.set(known.id, running)
    }
    const runningStep = stepToRunningStep(step)
    const stepStack = this.stepStacksByTest.get(known.id) ?? []
    stepStack.push(runningStep)
    this.stepStacksByTest.set(known.id, stepStack)
    this.runningTests.set(known.id, { ...running, step: runningStep })
    this.writePlaybackEvent({
      type: 'step-begin',
      time: new Date().toISOString(),
      test: { id: known.id, name: known.name, title: test.title },
      step: runningStep,
    })
    this.writeSummary(false)
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    const known = this.rememberKnownTest(test)
    const running = this.runningTests.get(known.id)
    if (!running) return
    const ended = stepToRunningStep(step)
    if (step.error && ended.locations) {
      this.failedStepLocationsByTest.set(known.id, ended.locations)
    }
    const stepStack = this.stepStacksByTest.get(known.id)!
    const idx = findLastStepIndex(stepStack, ended)
    if (idx >= 0) stepStack.splice(idx, 1)
    this.stepStacksByTest.set(known.id, stepStack)
    const current = stepStack.at(-1)
    this.runningTests.set(known.id, current
      ? { ...running, step: current }
      : { id: running.id, name: running.name, location: running.location })
    this.writePlaybackEvent({
      type: 'step-end',
      time: new Date().toISOString(),
      test: { id: known.id, name: known.name, title: test.title },
      step: ended,
    })
    this.writeSummary(false)
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const passed = result.status === 'passed'
    const failed = result.status !== 'passed' && result.status !== 'skipped'
    const known = this.rememberKnownTest(test)
    const name = known.name
    this.runningTests.delete(known.id)
    this.stepStacksByTest.delete(known.id)
    this.removeResult(known.id, name)
    // Heal-facing copy: full, untrimmed. The agent needs the complete
    // assertion diff / stack to diagnose, so the summary entry carries it all
    // (and enrichment writes it to `failed/<slug>/error.txt` with a pointer).
    const error = !passed && result.error
      ? {
          message: stripAnsi(result.error.message ?? ''),
          ...(result.error.snippet
            ? { snippet: stripAnsi(result.error.snippet) }
            : {}),
        }
      : undefined
    // Playback (UI replay) keeps a bounded copy so playback.jsonl stays small;
    // the heal path never reads it, so trimming here loses nothing for healing.
    const playbackError = error
      ? {
          message: error.message.slice(0, 1000),
          ...(error.snippet ? { snippet: error.snippet.slice(0, 500) } : {}),
        }
      : undefined
    const locations = failed
      ? failureLocations(result, this.failedStepLocationsByTest.get(known.id))
      : []
    const entry: TestEntry = {
      id: known.id,
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
            id: known.id,
            name,
            title: test.title,
            location: known.location ?? `${test.location.file}:${test.location.line}`,
          },
      status: result.status,
      passed,
      durationMs: result.duration,
      retry: result.retry,
      ...(playbackError ? { error: playbackError } : {}),
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
        parsed.summary.failed.map((f) => [f.name, { logFiles: f.logFiles, errorFile: f.errorFile }] as const),
      )
      for (const r of this.results) {
        if (isFailureResult(r) && byName.has(r.name)) {
          const enriched = byName.get(r.name)!
          r.logFiles = enriched.logFiles
          r.errorFile = enriched.errorFile
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
      const entry = this.results.find((e) => e.name === r.name)!
      entry.traceSummaryFile = r.relPath
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
    const passedIds = passedResults.flatMap((r) => r.id ? [r.id] : [])
    const skippedIds = skippedResults.flatMap((r) => r.id ? [r.id] : [])
    const includeKnownTests = this.sawSuiteInventory
    const summary = {
      complete,
      total: includeKnownTests ? this.knownTests.length : this.results.length,
      passed: passedResults.length,
      passedNames: passedResults.map((r) => r.name),
      ...(passedIds.length ? { passedIds } : {}),
      ...(includeKnownTests ? { knownTests: this.knownTests } : {}),
      ...(skippedResults.length
        ? {
            skipped: skippedResults.length,
            skippedNames: skippedResults.map((r) => r.name),
            ...(skippedIds.length ? { skippedIds } : {}),
          }
        : {}),
      ...this.runningSummaryFields(),
      failed: this.results
        .filter(isFailureResult)
        .map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          name: r.name,
          ...(r.error ? { error: r.error } : {}),
          ...(typeof r.durationMs === 'number' ? { durationMs: r.durationMs } : {}),
          ...(typeof r.location === 'string' ? { location: r.location } : {}),
          ...(r.locations?.length ? { locations: r.locations } : {}),
          ...(typeof r.retry === 'number' ? { retry: r.retry } : {}),
          ...(r.logFiles ? { logFiles: r.logFiles } : {}),
          ...(r.errorFile ? { errorFile: r.errorFile } : {}),
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
    const passedIds = Array.isArray(parsed.passedIds) ? parsed.passedIds : []
    for (const [index, name] of passedNames.entries()) {
      if (typeof name !== 'string' || !name) continue
      const id = stringAt(passedIds, index) ?? idForExistingResult({ name, knownTests: this.knownTests })
      const key = id ?? name
      if (seen.has(key)) continue
      seen.add(key)
      this.results.push({ ...(id ? { id } : {}), name, status: 'passed', passed: true })
    }

    const skippedNames = Array.isArray(parsed.skippedNames) ? parsed.skippedNames : []
    const skippedIds = Array.isArray(parsed.skippedIds) ? parsed.skippedIds : []
    for (const [index, name] of skippedNames.entries()) {
      if (typeof name !== 'string' || !name) continue
      const id = stringAt(skippedIds, index) ?? idForExistingResult({ name, knownTests: this.knownTests })
      const key = id ?? name
      if (seen.has(key)) continue
      seen.add(key)
      this.results.push({ ...(id ? { id } : {}), name, status: 'skipped', passed: false })
    }

    const failed = Array.isArray(parsed.failed) ? parsed.failed : []
    for (const entry of failed) {
      if (!entry || typeof entry !== 'object') continue
      const name = typeof entry.name === 'string' ? entry.name : ''
      if (!name) continue
      const id = typeof entry.id === 'string'
        ? entry.id
        : idForExistingResult({
            name,
            knownTests: this.knownTests,
            location: typeof entry.location === 'string' ? entry.location : undefined,
          })
      const key = id ?? name
      if (seen.has(key)) continue
      seen.add(key)
      this.results.push({
        ...(id ? { id } : {}),
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
    const merged = mergeKnownTest(this.knownTests, entry)
    if (merged.previousId && merged.previousId !== entry.id) {
      for (const result of this.results) {
        if (result.id === merged.previousId) result.id = entry.id
      }
    }
    return entry
  }

  private removeResult(id: string, name: string): void {
    let idx = this.results.findIndex((r) => r.id === id)
    if (idx < 0) {
      // Legacy fallback: a prior summary may have been loaded with results
      // that predated id tagging — match by name when no id is recorded.
      idx = this.results.findIndex((r) => r.name === name && !r.id)
    }
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

export default SummaryReporter
