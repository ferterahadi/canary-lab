import { reconcilePlaybackCases, latestPlaybackAttempt, type PlaybackIdentity } from '../../../../../../../shared/playback-identity'
import type { RunDetail, PlaywrightPlaybackEvent } from '../../../../../../../shared/run-detail'
import { suiteDirForReading } from '../../../runs/logic/runtime/manifest'
import { missingAssertionReason, unknownAssertion } from './assertions'
import { sourceKey, specFileOf } from './ast'
import { loadSourceTests } from './source-analysis'
import { summaryEntryName } from '../../../../../../../shared/test-names'
import type { ReadableSemanticRuleConfig } from '../../../../../../../shared/readable-tests/types'
import { NOT_RUN_STATUS, RosterEntry, RunVerdicts, SourceTest, TestReviewCase, TestReviewPacket, TestStatusCounts } from './types'

/** The roster the report built before it enumerated declared tests: executed
 *  tests in playback order, then summary-only passes. */
export function legacyCaseOrder(detail: RunDetail): string[] {
  const out = playbackTests(detail.playbackEvents ?? []).map(rosterKey)
  const titles = new Set(playbackTests(detail.playbackEvents ?? []).map((test) => test.title))
  for (const passedName of detail.summary?.passedNames ?? []) {
    if ([...titles].some((title) => summaryEntryName(title) === passedName || title === passedName)) continue
    titles.add(passedName)
    out.push(rosterKey({ name: passedName }))
  }
  return out
}

export function buildTestReviewPacket(detail: RunDetail, semanticRules?: ReadableSemanticRuleConfig): TestReviewPacket {
  // Source comes from the copy the verdict executed while it exists (D9), not
  // the live dir an agent may have edited since — the report must show what ran.
  const sourceTests = loadSourceTests(suiteDirForReading(detail.manifest), semanticRules)
  const verdicts = runVerdicts(detail)
  const tests = declaredRoster(detail, playbackTests(detail.playbackEvents ?? [], detail.playbackIdentity), sourceTests).map(({ entry, attempt }) => {
    // The last attempt's position is the freshest one the run saw; the declared
    // one can predate a heal edit that moved the test.
    const location = attempt?.location ?? entry.location
    const source = location ? sourceFor({ ...entry, location }, sourceTests) : undefined
    const status = attempt?.status ?? summaryStatusFor(entry, verdicts)
    const error = verdicts.errorByName.get(entry.name) ?? attempt?.error
    return {
      name: entry.name,
      title: entry.title,
      status,
      ...(typeof attempt?.durationMs === 'number' ? { durationMs: attempt.durationMs } : {}),
      ...(location ? { location } : {}),
      ...(error ? { error } : {}),
      testBody: source?.bodySource ?? '',
      ...(source?.extracted ? { extracted: source.extracted } : {}),
      helperCalls: source?.helperCalls ?? [],
      helperDefinitions: source?.helperDefinitions ?? [],
      externalImports: source?.externalImports ?? [],
      assertions: source?.assertions.length
        ? source.assertions
        : [unknownAssertion(missingAssertionReason(status, Boolean(source)))],
    }
  })

  return {
    runId: detail.runId,
    feature: detail.manifest.feature,
    status: detail.manifest.status,
    total: detail.summary?.total ?? tests.length,
    passed: detail.summary?.passed ?? tests.filter((test) => test.status === 'passed').length,
    failed: detail.summary?.failed?.length ?? tests.filter((test) => test.status !== 'passed').length,
    startedAt: detail.manifest.startedAt,
    ...(detail.manifest.endedAt ? { endedAt: detail.manifest.endedAt } : {}),
    tests,
  }
}

/** A roster test together with the last attempt the run made at it. */
export interface RosterCase {
  entry: RosterEntry
  /** From `summary.knownTests` (the run-time inventory) rather than appended
   *  from what the run reported. */
  declared: boolean
  attempt?: PlaybackAttempt
}

