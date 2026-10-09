import { useMemo, useState, type ReactNode } from 'react'
import { cycleReviewFromPatch } from '@shared/test-view/cycle-review'
import { journalDiffBlock, journalForCycle, mediaForAttempt, type CaseCycle, type CaseEvidence, type EvidenceAttempt, type RunEvidence } from '@shared/run-evidence'
import type { PlaywrightArtifactPolicy } from '@shared/configs/playwright-modes'
import type { RunDetail } from '@shared/run-detail'
import { shortSourceLocation } from '@shared/lib/source-location'
import { formatLocalDateTime, shortTime } from '@/shared/lib/format'
import { SourceModal } from '@/shared/ui/ActivityLogModal'
import { StepStatusBadge } from '@/shared/ui/TestCodeBlock'
import { useRunJournal } from '../state/use-run-journal'
import { useCycleReview } from '../state/use-cycle-review'
import { parseBodyFields } from '../utils/journal-utils'
import { artifactsUnderPolicy, compactPlaybackSteps } from '../utils/run-detail-playback'
import {
  attemptStatus,
  journalMarkdown,
  mediaGapCopy,
  runWideReason,
  selectedResult,
  verificationSummary,
  type CycleChoice,
  type ServiceLogAnchor,
} from '../utils/results-fixes'
import { AssertionMessage, EmptyArtifactMessage, EvidenceRail } from './RunPlaybackPanels'
import { ResultSection } from './ResultSection'
import { ServiceLogsSection } from './ServiceLogExcerpt'
import { CycleFileReview } from './CycleFileReview'

type MediaDetail = Pick<RunDetail, 'attemptArtifacts' | 'playwrightArtifacts'>

/**
 * One test's story for the selected repair cycle, in the approved order:
 * Failure addressed → Service logs → Repair notes → Code changes → Runner
 * verification → Artifacts. The initial execution has no repair, so it shows
 * the test result and its artifacts only. The caller keys this on case + cycle,
 * so opened media and playback never survive into another cycle's label.
 */
export function RepairStory({
  runId,
  feature,
  evidence,
  caseEvidence,
  choice,
  media,
  policy,
  hasServices,
  onOpenServiceLog,
  onOpenRunWide,
  journal,
  onJournalChange,
}: {
  runId: string
  feature: string
  evidence: RunEvidence
  caseEvidence: CaseEvidence
  choice: CycleChoice
  media: MediaDetail
  policy?: PlaywrightArtifactPolicy
  /** False for a suite that boots no service: the section has nothing to say. */
  hasServices: boolean
  onOpenServiceLog?: (anchor: ServiceLogAnchor) => void
  /** Opens the run-wide captures, journal and unassigned evidence. */
  onOpenRunWide?: () => void
  /** The repair notes' open source dialog — owned by the caller so it routes. */
  journal?: 'entry' | 'all'
  onJournalChange: (journal: 'entry' | 'all' | null) => void
}) {
  const { cycle, before, after } = selectedResult(caseEvidence, choice)
  if (!before) {
    return (
      <p className="m-0 text-xs" style={{ color: 'var(--text-muted)' }} data-testid="case-not-run">
        This test has not run in this run, so there is no result or evidence to show.
      </p>
    )
  }
  const beforeLabel = cycle ? 'Before this repair' : caseEvidence.cycles.length > 0 ? 'Initial execution' : 'Test result'
  return (
    <div className="flex flex-col gap-3" data-testid="repair-story">
      <FailureSection attempt={before} initial={!cycle} />
      {hasServices && (
        <ServiceLogsSection
          runId={runId}
          evidence={evidence}
          attempt={before}
          label={beforeLabel}
          {...(cycle ? { cycle: `Repair cycle ${cycle.cycle}` } : {})}
          caseTitle={caseEvidence.title}
          onOpenFullLog={onOpenServiceLog}
        />
      )}
      {cycle && (
        <>
          <CycleRepair runId={runId} feature={feature} evidence={evidence} caseEvidence={caseEvidence} cycle={cycle} onOpenRunWide={onOpenRunWide} open={journal ?? null} setOpen={onJournalChange} />
          <VerificationSection cycle={cycle} latest={caseEvidence.latest} />
        </>
      )}
      <ResultSection title="Artifacts" testId="section-artifacts">
        <ArtifactGroup label={beforeLabel} attempt={before} evidence={evidence} media={media} policy={policy} />
        {after && <ArtifactGroup label="After this repair" attempt={after} evidence={evidence} media={media} policy={policy} />}
      </ResultSection>
    </div>
  )
}

