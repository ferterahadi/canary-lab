// What a test's Results & Fixes accordion shows for the reader's selection.
//
// Pure presentation over the shared run-evidence projection: which cycles a
// case offers, which one is rendered, and the plain words for runner outcomes
// and media gaps. Verdicts stay the runner's — nothing here decides a pass.
import { mediaForAttempt, type AttemptMedia, type CaseCycle, type CaseEvidence, type CycleVerification, type EvidenceAttempt, type RunEvidence } from '@shared/run-evidence'
import type { JournalSection, PlaywrightArtifactGroup, RunDetail, RunSummary, ServiceLogExcerpt } from '@shared/run-detail'
import type { PlaybackCaseEntry } from '@shared/playback-identity'
import { buildTestNumbering, parseLocation, testNumberKey } from '@/shared/test-numbering'
import { playbackFocusCase, playbackTests } from './run-detail-playback'
import { statusFromPlaybackResult, statusLabel, type StepStatus } from './test-step-status'

/** A run-wide repair-cycle number, or the case's first recorded execution. */
export type CycleChoice = number | 'initial'

export interface CycleOption { value: CycleChoice; label: string }

/** The reader's place in Results & Fixes. `cycle` absent = follow the case's
 *  latest cycle, so a new cycle advances the view; a number or `'initial'` is
 *  an explicit pick that a later cycle never replaces. `test` names the open
 *  case the way a link does (the key is in-memory only), and `journal` is the
 *  repair notes' open source dialog. */
export interface ResultsSelection {
  caseKey: string | null
  test?: { name: string; id?: string; location?: string }
  cycle?: CycleChoice
  journal?: 'entry' | 'all'
}

/** An attempt that has not ended reads as running; no attempt at all is the
 *  roster's not-run case, never a pass. */