/** The tests the run DECLARED, not the ones it got around to executing.
 *
 *  `summary.knownTests` is the harness's own enumeration — Playwright's reporter
 *  walks the whole suite before the first test starts — so it still lists tests
 *  a run abandoned when it stopped at the failure limit. Building the roster from
 *  playback events instead (what this used to do) silently deleted those tests
 *  from the report, which is exactly the rounding-up the evidence rules forbid:
 *  a 23-test suite that stopped after 6 reported as a 6-test suite.
 *
 *  Each attempt is folded onto the test it belongs to by name + spec file, never
 *  by line: a heal cycle may edit the spec, which moves every later test onto a
 *  new line, and the reporter mints a fresh id from that line — so within one run
 *  the same test can be recorded at two lines under two ids. Keying on the line
 *  turned the pre-fix failure into a phantom extra case ("3 passed, 1 failed" for
 *  a three-test suite that ended green). The line decides only when one file
 *  declares the same title more than once.
 *
 *  Runs recorded before the reporter emitted `knownTests` have none, so those
 *  fall back to the executed set — the old behavior, and still all the evidence
 *  that exists for them. With no inventory to count against, an attempt at a new
 *  line folds only when the current spec source declares the title exactly once
 *  in that file; otherwise the two lines stay two cases, as they always were. */
export function declaredRoster(detail: RunDetail, attempts: PlaybackAttempt[], sourceTests: Map<string, SourceTest>): RosterCase[] {
  const out: RosterCase[] = reconcilePlaybackCases(detail.summary?.knownTests ?? [], attempts, [...sourceTests.values()]).map((item) => ({
    entry: { ...item.entry, title: item.entry.title ?? item.entry.name },
    declared: item.declared,
    ...(item.attempts.length ? { attempt: latestPlaybackAttempt(item.attempts)! } : {}),
  }))
  for (const passedName of detail.summary?.passedNames ?? []) {
    // Match on name first: a roster entry and a `passedNames` entry are the same
    // test when the names agree, even though the roster's title may carry
    // annotations that no longer slugify back to it.
    if (out.some(({ entry }) => entry.name === passedName || summaryEntryName(entry.title) === passedName || entry.title === passedName)) continue
    out.push({ entry: { name: passedName, title: passedName }, declared: false })
  }
  return out
}

/** The tests the current spec source declares under this attempt's title, in
 *  the file the attempt ran from. */
function sourceDeclarations(test: { name: string; title: string }, file: string, sourceTests: Map<string, SourceTest>): SourceTest[] {
  return [...sourceTests.values()].filter((source) => (
    source.file === file && (source.title === test.title || summaryEntryName(source.title) === test.name)
  ))
}

/** The source body for a case. The recorded line is a hint, not an identity:
 *  a heal edit shifts lines, and a targeted rerun never re-lists the tests it
 *  did not run, so the exact line misses for every test that only ran before the
 *  edit. Fall back to the one test with this title in the same file. */
function sourceFor(entry: RosterEntry & { location: string }, sourceTests: Map<string, SourceTest>): SourceTest | undefined {
  const exact = sourceTests.get(sourceKey(entry.location))
  if (exact) return exact
  const byTitle = sourceDeclarations(entry, specFileOf(entry.location), sourceTests)
  return byTitle.length === 1 ? byTitle[0] : undefined
}

/** Name is summaryEntryName(title), so two tests can share one only by
 *  sharing a title — the location disambiguates them. Matches `playbackTests`. */
export function rosterKey(entry: { name: string; location?: string }): string {
  return `${entry.name}@${entry.location ? sourceKey(entry.location) : ''}`
}

