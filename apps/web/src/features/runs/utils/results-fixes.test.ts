import { describe, expect, it } from 'vitest'
import { buildRunEvidence, type CaseEvidence, type EvidenceAttempt, type RunEvidence } from '@shared/run-evidence'
import type { JournalSection, ServiceLogExcerpt } from '@shared/run-detail'
import {
  evidenceKnownTests,
  stampedEvidenceLifecycleEvents,
  stampedEvidencePlaybackEvents,
} from '@shared/__fixtures__/run-evidence'
import {
  attemptLabel,
  attemptStatus,
  caseNumbers,
  excerptCaption,
  excerptGapCopy,
  focusedCaseKey,
  journalMarkdown,
  markerPosition,
  mediaGapCopy,
  missingMediaCopy,
  recoveredNote,
  resolveRunEntry,
  runEntries,
  runWideReason,
  summaryKind,
  type RunEntry,
} from './results-fixes'

const evidenceOf = (opts: { lifecycleUpTo?: number; dropEvents?: (time: string, id?: string) => boolean } = {}): RunEvidence => buildRunEvidence({
  events: stampedEvidencePlaybackEvents().filter((e) => !opts.dropEvents?.(e.time, e.test.id)),
  known: evidenceKnownTests,
  lifecycle: stampedEvidenceLifecycleEvents().slice(0, opts.lifecycleUpTo),
})
const caseOf = (evidence: RunEvidence, id: string): CaseEvidence => {
  const known = evidenceKnownTests.find((t) => t.id === id)!
  return evidence.cases.find((c) => c.name === known.name && c.location === known.location)!
}
const section = (over: Partial<JournalSection>): JournalSection => ({
  iteration: 1, timestamp: null, feature: null, run: null, outcome: null, hypothesis: null, body: '', ...over,
})

const at = (over: Partial<EvidenceAttempt>): EvidenceAttempt => ({ attemptKey: 'a', caseKey: 'c', name: 'n', title: 't', steps: [], ...over })
const caseWith = (attempts: EvidenceAttempt[], over: Partial<CaseEvidence> = {}): CaseEvidence => ({
  caseKey: 'c', name: 'n', title: 't', declared: true, attempts, latest: attempts.at(-1), cycles: [], ...over,
})
const shape = (entries: RunEntry[]) => entries.map((e) => ({ number: e.number, title: e.title, subtitle: e.subtitle, status: e.status, label: e.label, cycle: e.cycle?.cycle }))
// Execution 3 never reaches the discount test: either it is still running
// (pending) or it finished without it (not rerun).
const discountUnchecked = (pending: boolean) => caseOf(evidenceOf({
  ...(pending ? { lifecycleUpTo: 6 } : {}),
  dropEvents: (t, id) => (pending || id === 'discount') && t >= '2026-10-08T10:09:00.000Z',
}), 'discount')

