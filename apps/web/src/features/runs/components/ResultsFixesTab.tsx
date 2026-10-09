import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { buildRunEvidence, type CaseEvidence, type EvidenceAttempt, type RunEvidence } from '@shared/run-evidence'
import type { RunDetail } from '@shared/run-detail'
import type { VerificationDiagnostics } from '@shared/verification'
import { shortSourceLocation } from '@shared/lib/source-location'
import { shortTime } from '@/shared/lib/format'
import { EmptyState } from '@/shared/ui/EmptyState'
import { EMPTY_COPY } from '@/shared/ui/empty-state-copy'
import { ChevronRightIcon, GearIcon } from '@/shared/ui/Icons'
import { Tab } from '@/shared/ui/Tab'
import { StepStatusBadge } from '@/shared/ui/TestCodeBlock'
import { TestIdBadge } from '@/shared/ui/TestIdBadge'
import { stripLeadingTestOrdinal } from '@/shared/test-numbering'
import { attemptStatus, caseNumbers, cycleOptions, resolveCycleChoice, type CycleChoice, type ResultsSelection } from '../utils/results-fixes'
import { ChangesTab } from './ChangesTab'
import { JournalTab } from './JournalTab'
import { PaneTerminal } from './PaneTerminal'
import { RepairStory } from './RepairStory'
import { VerificationDiagnosticsPanel } from './RunDiagnosticsPanels'
import { ArtifactCaption, SectionHeader } from './RunPlaybackPanels'
import { RunPane } from './RunPane'

export type ResultsView = 'tests' | 'run-wide' | 'terminal'

/**
 * Results & Fixes: every recorded test with the repair cycles it went through,
 * one accordion row per case, plus the run's raw evidence — the captured
 * changes and full journal that belong to no single test, and the Playwright
 * terminal. Everything is projected from the run detail the runs WebSocket
 * pushes, so an update re-renders the open view in place; the reader's
 * selection is owned by the caller so it survives a tab switch.
 */
