import { useState, type ReactNode } from 'react'
import { journalForCycle, type CaseCycle, type CaseEvidence, type EvidenceAttempt, type RunEvidence } from '@shared/run-evidence'
import type { RunDetail } from '@shared/run-detail'
import type { RunCycleReview } from '@shared/test-view/cycle-review'
import { shortSourceLocation } from '@shared/lib/source-location'
import { formatLocalDateTime } from '@/shared/lib/format'
import { SourceModal } from '@/shared/ui/ActivityLogModal'
import { EmptyState, type EmptyReason } from '@/shared/ui/EmptyState'
import { CODE_DIALOG_SIZE, Modal } from '@/shared/ui/Overlays'
import { Tab } from '@/shared/ui/Tab'
import { HintIcon } from '@/shared/ui/Icons'
import type { LiveResource } from '@/shared/state/use-live-resource'
import { ShikiCode, StepStatusBadge } from '@/shared/ui/TestCodeBlock'
import { stripLeadingTestOrdinal } from '@/shared/test-numbering'
import { useRunJournal } from '../state/use-run-journal'
import { useCycleReview } from '../state/use-cycle-review'
import { codeSpans, parseBodyFields, splitLead } from '../utils/journal-utils'
import { errorLayout, parseAssertionError, parseCodeFrame } from '../utils/assertion-error'
import {
  journalMarkdown,
  resolveRunEntry,
  runEntries,
  runWideReason,
  summaryKind,
  type ResultsSelection,
  type RunEntry,
  type ServiceLogAnchor,
  type SummaryKind,
  type TestDialogTab,
} from '../utils/results-fixes'
import { AttemptEvidence } from './RunPlaybackPanels'
import { ResultSection } from './ResultSection'
import { ServiceLogsSection } from './ServiceLogExcerpt'
import { CycleFileReview } from './CycleFileReview'
import { Band, FieldRow } from './ResultRows'

/** The Summary tab when it has nothing to say beyond the timeline's own chip.
 *  Bodies sit in EmptyState's three-line band. */
const EMPTY_SUMMARY: Record<Exclude<SummaryKind, 'sections'>, { reason: EmptyReason; title: string; body: string }> = {
  'passed-clean': { reason: 'nothing-to-report', title: 'No failure to explain', body: "This test passed in its first execution, so no repair ran and there's no error to show. Its steps, screenshot and video are under Artifacts." },
  'passed-retry': { reason: 'nothing-to-report', title: 'No failure in this attempt', body: 'This attempt passed on a runner retry, with no repair before it. The attempt that failed is the entry just below this one in the timeline.' },
  'running-first': { reason: 'not-yet', title: 'Still running', body: 'The runner is executing this test right now. Its result, its error and any service log lines appear here as soon as this execution finishes.' },
  'not-run': { reason: 'not-yet', title: 'Not run in this run', body: "The runner hasn't reached this test in this run, so there's no result, error or evidence yet. It appears here once an execution runs it." },
}

const NOT_CHECKED_YET = "This repair hasn't been checked on this test yet, so there are no steps, screenshot or video. They appear once the runner runs it again."

/**
 * One test's history in this run. The timeline on the left lists every run of
 * the test, newest first, and carries the only result chips in the dialog; the
 * Summary and Artifacts tabs describe the selected run alone. The frame never
 * changes shape — same size, same timeline, same two tabs for every test — so
 * only its contents move. Everything is projected from the pushed run detail,
 * so an open dialog follows a run that is still going.
 */