export function attemptStatus(attempt: EvidenceAttempt | undefined): StepStatus {
  return attempt ? statusFromPlaybackResult(attempt) : 'pending'
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function verificationOutcome(verification: CycleVerification): string {
  if (verification.kind === 'observed') return sentenceCase(statusLabel(attemptStatus(verification.attempt)))
  return verification.kind === 'pending' ? 'Verification pending' : 'Not rerun'
}

/** Latest cycle first, then the initial execution. Empty when the case never
 *  entered a repair, so no selector is drawn for it. */
export function cycleOptions(evidence: CaseEvidence): CycleOption[] {
  if (evidence.cycles.length === 0) return []
  const cycles = [...evidence.cycles].reverse().map((cycle, i): CycleOption => ({
    value: cycle.cycle,
    label: `Repair cycle ${cycle.cycle} — ${verificationOutcome(cycle.verification)}${i === 0 ? ' (latest)' : ''}`,
  }))
  return [...cycles, { value: 'initial', label: `Initial execution — ${sentenceCase(statusLabel(attemptStatus(evidence.initial)))}` }]
}

/** The choice to render: an explicit pick the case still offers, else its
 *  latest cycle, else its initial execution. */
export function resolveCycleChoice(evidence: CaseEvidence, requested: CycleChoice | undefined): CycleChoice {
  if (requested === 'initial') return requested
  if (requested !== undefined && evidence.cycles.some((c) => c.cycle === requested)) return requested
  return evidence.cycles.at(-1)?.cycle ?? 'initial'
}

export interface SelectedResult {
  /** Absent outside a repair cycle. */
  cycle?: CaseCycle
  /** The failed input of a cycle; the initial execution's attempt for a
   *  repaired case; the latest result for a case no repair addressed — its
   *  first result would hide a later regression. */
  before?: EvidenceAttempt
  /** Only an attempt the runner observed after the repair — never borrowed. */
  after?: EvidenceAttempt
}

export function selectedResult(evidence: CaseEvidence, choice: CycleChoice): SelectedResult {
  const cycle = choice === 'initial' ? undefined : evidence.cycles.find((c) => c.cycle === choice)
  if (!cycle) {
    const shown = evidence.cycles.length > 0 ? evidence.initial : evidence.latest
    return shown ? { before: shown } : {}
  }
  return {
    cycle,
    before: cycle.input,
    ...(cycle.verification.kind === 'observed' ? { after: cycle.verification.attempt } : {}),
  }
}

/** The runner's word on a repair, in a sentence. The not-rerun and pending
 *  cases name the result that still stands, so nothing reads as re-observed. */
export function verificationSummary(verification: CycleVerification, latest: EvidenceAttempt | undefined): string {
  const standing = `The latest recorded result is still ${statusLabel(attemptStatus(latest))}${latest?.executionIndex !== undefined ? ` from execution ${latest.executionIndex}` : ''}.`
  if (verification.kind === 'observed') {
    const status = attemptStatus(verification.attempt)
    const where = verification.attempt.executionIndex !== undefined ? ` in execution ${verification.attempt.executionIndex}` : ''
    if (status === 'passed') return `Passed${where} — the assertion held after this repair.`
    if (status === 'testing') return `Running${where}.`
    return `${sentenceCase(statusLabel(status))}${where} — the assertion still did not hold after this repair.`
  }
  if (verification.kind === 'not-rerun') return `Execution ${verification.execution} ran after this repair without this test, so nothing re-observed it. ${standing}`
  if (verification.execution !== undefined) return `Execution ${verification.execution} is running and has not reached this test yet.`
  return `No execution has run since this repair. ${standing}`
}

/** Why an attempt has no media to show. */
export function mediaGapCopy(media: Extract<AttemptMedia, { kind: 'none' }>): string {
  switch (media.reason) {
    case 'pending': return 'Media is saved when this execution finishes.'
    case 'not-retained': return 'No screenshot, video or trace was retained for this execution.'
    case 'superseded': return 'Not retained: this run kept one copy per test, and a later attempt replaced it.'
    case 'ambiguous': return 'Not shown: another test with the same name could own the retained copy.'
  }
}

/** The stable `#n` per case, numbered against the run's full declared roster
 *  so a targeted rerun keeps each test's id — the Tests column's numbering. */
export function caseNumbers(cases: readonly CaseEvidence[], known: RunSummary['knownTests']): Map<string, number> {
  const locate = (location: string | undefined) => parseLocation(location)
  const declared = (known ?? []).map((t) => locate(t.location)).filter((p) => p !== null)
  const source = declared.length > 0 ? declared : cases.map((c) => locate(c.location ?? c.latest?.location)).filter((p) => p !== null)
  const numbering = buildTestNumbering(source)
  const out = new Map<string, number>()
  for (const c of cases) {
    const at = locate(c.location ?? c.latest?.location)
    const n = at ? numbering.get(testNumberKey(at.file, at.line)) : undefined
    if (n !== undefined) out.set(c.caseKey, n)
  }
  return out
}

/** The journal as `diagnosis-journal.md` holds it, oldest entry first, for the
 *  Full run journal view. Sections arrive newest first from the live reader. */
export function journalMarkdown(sections: readonly JournalSection[]): string {
  const order = (s: JournalSection) => s.iteration ?? 0
  return [...sections]
    .sort((a, b) => order(a) - order(b))
    .map((s) => `## Iteration ${s.iteration ?? '?'}${s.timestamp ? ` — ${s.timestamp}` : ''}\n${s.body}`)
    .join('\n\n')
}

/** Why a cycle's journal entry is labelled run-wide for this case, in the
 *  entry's own terms — never a claim that the diagnosis was this test's. */
export function runWideReason(section: JournalSection, sameNameCases: number): string {
  const listed = section.failingTests?.length ?? 0
  if (listed > 1) return `This cycle entry covers ${listed} tests.`
  if (sameNameCases > 1) return 'Another test shares this name, so the entry cannot single this one out.'
  if (listed === 0) return 'The entry does not name the tests it addressed.'
  return 'The entry names a different test as its input.'
}

/** The case a routed or clicked test points at, by the same identity rules the
 *  Tests column uses. Undefined until the run has recorded that case, or when
 *  the target cannot be told apart from another case. */
export function focusedCaseKey(detail: Pick<RunDetail, 'playbackEvents' | 'playbackIdentity' | 'summary'>, target: PlaybackCaseEntry): string | undefined {
  const known = detail.summary?.knownTests
  return playbackFocusCase(playbackTests(detail.playbackEvents, detail.playbackIdentity, known), target, known)
}

/** Which same-name span in its execution's service log belongs to this
 *  attempt, and how many attempts share that name there. The log-marker
 *  fixture marks every attempt — retries, and tests that share a title — under
 *  one summary name, in the order they ran. */
export function markerPosition(attempt: EvidenceAttempt, evidence: RunEvidence): { occurrence: number; of: number } {
  const when = (a: EvidenceAttempt) => a.startedAt ?? a.endedAt ?? ''
  const sharing = evidence.cases
    .flatMap((c) => c.attempts)
    .filter((a) => a.name === attempt.name && a.executionIndex === attempt.executionIndex)
    .sort((a, b) => when(a).localeCompare(when(b)))
  return { occurrence: sharing.findIndex((a) => a.attemptKey === attempt.attemptKey), of: sharing.length }
}

/** Where a Full service log link lands: one service's retained log for one
 *  execution, with the lines to highlight and the story it was opened from. */
export interface ServiceLogAnchor {
  service: string
  execution: number
  startLine: number
  endLine: number
  /** The span was chosen by position among same-name spans. */
  approximate: boolean
  /** Absent when the range came from a link rather than a click. */
  caseTitle?: string
  /** e.g. "Repair cycle 2 · Before this repair". */
  context?: string
}

/** The excerpt's provenance line, in the order the reader needs it. */
export function excerptCaption(excerpt: ServiceLogExcerpt, label: string): string {
  const parts = [label, `execution ${excerpt.execution}`]
  if (excerpt.span && excerpt.totalLines !== undefined) parts.push(`lines ${excerpt.span.startLine}–${excerpt.span.endLine} of ${excerpt.totalLines}`)
  if (excerpt.window?.truncated) parts.push(`last ${excerpt.window.lines.length} lines of this test's span`)
  if (excerpt.source === 'live') parts.push('live log')
  return parts.join(' · ')
}

/** Why a service shows no output for an attempt. */
export function excerptGapCopy(excerpts: readonly ServiceLogExcerpt[], execution: number): string {
  if (excerpts.length > 0 && excerpts.every((e) => e.missing === 'not-retained')) {
    return `Execution ${execution}'s service output was not retained — this run was recorded before Canary kept each execution's service log.`
  }
  return `No service printed this test's markers in execution ${execution}.`
}

/** Playwright's run-folder copies that no test's story shows. A story shows
 *  one only for an unstamped latest attempt with a unique name; every other
 *  copy — a stamped run's, or one two same-name tests could own — would
 *  otherwise be unreachable, though the run kept it. */
export function unshownLatestCopies(
  evidence: RunEvidence,
  detail: Pick<RunDetail, 'attemptArtifacts' | 'playwrightArtifacts'>,
): PlaywrightArtifactGroup[] {
  const shown = new Set(evidence.cases.flatMap((c) => (c.latest && mediaForAttempt(c.latest, evidence, detail).kind === 'latest-copy' ? [c.latest.name] : [])))
  return (detail.playwrightArtifacts ?? []).filter((g) => g.artifacts.length > 0 && !shown.has(g.testName))
}