function executionLabel(attempt: EvidenceAttempt): string | undefined {
  const parts = [
    ...(attempt.executionIndex !== undefined ? [`Execution ${attempt.executionIndex}`] : []),
    ...(attempt.retry ? [`retry ${attempt.retry}`] : []),
  ]
  return parts.length ? parts.join(' · ') : undefined
}

function FailureSection({ attempt, initial }: { attempt: EvidenceAttempt; initial: boolean }) {
  const status = attemptStatus(attempt)
  return (
    <ResultSection title={initial ? 'Test result' : 'Failure addressed'} context={executionLabel(attempt)} action={<StepStatusBadge status={status} />} testId="section-failure">
      <div className="cl-card-body text-xs">
        <div className="flex min-w-0 flex-wrap gap-x-2 text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {attempt.location && <span className="min-w-0 truncate" title={attempt.location}>{shortSourceLocation(attempt.location)}</span>}
          {attempt.startedAt && <span>{shortTime(attempt.startedAt)}</span>}
        </div>
        {attempt.error?.snippet && (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre rounded-md border p-2.5 text-[11px] scrollbar-thin" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            {attempt.error.snippet}
          </pre>
        )}
        {/* A clean pass says nothing: narrating the absence of an error is noise. */}
        {attempt.error?.message ? (
          <AssertionMessage message={attempt.error.message} />
        ) : status === 'testing' ? (
          <p className="mb-0 mt-1.5 text-[11px]" style={{ color: 'var(--running)' }}>Currently executing in this Playwright process.</p>
        ) : status !== 'passed' && (
          <p className="mb-0 mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>Status: {attempt.status ?? status}</p>
        )}
      </div>
    </ResultSection>
  )
}

/** Repair notes and code changes: both come from the cycle's journal entry,
 *  so they share one live journal read. */
