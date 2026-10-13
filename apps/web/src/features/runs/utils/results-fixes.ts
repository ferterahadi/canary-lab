// What a test's Results & Fixes dialog shows for the reader's selection.
//
// Pure presentation over the shared run-evidence projection: the test's
// timeline of runs, which one is open, and the plain words for media gaps.
// Verdicts stay the runner's — nothing here decides a pass.
import { type AttemptMedia, type CaseCycle, type CaseEvidence, type EvidenceAttempt, type RunEvidence } from '@shared/run-evidence'
import type { JournalSection, RunDetail, RunSummary, ServiceLogExcerpt } from '@shared/run-detail'
import type { PlaybackCaseEntry } from '@shared/playback-identity'
import { buildTestNumbering, parseLocation, testNumberKey } from '@/shared/test-numbering'
import { playbackFocusCase, playbackTests } from './run-detail-playback'
import { statusFromPlaybackResult, type StepStatus } from './test-step-status'

/** A run-wide repair-cycle number, or the case's first recorded execution —
 *  how an older link names a place in a test's story. */
export type CycleChoice = number | 'initial'

/** The open test dialog's two tabs. */
export type TestDialogTab = 'summary' | 'artifacts'

/** The reader's place in Results & Fixes. `caseKey` is the open test dialog;
 *  `test` names it the way a link does (the key is in-memory only). `attempt`
 *  is the timeline entry the reader picked — absent = follow the latest, so a
 *  new run advances the dialog. `cycle` is an older link's place, read only
 *  until the reader picks an entry. `tab` absent = the test's default tab, and
 *  `journal` is the repair notes' open source dialog. */
export interface ResultsSelection {
  caseKey: string | null
  test?: { name: string; id?: string; location?: string }
  attempt?: number
  cycle?: CycleChoice
  tab?: TestDialogTab
  journal?: 'entry' | 'all'
}

/** An attempt that has not ended reads as running; no attempt at all is the
 *  roster's not-run case, never a pass. One the runner stopped mid-test has
 *  no result either, and says so through `attemptLabel`. */
export function attemptStatus(attempt: EvidenceAttempt | undefined): StepStatus {
  if (attempt?.stopped) return 'pending'
  return attempt ? statusFromPlaybackResult(attempt) : 'pending'
}

/** Badge text where the status word alone would mislead. */
export function attemptLabel(attempt: EvidenceAttempt | undefined): string | undefined {
  if (!attempt) return 'not run'
  return attempt.stopped ? 'stopped' : undefined
}

/** The collapsed row's mark for a case whose badge hides an earlier failure:
 *  it passes, is skipped, or is running again now, but failed before. A case
 *  failing now says so in its own badge, so it carries no mark. */
export function recoveredNote(evidence: CaseEvidence): string | undefined {
  const status = attemptStatus(evidence.latest)
  if (status !== 'passed' && status !== 'skipped' && status !== 'testing') return undefined
  const failedBefore = evidence.attempts.some((a) => a !== evidence.latest && ['failed', 'timedout'].includes(attemptStatus(a)))
  if (!failedBefore) return undefined
  const cycle = evidence.cycles.at(-1)?.cycle
  const execution = evidence.latest!.executionIndex
  if (status === 'passed') return cycle ? `Failed first · passed after repair ${cycle}` : 'Failed first · passed on retry'
  if (status === 'skipped') return `Failed first · skipped${execution !== undefined ? ` in execution ${execution}` : ''}`
  return cycle ? `Failed first · running again after repair ${cycle}` : 'Failed first · running again'
}

/** One run of a test in its dialog's timeline. An entry owns exactly one
 *  attempt and the repair this test went through just before it, so its
 *  summary and artifacts never have to choose between two runs. */
export interface RunEntry {
  key: string
  /** Position in the test's history, oldest = 1 — what a link names. */
  number: number
  /** Absent for a repair the runner has not checked on this test yet, or a
   *  test that has not run at all. */
  attempt?: EvidenceAttempt
  cycle?: CaseCycle
  title: string
  subtitle: string
  status: StepStatus
  /** Badge text where the status word alone would mislead. */
  label?: string
}