export function runVerdicts(detail: RunDetail): RunVerdicts {
  const failed = detail.summary?.failed ?? []
  const errorByName = new Map<string, { message: string; snippet?: string }>()
  for (const entry of failed) if (entry.error) errorByName.set(entry.name, entry.error)
  return {
    passedIds: new Set(detail.summary?.passedIds ?? []),
    passedNames: new Set(detail.summary?.passedNames ?? []),
    skippedIds: new Set(detail.summary?.skippedIds ?? []),
    skippedNames: new Set(detail.summary?.skippedNames ?? []),
    failedIds: new Set(failed.map((entry) => entry.id).filter((id): id is string => typeof id === 'string')),
    failedNames: new Set(failed.map((entry) => entry.name)),
    errorByName,
  }
}

/** Status for a roster entry with no playback event of its own. Failed and
 *  skipped are checked before passed so a name that somehow lands in two lists
 *  resolves downward — the report never rounds a test up into a pass. */
export function summaryStatusFor(entry: RosterEntry, verdicts: RunVerdicts): string {
  if ((entry.id && verdicts.failedIds.has(entry.id)) || verdicts.failedNames.has(entry.name)) return 'failed'
  if ((entry.id && verdicts.skippedIds.has(entry.id)) || verdicts.skippedNames.has(entry.name)) return 'skipped'
  if ((entry.id && verdicts.passedIds.has(entry.id)) || verdicts.passedNames.has(entry.name)) return 'passed'
  return NOT_RUN_STATUS
}

/** Per-test breakdown, derived from each test's own recorded verdict rather than
 *  from arithmetic on the totals. `summary.failed` lumps interrupted tests in with
 *  real failures, so this is the only place the two are told apart — and unlike
 *  `total - failed` it can never turn a never-run test into a pass. */
export function testStatusCounts(tests: TestReviewCase[]): TestStatusCounts {
  const counts: TestStatusCounts = { passed: 0, failed: 0, interrupted: 0, skipped: 0, notRun: 0 }
  for (const test of tests) counts[statusBucket(test.status)] += 1
  return counts
}

export function statusBucket(status: string): keyof TestStatusCounts {
  const normalized = status.toLowerCase()
  if (normalized === 'passed') return 'passed'
  if (normalized === 'skipped') return 'skipped'
  if (normalized === NOT_RUN_STATUS) return 'notRun'
  if (normalized === 'interrupted') return 'interrupted'
  return 'failed'
}

/** The last recorded attempt at a test at one `file:line`. */
export interface PlaybackAttempt {
  caseKey?: string
  name: string
  title: string
  location: string
  status: string
  /** When the attempt's `test-end` landed — what decides which of two attempts
   *  at different lines is the later one. */
  endedAt: string
  durationMs?: number
  error?: { message: string; snippet?: string }
}

export function playbackTests(events: PlaywrightPlaybackEvent[], identity?: PlaybackIdentity): PlaybackAttempt[] {
  // One entry per (name, location). Retries and same-line reruns share both and
  // fold into the latest test-end; `declaredRoster` then folds attempts at
  // different lines of the same test. Two distinct tests that share a title
  // (and therefore a name, since name = summaryEntryName(title)) but
  // live at different locations stay separate — the HTML export disambiguates
  // them via positional anchor IDs. Map preserves first-seen insertion order.
  const latest = new Map<string, PlaybackAttempt>()
  for (const [index, event] of events.entries()) {
    if (event.type !== 'test-end') continue
    const caseKey = identity?.eventKeys.length === events.length ? identity.eventKeys[index]?.caseKey : undefined
    const key = caseKey ?? `${event.test.name}@${event.test.location}`
    const attempt: PlaybackAttempt = {
      ...(caseKey ? { caseKey } : {}),
      name: event.test.name,
      title: event.test.title,
      location: event.test.location,
      status: event.status,
      endedAt: event.time,
      durationMs: event.durationMs,
      ...(event.error ? { error: event.error } : {}),
    }
    latest.set(key, latestPlaybackAttempt([...(latest.has(key) ? [latest.get(key)!] : []), attempt])!)
  }
  return [...latest.values()]
}