function CycleRepair({ runId, feature, evidence, caseEvidence, cycle, onOpenRunWide, open: requestedOpen, setOpen }: {
  runId: string
  feature: string
  evidence: RunEvidence
  caseEvidence: CaseEvidence
  cycle: CaseCycle
  onOpenRunWide?: () => void
  open: 'entry' | 'all' | null
  setOpen: (open: 'entry' | 'all' | null) => void
}) {
  const { value: sections, error } = useRunJournal(feature, runId)
  const attribution = sections ? journalForCycle(cycle.cycle, sections, evidence, caseEvidence.name) : undefined
  const fields = attribution ? parseBodyFields(attribution.section.body) : []
  const hypothesis = fields.find((f) => f.key === 'hypothesis')?.value
  const fix = fields.find((f) => f.key === 'fix.description')?.value
  const entryTitle = attribution ? `Iteration ${attribution.section.iteration ?? '?'}` : ''
  // A routed entry dialog waits for the journal, and opens nothing for a cycle
  // with no attributed entry; the whole journal opens once there is one.
  const open = requestedOpen === 'entry' ? (attribution ? 'entry' : null) : requestedOpen === 'all' && sections && sections.length > 0 ? 'all' : null
  const sameName = evidence.cases.filter((c) => c.name === caseEvidence.name).length
  return (
    <>
      <ResultSection
        title="Repair notes"
        context={attribution ? (attribution.scope === 'run-wide' ? 'Journal · run-wide cycle entry' : 'Journal · cycle entry') : 'Journal'}
        testId="section-notes"
      >
        <div className="cl-card-body text-xs">
          {error && <p className="m-0 text-[11px] text-danger">Failed to load the journal: {error}</p>}
          {!sections && !error && <p className="m-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>Reading the journal…</p>}
          {sections && !attribution && (
            <p className="m-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              No journal entry is attributed to repair cycle {cycle.cycle} yet. Every entry stays readable in the full run journal.
            </p>
          )}
          {attribution && (
            <>
              {hypothesis || fix ? (
                <div className="line-clamp-6 space-y-2" data-testid="journal-excerpt">
                  {hypothesis && <p className="m-0 whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-primary)' }}><span className="cl-rubric mr-2">hypothesis</span>{hypothesis}</p>}
                  {fix && <p className="m-0 whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--text-secondary)' }}><span className="cl-rubric mr-2">fix</span>{fix}</p>}
                </div>
              ) : (
                <p className="m-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>This entry records no hypothesis or fix description.</p>
              )}
              <p className="mb-0 mt-2 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                Original journal text
                {attribution.scope === 'run-wide' ? ` · ${runWideReason(attribution.section, sameName)}` : ''}
                {attribution.source === 'derived' ? ' · Matched to this cycle by entry order; the entry predates cycle stamps.' : ''}
              </p>
            </>
          )}
        </div>
        {sections && sections.length > 0 && (
          <footer className="cl-card-foot gap-2">
            {attribution && (
              <button type="button" className="cl-button px-2 py-0.5 text-[11px]" onClick={() => setOpen('entry')} data-testid="journal-read-entry">Read full entry</button>
            )}
            <button type="button" className="cl-button px-2 py-0.5 text-[11px]" onClick={() => setOpen('all')} data-testid="journal-read-all">Full run journal</button>
          </footer>
        )}
        <SourceModal
          open={open !== null}
          onClose={() => setOpen(null)}
          eyebrow="Journal"
          title={open === 'all' ? 'Full run journal' : entryTitle}
          description={open === 'entry' && attribution?.section.timestamp ? formatLocalDateTime(attribution.section.timestamp) : 'diagnosis-journal.md'}
          source={open === 'all' ? journalMarkdown(sections ?? []) : attribution?.section.body ?? ''}
          lang="markdown"
          testId="journal-source-modal"
        />
      </ResultSection>
      <CodeChanges runId={runId} cycle={cycle.cycle} section={attribution?.section} runWide={attribution?.scope === 'run-wide'} loading={!sections && !error} onOpenRunWide={onOpenRunWide} />
    </>
  )
}

function CodeChanges({ runId, cycle, section, runWide, loading, onOpenRunWide }: {
  runId: string
  cycle: number
  section?: { iteration: number | null; body: string }
  runWide: boolean
  loading: boolean
  onOpenRunWide?: () => void
}) {
  const review = useCycleReview(runId, section?.iteration ?? null)
  const inline = section ? journalDiffBlock(section.body) : undefined
  const inlineDiff = inline?.diff
  const inlineFiles = useMemo(() => inlineDiff === undefined ? undefined : cycleReviewFromPatch(inlineDiff), [inlineDiff])
  const runWideAction = onOpenRunWide && (
    <button type="button" className="cl-button px-2 py-0.5 text-[11px]" onClick={onOpenRunWide} data-testid="open-run-wide-changes">Run-wide changes</button>
  )
  const scope = runWide ? ' · run-wide: the edit is not attributed to one test' : ''
  let body: ReactNode
  if (loading || (section && review.value === null && !review.error)) {
    body = <Muted>Reading this cycle&apos;s patch…</Muted>
  } else if (!section) {
    body = <Muted>No patch is attributed to repair cycle {cycle}. The run&apos;s captured changes stay under Run-wide changes.</Muted>
  } else if (review.value && review.value !== 'missing') {
    body = review.value.files.length
      ? <><CycleFileReview files={review.value.files} cycle={cycle} /><Caption>This cycle&apos;s edits · {review.value.patchPath}{scope}</Caption></>
      : <Muted>This cycle changed no tracked files.</Muted>
  } else if (inlineFiles?.length) {
    body = (
      <>
        <CycleFileReview files={inlineFiles} cycle={cycle} />
        <Caption>From the journal entry&apos;s inline diff{inline!.truncated ? ' · cut to the journal’s size cap; the full patch was not retained' : ''}{scope}</Caption>
      </>
    )
  } else {
    body = <Muted>{review.error ? `Failed to load this cycle's patch: ${review.error}` : 'This cycle recorded no diff.'}</Muted>
  }
  return (
    <ResultSection title="Code changes" context={`Repair cycle ${cycle}`} action={runWideAction} testId="section-changes">
      <div className="cl-card-body text-xs">{body}</div>
    </ResultSection>
  )
}

function VerificationSection({ cycle, latest }: { cycle: CaseCycle; latest?: EvidenceAttempt }) {
  const v = cycle.verification
  const execution = v.kind === 'observed' ? v.attempt.executionIndex : v.execution
  const badge = v.kind === 'observed'
    ? <StepStatusBadge status={attemptStatus(v.attempt)} />
    : <StepStatusBadge status="pending" label={v.kind === 'pending' ? 'pending' : 'not rerun'} />
  return (
    <ResultSection title="Runner verification" context={execution !== undefined ? `Execution ${execution}` : undefined} action={badge} testId="section-verification">
      <div className="cl-card-body text-xs">
        <p className="m-0 leading-relaxed" style={{ color: v.kind === 'observed' && attemptStatus(v.attempt) === 'passed' ? 'var(--success)' : 'var(--text-secondary)' }}>
          {verificationSummary(v, latest)}
        </p>
        {v.kind === 'observed' && v.attempt.error?.message && <AssertionMessage message={v.attempt.error.message} />}
      </div>
    </ResultSection>
  )
}

function ArtifactGroup({ label, attempt, evidence, media, policy }: {
  label: string
  attempt: EvidenceAttempt
  evidence: RunEvidence
  media: MediaDetail
  policy?: PlaywrightArtifactPolicy
}) {
  const found = mediaForAttempt(attempt, evidence, media)
  const shown = artifactsUnderPolicy(found.kind === 'none' ? [] : found.artifacts, policy)
  return (
    <div className="border-b last:border-b-0" style={{ borderColor: 'var(--border-default)' }} data-testid="artifact-group">
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5">
        <h4 className="m-0 text-[11.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</h4>
        {executionLabel(attempt) && <span className="min-w-0 truncate text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{executionLabel(attempt)?.toLowerCase()}</span>}
        <span className="min-w-2 flex-1" />
        <StepStatusBadge status={attemptStatus(attempt)} />
      </div>
      {found.kind === 'none' && <div className="px-3 pt-2"><EmptyArtifactMessage>{mediaGapCopy(found)}</EmptyArtifactMessage></div>}
      {found.kind === 'latest-copy' && <Caption className="px-3">The run&apos;s one retained copy for this test — it belongs to this latest attempt.</Caption>}
      <EvidenceRail
        screenshots={shown.screenshots}
        screenshotMode={shown.screenshotMode}
        videos={shown.links.filter((a) => a.kind === 'video')}
        videoMode={policy?.video ?? 'off'}
        traces={shown.links.filter((a) => a.kind === 'trace')}
        steps={compactPlaybackSteps(attempt.steps)}
      />
    </div>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>{children}</p>
}

function Caption({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`mb-0 mt-2 text-[10.5px] ${className}`} style={{ color: 'var(--text-muted)' }}>{children}</p>
}