describe('runEntries', () => {
  it('lists every run newest first, each under the repair that came just before it', () => {
    expect(shape(runEntries(caseOf(evidenceOf(), 'discount')))).toEqual([
      { number: 3, title: 'Repair 2', subtitle: '', status: 'passed', label: undefined, cycle: 2 },
      { number: 2, title: 'Repair 1', subtitle: '', status: 'failed', label: undefined, cycle: 1 },
      { number: 1, title: 'Initial run', subtitle: '', status: 'failed', label: undefined, cycle: undefined },
    ])
  })

  it('says a run the runner stopped mid-test was stopped, not running', () => {
    const first = at({ attemptKey: 'a1', status: 'failed', passed: false, executionIndex: 1 })
    const cut = at({ attemptKey: 'a2', executionIndex: 2, stopped: true })
    const again = at({ attemptKey: 'a3', status: 'passed', passed: true, executionIndex: 3 })
    const evidence = caseWith([first, cut, again], { cycles: [{ cycle: 1, input: first, verification: { kind: 'observed', attempt: cut } }] })
    expect(shape(runEntries(evidence))).toEqual([
      { number: 3, title: 'Run again', subtitle: '', status: 'passed', label: undefined, cycle: undefined },
      { number: 2, title: 'Repair 1', subtitle: '', status: 'pending', label: 'stopped', cycle: 1 },
      { number: 1, title: 'Initial run', subtitle: '', status: 'failed', label: undefined, cycle: undefined },
    ])
  })

  it('gives a runner retry its own entry, with no repair before it', () => {
    expect(shape(runEntries(caseOf(evidenceOf(), 'inventory'))).map(({ title, subtitle }) => ({ title, subtitle }))).toEqual([
      { title: 'Repair 1', subtitle: '' },
      { title: 'Retry 1', subtitle: '' },
      { title: 'Initial run', subtitle: '' },
    ])
  })

  it('names a retry the runner made after a repair, and a rerun no repair preceded', () => {
    const first = at({ attemptKey: 'a1', status: 'failed', passed: false, executionIndex: 1 })
    const again = at({ attemptKey: 'a2', status: 'failed', passed: false, executionIndex: 2 })
    const retried = at({ attemptKey: 'a3', status: 'passed', passed: true, executionIndex: 2, retry: 1 })
    const evidence = caseWith([first, again, retried], { cycles: [{ cycle: 1, input: first, verification: { kind: 'observed', attempt: retried } }] })
    expect(shape(runEntries(evidence)).map(({ title, subtitle }) => ({ title, subtitle }))).toEqual([
      { title: 'Repair 1', subtitle: 'retry 1' },
      { title: 'Run again', subtitle: '' },
      { title: 'Initial run', subtitle: '' },
    ])
  })

  it('names the execution only to tell apart runs that share a title', () => {
    const first = at({ attemptKey: 'a1', status: 'failed', passed: false, executionIndex: 1 })
    const second = at({ attemptKey: 'a2', status: 'failed', passed: false, executionIndex: 2 })
    const third = at({ attemptKey: 'a3', status: 'failed', passed: false, executionIndex: 3, retry: 1 })
    const fourth = at({ attemptKey: 'a4', status: 'passed', passed: true, executionIndex: 4 })
    const evidence = caseWith([first, second, third, fourth], { cycles: [{ cycle: 1, input: second, verification: { kind: 'observed', attempt: third } }] })
    expect(shape(runEntries(evidence)).map(({ title, subtitle }) => ({ title, subtitle }))).toEqual([
      { title: 'Run again', subtitle: 'execution 4' },
      { title: 'Repair 1', subtitle: 'retry 1' },
      { title: 'Run again', subtitle: 'execution 2' },
      { title: 'Initial run', subtitle: '' },
    ])
  })

  it('keeps a repair the runner has not checked on this test as an entry with no run under it', () => {
    expect(shape(runEntries(discountUnchecked(true)))[0]).toEqual({ number: 3, title: 'Repair 2', subtitle: 'waiting for the runner', status: 'pending', label: 'pending', cycle: 2 })
    expect(shape(runEntries(discountUnchecked(false)))[0]).toMatchObject({ subtitle: 'not run again', label: 'not rerun' })
    expect(runEntries(discountUnchecked(true))[0].attempt).toBeUndefined()
  })

  it('says whether a single run needed a repair, and stays quiet while it is still running', () => {
    expect(shape(runEntries(caseOf(evidenceOf(), 'home-loads')))).toEqual([
      { number: 1, title: 'Initial run', subtitle: 'no repair needed', status: 'passed', label: undefined, cycle: undefined },
    ])
    expect(runEntries(caseWith([at({ status: 'failed', passed: false, executionIndex: 1 })]))[0].subtitle).toBe('no repair ran')
    expect(runEntries(caseWith([at({ executionIndex: 4 })]))[0].subtitle).toBe('')
  })

  it('words an attempt no execution brackets the same way', () => {
    expect(runEntries(caseWith([at({ status: 'passed', passed: true })]))[0].subtitle).toBe('no repair needed')
    expect(runEntries(caseWith([at({ status: 'skipped', passed: false })]))[0].subtitle).toBe('no repair ran')
    expect(runEntries(caseWith([at({})]))[0].subtitle).toBe('')
    // Its first recorded attempt was already a runner retry.
    expect(runEntries(caseWith([at({ retry: 1, status: 'passed', passed: true })]))[0]).toMatchObject({ title: 'Initial run', subtitle: 'retry 1 · no repair needed' })
    expect(runEntries(caseWith([at({ retry: 1, status: 'failed', passed: false })]))[0].subtitle).toBe('retry 1 · no repair ran')
    expect(runEntries(caseWith([at({ status: 'failed', passed: false }), at({ attemptKey: 'b', status: 'passed', passed: true })]))[0].subtitle).toBe('')
  })

  it('shows a test that has not run as one not-run entry', () => {
    expect(shape(runEntries(caseWith([])))).toEqual([{ number: 1, title: 'Not run', subtitle: 'not in this run yet', status: 'pending', label: 'not run', cycle: undefined }])
  })
})

