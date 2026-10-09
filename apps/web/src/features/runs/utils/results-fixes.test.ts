import { describe, expect, it } from 'vitest'
import { buildRunEvidence, type CaseEvidence, type EvidenceAttempt, type RunEvidence } from '@shared/run-evidence'
import type { JournalSection } from '@shared/run-detail'
import {
  evidenceKnownTests,
  stampedEvidenceLifecycleEvents,
  stampedEvidencePlaybackEvents,
} from '@shared/__fixtures__/run-evidence'
import {
  attemptStatus,
  caseNumbers,
  cycleOptions,
  focusedCaseKey,
  journalMarkdown,
  mediaGapCopy,
  resolveCycleChoice,
  runWideReason,
  selectedResult,
  verificationOutcome,
  verificationSummary,
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

describe('cycle selection', () => {
  it('lists the latest cycle first with the runner outcome, then the initial execution', () => {
    expect(cycleOptions(caseOf(evidenceOf(), 'discount'))).toEqual([
      { value: 2, label: 'Repair cycle 2 — Passed (latest)' },
      { value: 1, label: 'Repair cycle 1 — Failed' },
      { value: 'initial', label: 'Initial execution — Failed' },
    ])
  })

  it('offers no selector for a case no repair addressed', () => {
    expect(cycleOptions(caseOf(evidenceOf(), 'home-loads'))).toEqual([])
  })

  it('names a pending and a not-rerun cycle without inventing a result', () => {
    const pending = caseOf(evidenceOf({ lifecycleUpTo: 6, dropEvents: (t) => t >= '2026-10-08T10:09:00.000Z' }), 'discount')
    expect(cycleOptions(pending)[0].label).toBe('Repair cycle 2 — Verification pending (latest)')
    const skipped = caseOf(evidenceOf({ dropEvents: (t, id) => id === 'discount' && t >= '2026-10-08T10:09:00.000Z' }), 'discount')
    expect(cycleOptions(skipped)[0].label).toBe('Repair cycle 2 — Not rerun (latest)')
  })

  it('follows the latest cycle unless an explicit choice the case still offers was made', () => {
    const discount = caseOf(evidenceOf(), 'discount')
    expect(resolveCycleChoice(discount, undefined)).toBe(2)
    expect(resolveCycleChoice(discount, 1)).toBe(1)
    expect(resolveCycleChoice(discount, 'initial')).toBe('initial')
    // A stale routed cycle the case never had falls back to latest.
    expect(resolveCycleChoice(discount, 7)).toBe(2)
    expect(resolveCycleChoice(caseOf(evidenceOf(), 'home-loads'), undefined)).toBe('initial')
  })
})

describe('selectedResult', () => {
  it('pairs a cycle’s failed input with the attempt the runner observed after it', () => {
    const discount = caseOf(evidenceOf(), 'discount')
    const second = selectedResult(discount, 2)
    expect(second.cycle?.cycle).toBe(2)
    expect(second.before).toMatchObject({ executionIndex: 2, passed: false })
    expect(second.after).toMatchObject({ executionIndex: 3, passed: true })
    expect(selectedResult(discount, 'initial')).toEqual({ before: discount.initial })
  })

  it('shows no after attempt while verification is pending', () => {
    const pending = caseOf(evidenceOf({ lifecycleUpTo: 6, dropEvents: (t) => t >= '2026-10-08T10:09:00.000Z' }), 'discount')
    expect(selectedResult(pending, 2).after).toBeUndefined()
  })

  it('shows an unrepaired case’s latest result, and nothing for a case that never ran', () => {
    const home = caseOf(evidenceOf(), 'home-loads')
    expect(selectedResult(home, 'initial')).toEqual({ before: home.latest })
    const notRun: CaseEvidence = { caseKey: 'k', name: 'n', title: 't', declared: true, attempts: [], cycles: [] }
    expect(selectedResult(notRun, 'initial')).toEqual({})
  })
})

describe('runner wording', () => {
  const attempt = (over: Partial<EvidenceAttempt>): EvidenceAttempt => ({ attemptKey: 'a', caseKey: 'c', name: 'n', title: 't', steps: [], ...over })

  it('reads a status from the runner, never from absence', () => {
    expect(attemptStatus(undefined)).toBe('pending')
    expect(attemptStatus(attempt({}))).toBe('testing')
    expect(attemptStatus(attempt({ status: 'passed', passed: true }))).toBe('passed')
  })

  it('summarises every verification outcome', () => {
    const latest = attempt({ status: 'failed', passed: false, executionIndex: 2 })
    expect(verificationSummary({ kind: 'observed', attempt: attempt({ status: 'passed', passed: true, executionIndex: 3 }) }, latest))
      .toBe('Passed in execution 3 — the assertion held after this repair.')
    expect(verificationSummary({ kind: 'observed', attempt: attempt({ status: 'failed', passed: false, executionIndex: 2 }) }, latest))
      .toBe('Failed in execution 2 — the assertion still did not hold after this repair.')
    expect(verificationSummary({ kind: 'observed', attempt: attempt({ status: 'timedOut', passed: false }) }, latest))
      .toBe('Timeout — the assertion still did not hold after this repair.')
    expect(verificationSummary({ kind: 'observed', attempt: attempt({ executionIndex: 3 }) }, latest)).toBe('Running in execution 3.')
    expect(verificationSummary({ kind: 'not-rerun', execution: 3 }, latest))
      .toBe('Execution 3 ran after this repair without this test, so nothing re-observed it. The latest recorded result is still failed from execution 2.')
    expect(verificationSummary({ kind: 'pending', execution: 3 }, latest)).toBe('Execution 3 is running and has not reached this test yet.')
    expect(verificationSummary({ kind: 'pending' }, attempt({ status: 'failed', passed: false })))
      .toBe('No execution has run since this repair. The latest recorded result is still failed.')
    expect(verificationOutcome({ kind: 'observed', attempt: attempt({ status: 'skipped' }) })).toBe('Skipped')
  })

  it('says why an attempt has no media', () => {
    expect(mediaGapCopy({ kind: 'none', reason: 'pending' })).toBe('Media is saved when this execution finishes.')
    expect(mediaGapCopy({ kind: 'none', reason: 'not-retained' })).toBe('No screenshot, video or trace was retained for this execution.')
    expect(mediaGapCopy({ kind: 'none', reason: 'superseded' })).toBe('Not retained: this run kept one copy per test, and a later attempt replaced it.')
    expect(mediaGapCopy({ kind: 'none', reason: 'ambiguous' })).toBe('Not shown: another test with the same name could own the retained copy.')
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
    expect(runWideReason(section({ failingTests: ['a', 'b'] }), 1)).toBe('This cycle entry covers 2 tests.')
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