export function TestResultDialog({ detail, evidence, caseEvidence, number, selection, onSelectionChange, onClose, onOpenServiceLog, onOpenArtifactSettings }: {
  detail: RunDetail
  evidence: RunEvidence
  caseEvidence: CaseEvidence
  number?: number
  selection: ResultsSelection
  onSelectionChange: (selection: ResultsSelection) => void
  onClose: () => void
  onOpenServiceLog?: (anchor: ServiceLogAnchor) => void
  /** Opens the suite's Playwright artifact settings, beside the evidence they
   *  decide — a missing video says to turn it on there. */
  onOpenArtifactSettings?: () => void
}) {
  const entries = runEntries(caseEvidence)
  const { entry, stale } = resolveRunEntry(entries, selection)
  // Fixed when the dialog opens: a test that passed first time has nothing to
  // summarise, so it opens on its evidence. Fixing it keeps a run that settles
  // while the dialog is open from moving the reader to another tab.
  const [defaultTab] = useState<TestDialogTab>(() => summaryKind(entries[0]) === 'passed-clean' ? 'artifacts' : 'summary')
  const tab = selection.tab ?? defaultTab
  // The journal dialog belongs to the Summary, so a tab change closes it.
  const { journal: _journal, ...place } = selection
  const show = (next: TestDialogTab) => onSelectionChange({ ...place, tab: next })
  // A pick replaces an older link's cycle, and the journal it had open.
  const pick = (next: RunEntry) => onSelectionChange({
    caseKey: selection.caseKey,
    ...(selection.test ? { test: selection.test } : {}),
    ...(selection.tab ? { tab: selection.tab } : {}),
    attempt: next.number,
  })
  return (
    <Modal
      open
      portal
      onClose={onClose}
      eyebrow={`Test #${number ?? '?'}`}
      title={stripLeadingTestOrdinal(caseEvidence.title)}
      description={caseEvidence.location ? shortSourceLocation(caseEvidence.location) : undefined}
      {...CODE_DIALOG_SIZE}
      testId="test-result-dialog"
      bodyClassName="flex min-h-0 flex-1 overflow-hidden"
    >
      <aside className="w-[232px] flex-none overflow-y-auto border-r p-2 scrollbar-thin" style={{ borderColor: 'var(--border-default)' }} aria-label="Timeline">
        <p className="cl-rubric m-0 px-2.5 pb-1.5 pt-1">Timeline</p>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {entries.map((e) => <TimelineEntry key={e.key} entry={e} selected={e.key === entry.key} onSelect={() => pick(e)} />)}
        </ul>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div role="tablist" className="flex flex-none items-end gap-4 border-b px-5 pt-2.5" style={{ borderColor: 'var(--border-default)' }}>
          <Tab role="tab" aria-selected={tab === 'summary'} active={tab === 'summary'} onClick={() => show('summary')}>Summary</Tab>
          <Tab role="tab" aria-selected={tab === 'artifacts'} active={tab === 'artifacts'} onClick={() => show('artifacts')}>Artifacts</Tab>
        </div>
        {/* A routed run this test never had falls back to the latest; say which
            was asked for rather than swap it silently. */}
        {stale && <p className="mx-5 mb-0 mt-2.5 text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid="stale-entry-link">{stale}</p>}
        <div className="flex min-h-0 flex-1 flex-col">
          {tab === 'summary' ? (
            <Summary
              key={entry.key}
              detail={detail}
              evidence={evidence}
              caseEvidence={caseEvidence}
              entry={entry}
              journal={selection.journal}
              onJournalChange={(journal) => onSelectionChange({ ...selection, journal: journal ?? undefined })}
              onOpenServiceLog={onOpenServiceLog}
            />
          ) : entry.attempt ? (
            <AttemptEvidence key={entry.key} attempt={entry.attempt} evidence={evidence} media={detail} policy={detail.manifest.playwrightArtifacts} onOpenSettings={onOpenArtifactSettings} />
          ) : (
            <EmptyState
              reason="not-yet"
              title={entry.cycle ? 'Nothing recorded yet' : EMPTY_SUMMARY['not-run'].title}
              body={entry.cycle ? NOT_CHECKED_YET : EMPTY_SUMMARY['not-run'].body}
              testId="artifacts-empty"
            />
          )}
        </div>
      </div>
    </Modal>
  )
}

/** The only place a result chip appears in the dialog. */
function TimelineEntry({ entry, selected, onSelect }: { entry: RunEntry; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        data-testid="timeline-entry"
        className="block w-full cursor-pointer rounded-md px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
        style={{ background: selected ? 'var(--bg-selected)' : 'transparent' }}
      >
        {/* The title names the run, so there is no ordinal beside it. */}
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{entry.title}</span>
          <StepStatusBadge soft status={entry.status} {...(entry.label ? { label: entry.label } : {})} />
        </span>
        {entry.subtitle && <span className="mt-0.5 block truncate text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{entry.subtitle}</span>}
      </button>
    </li>
  )
}

function Summary({ detail, evidence, caseEvidence, entry, journal, onJournalChange, onOpenServiceLog }: {
  detail: RunDetail
  evidence: RunEvidence
  caseEvidence: CaseEvidence
  entry: RunEntry
  journal?: 'entry' | 'all'
  onJournalChange: (journal: 'entry' | 'all' | null) => void
  onOpenServiceLog?: (anchor: ServiceLogAnchor) => void
}) {
  const kind = summaryKind(entry)
  if (kind !== 'sections') {
    const empty = EMPTY_SUMMARY[kind]
    return <EmptyState reason={empty.reason} title={empty.title} body={empty.body} testId="summary-empty" />
  }
  const attempt = entry.attempt
  const execution = attempt?.executionIndex
  // Both cards carry the selected timeline entry's own name ("Repair 2"), so
  // the picked row and the cards it opens read as one step: what it changed,
  // then how the test went.
  const title = `${entry.title}: test result`
  const file = caseEvidence.location ? shortSourceLocation(caseEvidence.location).replace(/:\d+(?::\d+)?$/, '') : undefined
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin" style={{ scrollbarGutter: 'stable' }} data-testid="test-summary">
      <div className="flex flex-col gap-3">
        {entry.cycle && (
          <CycleRepair runId={detail.runId} feature={detail.manifest.feature} evidence={evidence} caseEvidence={caseEvidence} cycle={entry.cycle} open={journal ?? null} setOpen={onJournalChange} />
        )}
        {attempt && (entry.status === 'failed' || entry.status === 'timedout') ? (
          <>
            <ErrorSection attempt={attempt} title={title} file={file} />
            {detail.manifest.services.length > 0 && (
              <ServiceLogsSection runId={detail.runId} evidence={evidence} attempt={attempt} label={entry.title} caseTitle={caseEvidence.title} onOpenFullLog={onOpenServiceLog} />
            )}
          </>
        ) : (
          <ResultSection title={title} testId="section-result"><Sentence>{resultSentence(entry)}</Sentence></ResultSection>
        )}
      </div>
    </div>
  )
}

/** A result with no error to show, in one sentence. */
function resultSentence(entry: RunEntry): string {
  if (!entry.attempt) {
    return entry.cycle?.verification.kind === 'not-rerun'
      ? "The next execution didn't run this test, so this repair wasn't checked on it."
      : 'Not run again yet. The runner checks this repair in its next execution.'
  }
  if (entry.status === 'passed') return entry.cycle ? 'Passed. The assertion held after this repair.' : 'Passed.'
  if (entry.status === 'skipped') return 'Skipped. Playwright recorded no reason for the skip.'
  if (entry.attempt.stopped) return 'Stopped before it finished. The run was stopped while this test was running, so it has no result.'
  return 'Still running. The result appears here when this execution finishes.'
}

/** A section with nothing to show says so in one sentence, in place. */
function Sentence({ children }: { children: ReactNode }) {
  return <div className="cl-card-body text-xs" style={{ color: 'var(--text-muted)' }}>{children}</div>
}

/** An execution that failed, in the order it is investigated: what went
 *  wrong, then where. The message leads the Failure row with the mismatch
 *  under it; the code frame is a band in the same editor as the Tests column
 *  and the repair's Changes. Anything the split cannot place stays verbatim. */
function ErrorSection({ attempt, title, file }: { attempt: EvidenceAttempt; title: string; file?: string }) {
  const message = attempt.error?.message
  const snippet = attempt.error?.snippet
  const parts = message ? parseAssertionError(message) : null
  const layout = parts ? errorLayout(parts) : null
  let failure: ReactNode = <Sentence>Playwright recorded no error message for this failure.</Sentence>
  if (parts && layout) {
    const pair = <ValuePair expected={parts.expected} received={parts.received} />
    failure = (
      <FieldRow label="Failure">
        {layout.message
          ? <><p className="m-0" style={{ color: 'var(--danger)' }} data-testid="failure-message"><Prose text={layout.message} inheritColor /></p><p className="mb-0 mt-0.5">{pair}</p></>
          : <p className="m-0">{pair}</p>}
      </FieldRow>
    )
  } else if (message) {
    failure = <FieldRow label="Failure"><Block color="var(--danger)">{message}</Block></FieldRow>
  }
  return (
    <ResultSection title={title} context={snippet ? undefined : layout?.caption ?? undefined} testId="section-error">
      {failure}
      {layout?.rest && <FieldRow label="Details" first={false}><Block color="var(--text-secondary)">{layout.rest}</Block></FieldRow>}
      {snippet && <CodeBand snippet={snippet} file={file} caption={layout?.caption ?? null} />}
    </ResultSection>
  )
}

function ValuePair({ expected, received }: { expected: { label: string; value: string }; received: { label: string; value: string } }) {
  return (
    <span className="text-[11px]" style={{ fontFamily: 'var(--font-mono)' }}>
      <span style={{ color: 'var(--text-muted)' }}>{expected.label}</span>{' '}
      <span className="whitespace-pre-wrap break-all" style={{ color: 'var(--success)' }} data-testid="expected-value">{expected.value}</span>
      <span className="ml-5" style={{ color: 'var(--text-muted)' }}>{received.label}</span>{' '}
      <span className="whitespace-pre-wrap break-all" style={{ color: 'var(--danger)' }} data-testid="received-value">{received.value}</span>
    </span>
  )
}

/** Verbatim runner output, in the run panes' log-block voice. */
function Block({ color, children }: { color: string; children: string }) {
  return (
    <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border p-2.5 text-[11px] leading-5 scrollbar-thin" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', color, fontFamily: 'var(--font-mono)' }}>
      {children}
    </pre>
  )
}

/** Playwright's code frame in the Tests column's editor: highlighted, each
 *  row numbered by its source line, the failing line marked as the Tests
 *  column marks it. A snippet in any other shape shows verbatim. */
function CodeBand({ snippet, file, caption }: { snippet: string; file?: string; caption: string | null }) {
  const frame = parseCodeFrame(snippet)
  const failing = frame?.findIndex((line) => line.failing) ?? -1
  const at = frame && failing >= 0 ? `${file ?? 'line'}:${frame[failing].line}` : file
  return (
    <Band label="Code" title={at && <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{at}</span>} aside={caption}>
      {frame
        ? <div className="cl-band-code" data-testid="error-code-frame">
            <ShikiCode
              source={frame.map((line) => line.text).join('\n')}
              sourceLineMap={frame.map((line) => ({ sourceLine: line.line, sourceLines: [line.line] }))}
              numberBySource
              lineHighlight={failing >= 0 ? { kind: 'failed', lines: new Set([failing + 1]) } : undefined}
              showOpenButton={false}
            />
          </div>
        : <div className="p-3"><Block color="var(--text-secondary)">{snippet}</Block></div>}
    </Band>
  )
}

/** Repair notes and code changes: both come from the cycle's journal entry,
 *  so they share one live journal read. */
function CycleRepair({ runId, feature, evidence, caseEvidence, cycle, open: requestedOpen, setOpen }: {
  runId: string
  feature: string
  evidence: RunEvidence
  caseEvidence: CaseEvidence
  cycle: CaseCycle
  open: 'entry' | 'all' | null
  setOpen: (open: 'entry' | 'all' | null) => void
}) {
  const { value: sections, error } = useRunJournal(feature, runId)
  const attribution = sections ? journalForCycle(cycle.cycle, sections, evidence, caseEvidence.name) : undefined
  const review = useCycleReview(runId, attribution?.section.iteration ?? null)
  const fields = attribution ? parseBodyFields(attribution.section.body) : []
  const hypothesis = fields.find((f) => f.key === 'hypothesis')?.value
  const fix = fields.find((f) => f.key === 'fix.description')?.value
  // A routed entry dialog waits for the journal, and opens nothing for a cycle
  // with no attributed entry; the whole journal opens once there is one.
  const open = requestedOpen === 'entry' ? (attribution ? 'entry' : null) : requestedOpen === 'all' && sections && sections.length > 0 ? 'all' : null
  const sameName = evidence.cases.filter((c) => c.name === caseEvidence.name).length
  // How the entry reached this cycle is about the card, not its content, so
  // it sits beside the title as a hint.
  const provenance = attribution ? [
    ...(attribution.scope === 'run-wide' ? [runWideReason(attribution.section, sameName)] : []),
    ...(attribution.source === 'derived' ? ['Matched to this repair by entry order; the entry predates repair numbers.'] : []),
  ].join(' ') : ''
  const specEdits = review.value && review.value !== 'missing' ? review.value.files.filter((f) => f.role === 'spec').map((f) => f.path) : []
  let notes: ReactNode
  if (error) notes = <Sentence><span className="text-danger">The journal couldn&apos;t be read: {error}</span></Sentence>
  else if (!sections) notes = <Sentence>Reading the journal…</Sentence>
  else if (!attribution) notes = <Sentence>The agent wrote no journal entry for this cycle.</Sentence>
  else if (!hypothesis && !fix) notes = <Sentence>This cycle&apos;s journal entry records no hypothesis or fix.</Sentence>
  else {
    notes = (
      <dl className="m-0" data-testid="journal-excerpt">
        {hypothesis && <NoteRow label="Hypothesis" text={hypothesis} />}
        {fix && <NoteRow label="Fix" text={fix} first={!hypothesis} mark={specEdits.length > 0 && <SpecEditMark paths={specEdits} />} />}
      </dl>
    )
  }
  return (
    <>
      <ResultSection
        title={`Repair ${cycle.cycle}: what changed`}
        testId="section-notes"
        mark={provenance && <HintIcon hint={provenance} />}
        action={sections && sections.length > 0 && (
          <span className="flex items-center gap-1">
            {attribution && <HeadLink onClick={() => setOpen('entry')} testId="journal-read-entry">Open entry</HeadLink>}
            <HeadLink onClick={() => setOpen('all')} testId="journal-read-all">Run journal</HeadLink>
          </span>
        )}
      >
        {notes}
        <SourceModal
          open={open !== null}
          onClose={() => setOpen(null)}
          eyebrow="Journal"
          title={open === 'all' ? 'Full run journal' : `Iteration ${attribution?.section.iteration ?? '?'}`}
          description={open === 'entry' && attribution?.section.timestamp ? formatLocalDateTime(attribution.section.timestamp) : 'diagnosis-journal.md'}
          source={open === 'all' ? journalMarkdown(sections ?? []) : attribution?.section.body ?? ''}
          lang="markdown"
          testId="journal-source-modal"
        />
        <ChangesBand cycle={cycle.cycle} section={attribution?.section} loading={!sections && !error} review={review} />
      </ResultSection>
    </>
  )
}

/** One journal field: its first sentence as the takeaway, and the rest of its
 *  working muted under it. Each part has its own clamp, so a long hypothesis
 *  never crowds the fix out; the full text is one click away in the entry. */
function NoteRow({ label, text, first = true, mark }: { label: string; text: string; first?: boolean; mark?: ReactNode }) {
  const { lead, rest } = splitLead(text)
  return (
    <FieldRow label={label} mark={mark} first={first}>
      <p className="m-0 line-clamp-2" style={{ color: 'var(--text-primary)' }}><Prose text={lead} /></p>
      {rest && <p className="mb-0 mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}><Prose text={rest} /></p>}
    </FieldRow>
  )
}

/** Agent prose with the code it names set in mono. Code reads brighter than
 *  muted prose; inside a coloured line (an error) it keeps the line's hue. */
function Prose({ text, inheritColor = false }: { text: string; inheritColor?: boolean }) {
  return <>{codeSpans(text).map((part, i) => part.code
    ? <code key={i} className="text-[11px]" style={{ fontFamily: 'var(--font-mono)', color: inheritColor ? 'inherit' : 'var(--text-primary)' }}>{part.text}</code>
    : part.text)}</>
}

/** The repair rule says a fix changes the app, not the test, so a fix whose
 *  patch touches a spec earns a cue: the title's hint ring with a `!`, so the
 *  card carries one mark shape. */
function SpecEditMark({ paths }: { paths: string[] }) {
  return (
    <span className="inline-flex" data-testid="fix-edits-spec">
      <HintIcon glyph="!" hint={`Edits ${paths.length === 1 ? 'a test file' : `${paths.length} test files`}: ${paths.join(', ')}`} />
    </span>
  )
}

function HeadLink({ onClick, testId, children }: { onClick: () => void; testId: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} className="cursor-pointer rounded border-0 bg-transparent px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:text-primary">
      {children}
    </button>
  )
}

/** The cycle's patch as a band of the repair card. It reads through the
 *  notes' own read, so the spec-edit cue and the files can never disagree. */
function ChangesBand({ cycle, section, loading, review }: {
  cycle: number
  section?: { iteration: number | null; body: string }
  loading: boolean
  review: LiveResource<RunCycleReview | 'missing'>
}) {
  const { value, error } = review
  let state: string | null = null
  if (loading) state = 'Reading this repair\'s patch…'
  else if (!section) state = 'No patch is linked to this cycle.'
  else if (error) state = `This repair's patch couldn't be read: ${error}`
  else if (value === null) state = 'Reading this repair\'s patch…'
  else if (value === 'missing') state = 'This repair recorded no diff.'
  else if (value.files.length === 0) state = 'This repair changed no tracked files.'
  if (state !== null || !value || value === 'missing') {
    return <Band label="Changes" title={<span style={{ color: 'var(--text-muted)' }}>{state}</span>} testId="section-changes" />
  }
  const title = value.files.length === 1 ? value.files[0].path : `${value.files.length} files`
  return (
    <Band label="Changes" title={<span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{title}</span>} testId="section-changes">
      <CycleFileReview files={value.files} cycle={cycle} bare />
    </Band>
  )
}