describe('resolveRunEntry', () => {
  const entries = runEntries(caseOf(evidenceOf(), 'discount'))

  it('follows the latest run until the reader picks one', () => {
    expect(resolveRunEntry(entries, {}).entry.number).toBe(3)
    expect(resolveRunEntry(entries, { attempt: 2 })).toEqual({ entry: entries[1] })
  })

  it('reads an older link’s cycle as the run that followed that repair', () => {
    expect(resolveRunEntry(entries, { cycle: 1 }).entry.number).toBe(2)
    expect(resolveRunEntry(entries, { cycle: 'initial' }).entry.number).toBe(1)
    // A pick wins over the link it replaced.
    expect(resolveRunEntry(entries, { attempt: 3, cycle: 1 }).entry.number).toBe(3)
  })

  it('falls back to the latest run and says what was asked for', () => {
    expect(resolveRunEntry(entries, { attempt: 9 })).toEqual({ entry: entries[0], stale: 'This test has no run 9; showing its latest run.' })
    expect(resolveRunEntry(entries, { cycle: 7 })).toEqual({ entry: entries[0], stale: 'Repair 7 did not address this test; showing its latest run.' })
  })
})

describe('summaryKind', () => {
  it('leaves the Summary tab empty only when the run has nothing to say', () => {
    const [afterRepair, , initial] = runEntries(caseOf(evidenceOf(), 'discount'))
    expect(summaryKind(afterRepair)).toBe('sections')
    expect(summaryKind(initial)).toBe('sections')
    expect(summaryKind(runEntries(discountUnchecked(true))[0])).toBe('sections')
    expect(summaryKind(runEntries(caseOf(evidenceOf(), 'home-loads'))[0])).toBe('passed-clean')
    expect(summaryKind(runEntries(caseWith([]))[0])).toBe('not-run')
    // A legacy attempt records no retry number at all: still a first-time pass.
    expect(summaryKind(runEntries(caseWith([at({ status: 'passed', passed: true })]))[0])).toBe('passed-clean')
  })

  it('tells a retry’s pass and a first run still going apart from a rerun still going', () => {
    const failed = at({ attemptKey: 'a1', status: 'failed', passed: false })
    expect(summaryKind(runEntries(caseWith([failed, at({ attemptKey: 'a2', status: 'passed', passed: true, retry: 1 })]))[0])).toBe('passed-retry')
    expect(summaryKind(runEntries(caseWith([at({})]))[0])).toBe('running-first')
    expect(summaryKind(runEntries(caseWith([failed, at({ attemptKey: 'a2' })]))[0])).toBe('sections')
  })
})

describe('recoveredNote', () => {
  it('marks a case that failed first and now passes, naming the cycle that fixed it', () => {
    expect(recoveredNote(caseOf(evidenceOf(), 'discount'))).toBe('Failed first · passed after repair 2')
    expect(recoveredNote(caseOf(evidenceOf(), 'inventory'))).toBe('Failed first · passed after repair 1')
  })

  it('leaves a first-time pass and a still-failing case unmarked', () => {
    expect(recoveredNote(caseOf(evidenceOf(), 'home-loads'))).toBeUndefined()
    expect(recoveredNote(discountUnchecked(false))).toBeUndefined()
  })

  it('names a runner retry when no repair addressed the case', () => {
    const latest = at({ attemptKey: 'b', status: 'passed', passed: true })
    expect(recoveredNote(caseWith([at({ status: 'timedOut', passed: false }), latest]))).toBe('Failed first · passed on retry')
  })

  it('marks a skip or a rerun still going that hides an earlier failure', () => {
    const failed = at({ status: 'failed', passed: false })
    const cycle = { cycle: 2, input: failed, verification: { kind: 'pending' as const } }
    expect(recoveredNote(caseWith([failed, at({ attemptKey: 'b', status: 'skipped', passed: false, executionIndex: 2 })]))).toBe('Failed first · skipped in execution 2')
    expect(recoveredNote(caseWith([failed, at({ attemptKey: 'b', status: 'skipped', passed: false })]))).toBe('Failed first · skipped')
    expect(recoveredNote(caseWith([failed, at({ attemptKey: 'b' })], { cycles: [cycle] }))).toBe('Failed first · running again after repair 2')
    expect(recoveredNote(caseWith([failed, at({ attemptKey: 'b' })]))).toBe('Failed first · running again')
    expect(recoveredNote(caseWith([at({ attemptKey: 'b', status: 'skipped', passed: false })]))).toBeUndefined()
  })
})

