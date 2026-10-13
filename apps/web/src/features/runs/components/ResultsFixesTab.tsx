import { useEffect, useMemo, useRef } from 'react'
import { buildRunEvidence, type CaseEvidence, type EvidenceAttempt, type RunEvidence } from '@shared/run-evidence'
import type { PlaywrightArtifact, RunDetail } from '@shared/run-detail'
import type { VerificationDiagnostics } from '@shared/verification'
import { shortSourceLocation } from '@shared/lib/source-location'
import { shortTime } from '@/shared/lib/format'
import { EmptyState } from '@/shared/ui/EmptyState'
import { EMPTY_COPY } from '@/shared/ui/empty-state-copy'
import { AlertCircleIcon, ChevronRightIcon } from '@/shared/ui/Icons'
import { Tab } from '@/shared/ui/Tab'
import { StepStatusBadge } from '@/shared/ui/TestCodeBlock'
import { TestIdBadge } from '@/shared/ui/TestIdBadge'
import { Tooltip } from '@/shared/ui/Tooltip'
import { stripLeadingTestOrdinal } from '@/shared/test-numbering'
import { attemptLabel, attemptStatus, caseNumbers, recoveredNote, type ResultsSelection, type ServiceLogAnchor } from '../utils/results-fixes'
import { PaneTerminal } from './PaneTerminal'
import { VerificationDiagnosticsPanel } from './RunDiagnosticsPanels'
import { ArtifactCaption, SectionHeader } from './RunPlaybackPanels'
import { RunPane } from './RunPane'
import { TestResultDialog } from './TestResultDialog'

export type ResultsView = 'tests' | 'terminal'

/**
 * Results & Fixes: every recorded test, one row each, and the Playwright
 * terminal. A row opens the test's dialog — its runs, repairs and evidence.
 * The run's captured changes belong to the run, not one test, so they sit
 * behind the run header's Changes button. Everything is projected from the run
 * detail the runs WebSocket pushes, so an update re-renders the open view and
 * dialog in place; the reader's selection is owned by the caller so it
 * survives a tab switch.
 */
export function ResultsFixesTab({
  detail,
  view,
  onViewChange,
  selection,
  onSelectionChange,
  diagnostics,
  onOpenArtifactSettings,
  onOpenServiceLog,
  unmatchedTest,
  changes,
}: {
  detail: RunDetail
  view: ResultsView
  onViewChange: (view: ResultsView) => void
  selection: ResultsSelection
  onSelectionChange: (selection: ResultsSelection) => void
  diagnostics?: VerificationDiagnostics
  onOpenArtifactSettings?: () => void
  /** Opens a service's retained log at an excerpt's lines in the Services tab. */
  onOpenServiceLog?: (anchor: ServiceLogAnchor) => void
  /** A linked test this run's complete roster does not contain. */
  unmatchedTest?: string
  /** The run's captured repair, by repo — the fix a pull request ships. */
  changes?: { repos: number; onOpen: () => void }
}) {
  const m = detail.manifest
  const evidence = useMemo(() => buildRunEvidence({
    events: detail.playbackEvents,
    identity: detail.playbackIdentity,
    known: detail.summary?.knownTests,
    lifecycle: detail.lifecycleEvents,
  }), [detail.playbackEvents, detail.playbackIdentity, detail.summary?.knownTests, detail.lifecycleEvents])
  const numbers = useMemo(() => caseNumbers(evidence.cases, detail.summary?.knownTests), [evidence.cases, detail.summary?.knownTests])
  const open = view === 'tests' ? evidence.cases.find((c) => c.caseKey === selection.caseKey) : undefined
  return (
    <RunPane
      scroll={false}
      bar={
        <>
          {/* The same run either laid out per test or as the runner printed it. */}
          <Tab active={view === 'tests'} onClick={() => onViewChange('tests')} className="shrink-0 whitespace-nowrap">Formatted</Tab>
          <Tab active={view === 'terminal'} onClick={() => onViewChange('terminal')} className="shrink-0 whitespace-nowrap">Playwright</Tab>
          {changes && (
            <>
              <div className="min-w-2 flex-1" />
              {/* The results show what the repair proved; its changes are the
                  fix itself, one click away where they are reviewed and shipped. */}
              <button
                type="button"
                onClick={changes.onOpen}
                title="Every file the repair agent changed in this run, per repo — review it or open a pull request"
                className="cl-button mb-1 shrink-0 px-2 py-1 text-[11px] font-medium"
                data-testid="run-changes-button"
              >
                Changes · {changes.repos} {changes.repos === 1 ? 'repo' : 'repos'}
              </button>
            </>
          )}
        </>
      }
    >
      {view === 'terminal' && (
        <PaneTerminal runId={m.runId} paneId="playwright" emptyState={{ idle: EMPTY_COPY.panePlaywrightIdle, missing: EMPTY_COPY.panePlaywrightMissing }} />
      )}
      {view === 'tests' && (
        <div className="h-full overflow-y-auto scrollbar-thin" style={{ background: 'var(--bg-base)', scrollbarGutter: 'stable' }} data-testid="results-tests">
          {diagnostics && <VerificationDiagnosticsPanel diagnostics={diagnostics} />}
          {unmatchedTest && (
            <p className="mx-4 mb-0 mt-4 text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid="stale-test-link">
              This link names a test this run did not record ({unmatchedTest}). Pick a test below.
            </p>
          )}
          <CaseList cases={evidence.cases} numbers={numbers} openKey={open?.caseKey} onOpen={(c) => onSelectionChange({ caseKey: c.caseKey, test: caseTarget(c) })} />
          <UnplacedEvidence detail={detail} evidence={evidence} />
        </div>
      )}
      {open && (
        <TestResultDialog
          key={open.caseKey}
          detail={detail}
          evidence={evidence}
          caseEvidence={open}
          number={numbers.get(open.caseKey)}
          selection={selection}
          onSelectionChange={onSelectionChange}
          onClose={() => onSelectionChange({ caseKey: null })}
          onOpenServiceLog={onOpenServiceLog}
          onOpenArtifactSettings={onOpenArtifactSettings}
        />
      )}
    </RunPane>
  )
}