/** The test's runs, newest first. */
export function runEntries(evidence: CaseEvidence): RunEntry[] {
  const entries: RunEntry[] = evidence.attempts.map((attempt, i) => {
    const cycle = evidence.cycles.find((c) => c.verification.kind === 'observed' && c.verification.attempt.attemptKey === attempt.attemptKey)
    const retry = attempt.retry ?? 0
    const title = i === 0 ? 'Initial run' : cycle ? `Repair ${cycle.cycle}` : retry > 0 ? `Retry ${retry}` : 'Run again'
    // A retry entry's title already says which retry it is.
    return { key: attempt.attemptKey, number: i + 1, attempt, ...(cycle ? { cycle } : {}), title, subtitle: retry > 0 && title !== `Retry ${retry}` ? `retry ${retry}` : '', status: attemptStatus(attempt), ...(attempt.stopped ? { label: 'stopped' } : {}) }
  })
  // The title names the run; its execution number is only worth showing to
  // tell apart two runs that share a title. Only "Run again" can repeat — each
  // repair is checked by one run, and a retry's title carries its number — and
  // it never has a retry note, so the execution is the whole subtitle.
  for (const entry of entries) {
    const execution = entry.attempt!.executionIndex
    if (execution === undefined || entries.filter((e) => e.title === entry.title).length < 2) continue
    entry.subtitle = `execution ${execution}`
  }
  // A repair the runner has not checked on this test still happened, so it
  // gets an entry of its own with no run under it.
  for (const cycle of evidence.cycles) {
    if (cycle.verification.kind === 'observed') continue
    const notRerun = cycle.verification.kind === 'not-rerun'
    entries.push({
      key: `cycle-${cycle.cycle}`, number: entries.length + 1, cycle, title: `Repair ${cycle.cycle}`,
      subtitle: notRerun ? 'not run again' : 'waiting for the runner', status: 'pending', label: notRerun ? 'not rerun' : 'pending',
    })
  }
  if (entries.length === 0) return [{ key: 'not-run', number: 1, title: 'Not run', subtitle: 'not in this run yet', status: 'pending', label: 'not run' }]
  // Newest sits at the top, so it needs no "latest" label. A lone run says
  // whether a repair followed, since no other entry shows it.
  const [only] = entries
  if (entries.length === 1 && only.status === 'passed') only.subtitle = `${only.subtitle ? `${only.subtitle} · ` : ''}no repair needed`
  else if (entries.length === 1 && only.status !== 'testing') only.subtitle = `${only.subtitle ? `${only.subtitle} · ` : ''}no repair ran`
  return entries.reverse()
}

/** The entry to open: the one a link or pick names, else the latest. `stale`
 *  says what was asked for when the test has no such entry, so the dialog can
 *  explain the fallback instead of swapping it silently. */
export function resolveRunEntry(entries: readonly RunEntry[], selection: Pick<ResultsSelection, 'attempt' | 'cycle'>): { entry: RunEntry; stale?: string } {
  const latest = entries[0]
  if (selection.attempt !== undefined) {
    const entry = entries.find((e) => e.number === selection.attempt)
    return entry ? { entry } : { entry: latest, stale: `This test has no run ${selection.attempt}; showing its latest run.` }
  }
  if (selection.cycle === undefined) return { entry: latest }
  const entry = selection.cycle === 'initial' ? entries.at(-1)! : entries.find((e) => e.cycle?.cycle === selection.cycle)
  return entry ? { entry } : { entry: latest, stale: `Repair ${selection.cycle} did not address this test; showing its latest run.` }
}

/** What an entry's Summary tab holds. Everything but `sections` leaves the
 *  whole tab empty — there is nothing to say beyond the timeline's own chip. */
export type SummaryKind = 'passed-clean' | 'passed-retry' | 'running-first' | 'not-run' | 'sections'

export function summaryKind(entry: RunEntry): SummaryKind {
  if (entry.cycle) return 'sections'
  if (!entry.attempt) return 'not-run'
  if (entry.status === 'passed') return (entry.attempt.retry ?? 0) > 0 ? 'passed-retry' : 'passed-clean'
  if (entry.status === 'testing' && entry.number === 1) return 'running-first'
  return 'sections'
}

/** Why an attempt has no media to show. An execution still running is not a
 *  gap — its media is kept when it ends — so it has no wording here. */
export function mediaGapCopy(reason: Exclude<Extract<AttemptMedia, { kind: 'none' }>['reason'], 'pending'>): string {
  switch (reason) {
    case 'not-retained': return 'No screenshot, video or trace was retained for this execution.'
    case 'superseded': return 'Not retained: this run kept one copy per test, and a later attempt replaced it.'
    case 'ambiguous': return 'Not shown: another test with the same name could own the retained copy.'
  }
}

/** Why a run that kept its media has no screenshot or video of this kind, in
 *  the terms of the suite's artifact policy. */
export function missingMediaCopy(kind: 'screenshot' | 'video', mode: string, passed: boolean): string {
  const noun = kind === 'screenshot' ? 'Screenshots are' : 'Video is'
  if (mode === 'off') {
    return kind === 'screenshot'
      ? 'Screenshots were off for this run, so Playwright kept none. Turn them on in Artifact settings to record the next run.'
      : 'Video recording was off for this run, so Playwright kept none. Turn it on in Artifact settings to record the next run.'
  }
  if (mode === 'on-first-retry' || mode === 'on-all-retries') return `${noun} recorded only when Playwright retries a test, and this run was not a retry.`
  if (passed && mode !== 'on') return `${noun} kept only when a test fails, and this run passed.`
  return `Playwright kept no ${kind} for this run.`
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
  if (listed > 1) return `This repair's entry covers ${listed} tests.`
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
  /** e.g. "Repair 2 · Before this repair". */
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