describe('runner wording', () => {
  it('reads a status from the runner, never from absence', () => {
    expect(attemptStatus(undefined)).toBe('pending')
    expect(attemptStatus(at({}))).toBe('testing')
    expect(attemptStatus(at({ status: 'passed', passed: true }))).toBe('passed')
    expect(attemptStatus(at({ stopped: true }))).toBe('pending')
  })

  it('labels a badge only where the status word would mislead', () => {
    expect(attemptLabel(undefined)).toBe('not run')
    expect(attemptLabel(at({ stopped: true }))).toBe('stopped')
    expect(attemptLabel(at({ status: 'passed', passed: true }))).toBeUndefined()
  })

  it('says why an attempt has no media', () => {
    expect(mediaGapCopy('not-retained')).toBe('No screenshot, video or trace was retained for this execution.')
    expect(mediaGapCopy('superseded')).toBe('Not retained: this run kept one copy per test, and a later attempt replaced it.')
    expect(mediaGapCopy('ambiguous')).toBe('Not shown: another test with the same name could own the retained copy.')
  })

  it('explains a missing screenshot or video in the terms of the suite’s policy', () => {
    expect(missingMediaCopy('screenshot', 'off', true)).toBe('Screenshots were off for this run, so Playwright kept none. Turn them on in Artifact settings to record the next run.')
    expect(missingMediaCopy('video', 'off', false)).toBe('Video recording was off for this run, so Playwright kept none. Turn it on in Artifact settings to record the next run.')
    expect(missingMediaCopy('video', 'on-first-retry', false)).toBe('Video is recorded only when Playwright retries a test, and this run was not a retry.')
    expect(missingMediaCopy('screenshot', 'only-on-failure', true)).toBe('Screenshots are kept only when a test fails, and this run passed.')
    expect(missingMediaCopy('screenshot', 'on', true)).toBe('Playwright kept no screenshot for this run.')
    expect(missingMediaCopy('video', 'retain-on-failure', false)).toBe('Playwright kept no video for this run.')
  })
})

describe('caseNumbers', () => {
  it('numbers cases against the declared roster, so a rerun keeps each id', () => {
    const evidence = evidenceOf()
    const numbers = caseNumbers(evidence.cases, evidenceKnownTests)
    expect(['discount', 'inventory', 'home-loads', 'admin-loads'].map((id) => numbers.get(caseOf(evidence, id).caseKey))).toEqual([2, 4, 3, 1])
  })

  it('falls back to recorded locations without a roster, and skips a case with none', () => {
    const evidence = evidenceOf()
    const unlocated: CaseEvidence = { caseKey: 'x', name: 'x', title: 'x', declared: false, attempts: [], cycles: [] }
    const numbers = caseNumbers([caseOf(evidence, 'discount'), unlocated], undefined)
    expect(numbers.get(caseOf(evidence, 'discount').caseKey)).toBe(1)
    expect(numbers.has('x')).toBe(false)
  })
})

describe('journal presentation', () => {
  it('rebuilds the journal oldest first with its original headings', () => {
    expect(journalMarkdown([
      section({ iteration: 2, timestamp: '2026-10-08T10:08:30.000Z', body: '\n- outcome: all_tests_passed' }),
      section({ iteration: 1, timestamp: '2026-10-08T10:04:30.000Z', body: '\n- outcome: partial' }),
      section({ iteration: null, timestamp: null, body: '\n- outcome: unknown' }),
    ])).toBe([
      '## Iteration ?\n\n- outcome: unknown',
      '## Iteration 1 — 2026-10-08T10:04:30.000Z\n\n- outcome: partial',
      '## Iteration 2 — 2026-10-08T10:08:30.000Z\n\n- outcome: all_tests_passed',
    ].join('\n\n'))
  })

  it('says why an entry is run-wide in the entry’s own terms', () => {
    expect(runWideReason(section({ failingTests: ['a', 'b'] }), 1)).toBe("This repair's entry covers 2 tests.")
    expect(runWideReason(section({ failingTests: ['a'] }), 2)).toBe('Another test shares this name, so the entry cannot single this one out.')
    expect(runWideReason(section({}), 1)).toBe('The entry does not name the tests it addressed.')
    expect(runWideReason(section({ failingTests: ['other'] }), 1)).toBe('The entry names a different test as its input.')
  })
})