/** One row per test. A row opens that test's dialog; the list itself never
 *  expands, so it stays one line per test with every (!) mark in view. */
function CaseList({ cases, numbers, openKey, onOpen }: {
  cases: readonly CaseEvidence[]
  numbers: Map<string, number>
  openKey?: string
  onOpen: (c: CaseEvidence) => void
}) {
  const openRef = useRef<HTMLElement | null>(null)
  // Land on the opened case: a routed selection may sit below the fold, and
  // closing its dialog should leave the reader at that row.
  useEffect(() => {
    openRef.current?.scrollIntoView({ block: 'nearest' })
  }, [openKey])
  if (cases.length === 0) return <EmptyState {...EMPTY_COPY.playback} />
  return (
    <div className="flex flex-col gap-2 p-4 text-xs">
      {cases.map((c) => {
        const recovered = recoveredNote(c)
        return (
          <section
            key={c.caseKey}
            ref={c.caseKey === openKey ? openRef : undefined}
            className="cl-card overflow-hidden"
            data-testid="case-result"
            data-case-key={c.caseKey}
          >
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => onOpen(c)}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--bg-hover)]"
              style={{ background: 'var(--bg-elevated)' }}
            >
              <span aria-hidden="true" className="inline-flex shrink-0" style={{ color: 'var(--text-muted)' }}>
                <ChevronRightIcon />
              </span>
              <TestIdBadge n={numbers.get(c.caseKey)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium" style={{ color: 'var(--text-primary)' }} title={c.title}>{stripLeadingTestOrdinal(c.title)}</span>
                {c.location && <span className="block truncate text-[10.5px]" title={c.location} style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{shortSourceLocation(c.location)}</span>}
              </span>
              <span className="relative inline-flex shrink-0">
                <StepStatusBadge status={attemptStatus(c.latest)} {...badgeLabel(c.latest)} />
                {/* Pinned to the badge's corner like a notification mark; the
                    row's own background masks the badge border under it. */}
                {recovered && (
                  <Tooltip label={recovered}>
                    <span role="img" aria-label={recovered} data-testid="case-recovered" className="absolute -right-1.5 -top-1.5 inline-flex rounded-full text-warning" style={{ background: 'var(--bg-elevated)' }}><AlertCircleIcon size={11} /></span>
                  </Tooltip>
                )}
              </span>
            </button>
          </section>
        )
      })}
    </div>
  )
}

/** What the run kept that no test's dialog can show: files no test claimed
 *  and results outside every recorded execution. Rare, so it renders nothing at all unless one exists. */
function UnplacedEvidence({ detail, evidence }: { detail: RunDetail; evidence: RunEvidence }) {
  const unassigned = detail.unassignedArtifacts ?? []
  if (unassigned.length === 0 && evidence.unplacedAttempts.length === 0) return null
  return (
    <div className="px-4 pb-4">
      {unassigned.length > 0 && (
        <ArtifactList
          title="Artifacts no test claimed"
          testId="unassigned-artifacts"
          items={unassigned.map((a) => ({ artifact: a, meta: `execution ${a.execution} · ${a.kind}` }))}
        />
      )}
      {evidence.unplacedAttempts.length > 0 && (
        <section aria-label="Results outside a recorded execution" className="mt-3" data-testid="unplaced-attempts">
          <SectionHeader>Results outside a recorded execution</SectionHeader>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
            {evidence.unplacedAttempts.map((a) => (
              <li key={a.attemptKey} className="cl-card flex min-w-0 items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{stripLeadingTestOrdinal(a.title)}</span>
                {a.startedAt && <span className="text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{shortTime(a.startedAt)}</span>}
                <StepStatusBadge status={attemptStatus(a)} {...badgeLabel(a)} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function ArtifactList({ title, note, testId, items }: {
  title: string
  note?: string
  testId: string
  items: ReadonlyArray<{ artifact: PlaywrightArtifact; meta: string }>
}) {
  return (
    <section aria-label={title} className="mt-3" data-testid={testId}>
      <SectionHeader>{title}</SectionHeader>
      {note && <p className="mb-2 mt-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>{note}</p>}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {items.map(({ artifact, meta }) => (
          <li key={artifact.url} className="cl-card overflow-hidden">
            <a href={artifact.url} target="_blank" rel="noreferrer" className="block">
              <span className="block px-2 pt-1.5 text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{meta}</span>
              <ArtifactCaption artifact={artifact} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function badgeLabel(attempt: EvidenceAttempt | undefined): { label?: string } {
  const label = attemptLabel(attempt)
  return label ? { label } : {}
}

/** How a link names a case: its recorded name, and its location to tell apart
 *  two tests that share one. */
function caseTarget(c: CaseEvidence): NonNullable<ResultsSelection['test']> {
  return { name: c.name, ...(c.location ? { location: c.location } : {}) }
}
