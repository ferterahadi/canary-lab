import type { RunDetail, PlaywrightPlaybackEvent } from '../../../runs/logic/run-store'
import { missingAssertionReason, unknownAssertion } from './assertions'
import { sourceKey } from './ast'
import { loadSourceTests } from './source-analysis'
import { slugFromTitle } from './text'
import { NOT_RUN_STATUS, RosterEntry, RunVerdicts, TestReviewCase, TestReviewPacket, TestStatusCounts } from './types'

/** The roster the report built before it enumerated declared tests: executed
 *  tests in playback order, then summary-only passes. */
export function legacyCaseOrder(detail: RunDetail): string[] {
  const out = playbackTests(detail.playbackEvents ?? []).map(rosterKey)
  const titles = new Set(playbackTests(detail.playbackEvents ?? []).map((test) => test.title))
  for (const passedName of detail.summary?.passedNames ?? []) {
    if ([...titles].some((title) => slugFromTitle(title) === passedName || title === passedName)) continue
    titles.add(passedName)
    out.push(rosterKey({ name: passedName }))
  }
  return out
}

export function buildTestReviewPacket(detail: RunDetail): TestReviewPacket {
  const events = detail.playbackEvents ?? []
  const sourceTests = loadSourceTests(detail.manifest.featureDir)
  const eventTests = playbackTests(events)
  const verdicts = runVerdicts(detail)
  const eventByKey = new Map(eventTests.map((eventTest) => [rosterKey(eventTest), eventTest]))
  const tests = declaredRoster(detail, eventTests).map((entry) => {
    const eventTest = eventByKey.get(rosterKey(entry))
    const source = entry.location ? sourceTests.get(sourceKey(entry.location)) : undefined
    const status = eventTest?.status ?? summaryStatusFor(entry, verdicts)
    const error = verdicts.errorByName.get(entry.name) ?? eventTest?.error
    return {
      name: entry.name,
      title: entry.title,
      status,
      ...(typeof eventTest?.durationMs === 'number' ? { durationMs: eventTest.durationMs } : {}),
      ...(entry.location ? { location: entry.location } : {}),
      ...(error ? { error } : {}),
      testBody: source?.bodySource ?? '',
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

/** The tests the run DECLARED, not the ones it got around to executing.
 *
 *  `summary.knownTests` is the harness's own enumeration — Playwright's reporter
 *  walks the whole suite before the first test starts — so it still lists tests
 *  a run abandoned when it stopped at the failure limit. Building the roster from
 *  playback events instead (what this used to do) silently deleted those tests
 *  from the report, which is exactly the rounding-up the evidence rules forbid:
 *  a 23-test suite that stopped after 6 reported as a 6-test suite.
 *
 *  Runs recorded before the reporter emitted `knownTests` have none, so those
 *  fall back to the executed set — the old behavior, and still all the evidence
 *  that exists for them. */
export function declaredRoster(detail: RunDetail, eventTests: ReturnType<typeof playbackTests>): RosterEntry[] {
  const out: RosterEntry[] = []
  const seen = new Set<string>()
  const add = (entry: RosterEntry): void => {
    const key = rosterKey(entry)
    if (seen.has(key)) return
    seen.add(key)
    out.push(entry)
  }
  for (const known of detail.summary?.knownTests ?? []) {
    add({
      ...(known.id ? { id: known.id } : {}),
      name: known.name,
      title: known.title ?? known.name,
      ...(known.location ? { location: known.location } : {}),
    })
  }
  // Append rather than replace: anything the run actually reported that the
  // roster somehow misses is evidence, and evidence is never dropped.
  for (const eventTest of eventTests) add(eventTest)
  for (const passedName of detail.summary?.passedNames ?? []) {
    // Match on name first: a roster entry and a `passedNames` entry are the same
    // test when the names agree, even though the roster's title may carry
    // annotations that no longer slugify back to it.
    if (out.some((entry) => entry.name === passedName || slugFromTitle(entry.title) === passedName || entry.title === passedName)) continue
    add({ name: passedName, title: passedName })
  }
  return out
}

/** Name is `test-case-${slugify(title)}`, so two tests can share one only by
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

export function playbackTests(events: PlaywrightPlaybackEvent[]): Array<{
  name: string
  title: string
  location: string
  status: string
  durationMs?: number
  error?: { message: string; snippet?: string }
}> {
  // One entry per (name, location). Retries and heal-cycle reruns share both
  // and fold into the latest test-end. Two distinct tests that share a title
  // (and therefore a name, since name = `test-case-${slugify(title)}`) but
  // live at different locations stay separate — the HTML export disambiguates
  // them via positional anchor IDs. Map preserves first-seen insertion order.
  const latest = new Map<string, { name: string; title: string; location: string; status: string; durationMs?: number; error?: { message: string; snippet?: string } }>()
  for (const event of events) {
    if (event.type !== 'test-end') continue
    const key = `${event.test.name}@${event.test.location}`
    latest.set(key, {
      name: event.test.name,
      title: event.test.title,
      location: event.test.location,
      status: event.status,
      durationMs: event.durationMs,
      ...(event.error ? { error: event.error } : {}),
    })
  }
  return [...latest.values()]
}