describe('focusedCaseKey', () => {
  const detail = { playbackEvents: stampedEvidencePlaybackEvents(), summary: { complete: true, total: 4, passed: 4, failed: [], knownTests: evidenceKnownTests } }

  it('resolves a link to the case it names, and refuses a name two cases share', () => {
    const evidence = evidenceOf()
    expect(focusedCaseKey(detail, { name: 'test-case-applies-the-discount' })).toBe(caseOf(evidence, 'discount').caseKey)
    expect(focusedCaseKey(detail, { name: 'test-case-loads-the-page' })).toBeUndefined()
    expect(focusedCaseKey(detail, { name: 'test-case-loads-the-page', location: 'e2e/admin.spec.ts:5' })).toBe(caseOf(evidence, 'admin-loads').caseKey)
  })
})

describe('service log excerpts', () => {
  it('picks a retry’s span by its position among same-name attempts in that execution', () => {
    const evidence = evidenceOf()
    const [first, retry, rerun] = caseOf(evidence, 'inventory').attempts
    expect([first, retry, rerun].map((a) => markerPosition(a, evidence))).toEqual([{ occurrence: 0, of: 2 }, { occurrence: 1, of: 2 }, { occurrence: 0, of: 1 }])
    // Two tests share a title, so their markers share a name too.
    expect(markerPosition(caseOf(evidence, 'home-loads').attempts[0], evidence)).toEqual({ occurrence: 0, of: 2 })
    expect(markerPosition(caseOf(evidence, 'admin-loads').attempts[0], evidence)).toEqual({ occurrence: 1, of: 2 })
  })

  it('orders an attempt without a start time by its end', () => {
    const evidence = evidenceOf()
    const [first, retry] = caseOf(evidence, 'inventory').attempts
    const unstarted = { ...retry, startedAt: undefined }
    const unstamped = { ...first, startedAt: undefined, endedAt: undefined }
    const inventory = caseOf(evidence, 'inventory')
    const patched: RunEvidence = { ...evidence, cases: evidence.cases.map((c) => c === inventory ? { ...c, attempts: [unstamped, unstarted] } : c) }
    expect(markerPosition(unstarted, patched).occurrence).toBe(1)
    expect(markerPosition(unstamped, patched).occurrence).toBe(0)
  })

  const excerpt = (over: Partial<ServiceLogExcerpt>): ServiceLogExcerpt => ({ service: 'api', name: 'API', execution: 2, ...over })

  it('captions where an excerpt came from', () => {
    expect(excerptCaption(excerpt({ source: 'segment', totalLines: 900, span: { startLine: 40, endLine: 60, closed: true }, window: { firstLine: 41, lines: ['a'], truncated: false } }), 'Before this repair'))
      .toBe('Before this repair · execution 2 · lines 40–60 of 900')
    expect(excerptCaption(excerpt({ source: 'live', totalLines: 900, span: { startLine: 1, endLine: 400, closed: false }, window: { firstLine: 200, lines: ['a', 'b'], truncated: true } }), 'Test result'))
      .toBe('Test result · execution 2 · lines 1–400 of 900 · last 2 lines of this test\'s span · live log')
    expect(excerptCaption(excerpt({}), 'Initial execution')).toBe('Initial execution · execution 2')
  })

  it('says whether output was lost or never marked', () => {
    expect(excerptGapCopy([excerpt({ missing: 'not-retained' }), excerpt({ service: 'web', missing: 'not-retained' })], 2))
      .toBe("Execution 2's service output was not retained — this run was recorded before Canary kept each execution's service log.")
    expect(excerptGapCopy([excerpt({ missing: 'not-retained' }), excerpt({ service: 'web', missing: 'no-marker' })], 2))
      .toBe("No service printed this test's markers in execution 2.")
    expect(excerptGapCopy([], 3)).toBe("No service printed this test's markers in execution 3.")
  })
})