export function ResultsFixesTab({
  detail,
  view,
  onViewChange,
  selection,
  onSelectionChange,
  repairEvidence,
  diagnostics,
  onOpenArtifactSettings,
  serviceLogs,
}: {
  detail: RunDetail
  view: ResultsView
  onViewChange: (view: ResultsView) => void
  selection: ResultsSelection
  onSelectionChange: (selection: ResultsSelection) => void
  /** False for a verify run: it never repairs, so it has no run-wide captures. */
  repairEvidence: boolean
  diagnostics?: VerificationDiagnostics
  onOpenArtifactSettings?: () => void
  serviceLogs?: (caseEvidence: CaseEvidence, attempt: EvidenceAttempt, cycle: CycleChoice) => ReactNode
}) {
  const m = detail.manifest
  const evidence = useMemo(() => buildRunEvidence({
    events: detail.playbackEvents,
    identity: detail.playbackIdentity,
    known: detail.summary?.knownTests,
    lifecycle: detail.lifecycleEvents,
  }), [detail.playbackEvents, detail.playbackIdentity, detail.summary?.knownTests, detail.lifecycleEvents])
  return (
    <RunPane
      scroll={false}
      bar={
        <>
          <Tab active={view === 'tests'} onClick={() => onViewChange('tests')} className="shrink-0 whitespace-nowrap">Tests</Tab>
          {repairEvidence && <Tab active={view === 'run-wide'} onClick={() => onViewChange('run-wide')} className="shrink-0 whitespace-nowrap">Run-wide</Tab>}
          <Tab active={view === 'terminal'} onClick={() => onViewChange('terminal')} className="shrink-0 whitespace-nowrap">Terminal</Tab>
          {onOpenArtifactSettings && (
            <>
              <div className="min-w-2 flex-1" />
              <button
                type="button"
                onClick={onOpenArtifactSettings}
                title="Choose which Playwright artifacts this suite keeps — screenshots, video, trace"
                className="cl-button mb-1 inline-flex shrink-0 items-center gap-1.5 px-2 py-1 text-[11px] font-medium"
              >
                <GearIcon size={11} />
                Artifact settings
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
          <CaseAccordion
            detail={detail}
            evidence={evidence}
            selection={selection}
            onSelectionChange={onSelectionChange}
            onOpenRunWide={repairEvidence ? () => onViewChange('run-wide') : undefined}
            serviceLogs={serviceLogs}
          />
        </div>
      )}
      {view === 'run-wide' && repairEvidence && <RunWideEvidence detail={detail} evidence={evidence} />}
    </RunPane>
  )
}

function CaseAccordion({ detail, evidence, selection, onSelectionChange, onOpenRunWide, serviceLogs }: {
  detail: RunDetail
  evidence: RunEvidence
  selection: ResultsSelection
  onSelectionChange: (selection: ResultsSelection) => void
  onOpenRunWide?: () => void
  serviceLogs?: (caseEvidence: CaseEvidence, attempt: EvidenceAttempt, cycle: CycleChoice) => ReactNode
}) {
  const numbers = useMemo(() => caseNumbers(evidence.cases, detail.summary?.knownTests), [evidence.cases, detail.summary?.knownTests])
  const openRef = useRef<HTMLElement | null>(null)
  // Land on the opened case: a routed or clicked selection may sit below the fold.
  useEffect(() => {
    openRef.current?.scrollIntoView({ block: 'start' })
  }, [selection.caseKey])
  if (evidence.cases.length === 0) return <EmptyState {...EMPTY_COPY.playback} />
  return (
    <div className="flex flex-col gap-2 p-4 text-xs">
      {evidence.cases.map((c) => {
        const open = selection.caseKey === c.caseKey
        const status = attemptStatus(c.latest)
        const bodyId = `case-body-${encodeURIComponent(c.caseKey)}`
        return (
          <section
            key={c.caseKey}
            ref={open ? openRef : undefined}
            className="cl-card overflow-hidden"
            data-testid="case-result"
            data-case-key={c.caseKey}
            {...(open ? { 'data-open': '' } : {})}
            style={open ? { borderColor: 'var(--accent)' } : undefined}
          >
            <button
              type="button"
              aria-expanded={open}
              aria-controls={open ? bodyId : undefined}
              onClick={() => onSelectionChange(open ? { caseKey: null } : { caseKey: c.caseKey })}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--bg-hover)]"
              style={{ background: 'var(--bg-elevated)', borderBottom: open ? '1px solid var(--border-default)' : undefined }}
            >
              <span aria-hidden="true" className="inline-flex shrink-0 transition-transform duration-150" style={{ transform: open ? 'rotate(90deg)' : undefined, color: 'var(--text-muted)' }}>
                <ChevronRightIcon />
              </span>
              <TestIdBadge n={numbers.get(c.caseKey)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium" style={{ color: 'var(--text-primary)' }} title={c.title}>{stripLeadingTestOrdinal(c.title)}</span>
                {c.location && <span className="block truncate text-[10.5px]" title={c.location} style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{shortSourceLocation(c.location)}</span>}
              </span>
              <StepStatusBadge status={status} {...(c.latest ? {} : { label: 'not run' })} />
            </button>
            {open && (
              <div id={bodyId} className="p-3" style={{ background: 'var(--bg-base)' }}>
                <CaseBody
                  detail={detail}
                  evidence={evidence}
                  caseEvidence={c}
                  requested={selection.cycle}
                  onChoose={(cycle) => onSelectionChange({ caseKey: c.caseKey, cycle })}
                  onOpenRunWide={onOpenRunWide}
                  serviceLogs={serviceLogs}
                />
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function CaseBody({ detail, evidence, caseEvidence, requested, onChoose, onOpenRunWide, serviceLogs }: {
  detail: RunDetail
  evidence: RunEvidence
  caseEvidence: CaseEvidence
  requested?: CycleChoice
  onChoose: (cycle: CycleChoice) => void
  onOpenRunWide?: () => void
  serviceLogs?: (caseEvidence: CaseEvidence, attempt: EvidenceAttempt, cycle: CycleChoice) => ReactNode
}) {
  const options = cycleOptions(caseEvidence)
  const choice = resolveCycleChoice(caseEvidence, requested)
  const selectId = `cycle-${encodeURIComponent(caseEvidence.caseKey)}`
  return (
    <>
      {options.length > 0 ? (
        <div className="mb-3 flex min-w-0 items-center gap-3">
          <label htmlFor={selectId} className="shrink-0 text-[11.5px] font-medium" style={{ color: 'var(--text-primary)' }}>Repair cycle</label>
          <select
            id={selectId}
            className="themed-select cl-input min-w-0 flex-1 px-2 py-1 text-xs"
            value={String(choice)}
            onChange={(e) => onChoose(e.target.value === 'initial' ? 'initial' : Number(e.target.value))}
          >
            {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
          </select>
        </div>
      ) : caseEvidence.latest && (
        <p className="mb-3 mt-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>No repair cycle addressed this test.</p>
      )}
      <RepairStory
        key={`${caseEvidence.caseKey}:${choice}`}
        runId={detail.runId}
        feature={detail.manifest.feature}
        evidence={evidence}
        caseEvidence={caseEvidence}
        choice={choice}
        media={detail}
        policy={detail.manifest.playwrightArtifacts}
        onOpenRunWide={onOpenRunWide}
        {...(serviceLogs ? { serviceLogs: (attempt: EvidenceAttempt) => serviceLogs(caseEvidence, attempt, choice) } : {})}
      />
    </>
  )
}

/**
 * Evidence that belongs to the run rather than one test: the cumulative
 * captured changes (and their PR actions), the whole journal, retained files no
 * attempt claimed, and results recorded outside any known execution. Reachable
 * with no test selected, so nothing the old Changes and Journal tabs showed is
 * lost in the merge.
 */
function RunWideEvidence({ detail, evidence }: { detail: RunDetail; evidence: RunEvidence }) {
  const m = detail.manifest
  const unassigned = detail.unassignedArtifacts ?? []
  return (
    <div className="h-full overflow-y-auto p-4 scrollbar-thin" style={{ scrollbarGutter: 'stable' }} data-testid="results-run-wide">
      <section aria-label="Captured changes">
        <SectionHeader>Captured changes · whole run</SectionHeader>
        <ChangesTab
          framed={false}
          runId={m.runId}
          healCycles={m.healCycles}
          run={m}
          fixCapture={m.fixCapture}
          worktrees={m.worktrees}
          proposedPrs={m.proposedPrs}
          prAttempt={m.prAttempt}
          repoBranches={m.repoBranches ?? []}
        />
      </section>
      <section aria-label="Repair journal" className="mt-5">
        <SectionHeader>Repair journal · every cycle</SectionHeader>
        <JournalTab framed={false} feature={m.feature} runId={m.runId} healCycles={m.healCycles} />
      </section>
      {unassigned.length > 0 && (
        <section aria-label="Unassigned artifacts" className="mt-5" data-testid="unassigned-artifacts">
          <SectionHeader>Artifacts no test claimed</SectionHeader>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {unassigned.map((a) => (
              <li key={a.path} className="cl-card overflow-hidden">
                <a href={a.url} target="_blank" rel="noreferrer" className="block">
                  <span className="block px-2 pt-1.5 text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>execution {a.execution} · {a.kind}</span>
                  <ArtifactCaption artifact={a} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {evidence.unplacedAttempts.length > 0 && (
        <section aria-label="Results outside a recorded execution" className="mt-5" data-testid="unplaced-attempts">
          <SectionHeader>Results outside a recorded execution</SectionHeader>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
            {evidence.unplacedAttempts.map((a) => (
              <li key={a.attemptKey} className="cl-card flex min-w-0 items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{stripLeadingTestOrdinal(a.title)}</span>
                {a.startedAt && <span className="text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{shortTime(a.startedAt)}</span>}
                <StepStatusBadge status={attemptStatus(a)} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
