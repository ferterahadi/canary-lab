import { useCallback, useMemo, useState, type ReactNode } from 'react'
import * as api from '../api/client'
import type { ExecutionType, Feature, RunIndexEntry, RunStatus, VersionStatus } from '../api/types'
import { useMcpPromo } from './McpPromoContext'
import { SettingsModal } from '@/features/config'
import { FeatureChipBadge, FlightStatusChip, presentActivityRunStatus, readGroupOpen, writeGroupOpen, type FeatureActivity, type FeatureFlightAction } from '@/features/flights'
import { SPEC_TONE, featureTone, presentRunStatus, type RunWaitingState } from '@/features/runs'
import { ThemeToggle } from '../ui/ThemeToggle'
import { Chip } from '../ui/StatusChip'
import { VersionUpdateButton } from './VersionUpdateButton'
import { ChevronRightIcon, StatusDot } from '@/shared/ui/atoms'
import { shortDateTime } from '../lib/format'
import { Tooltip } from '../ui/Tooltip'
import { useLiveCoverageStates } from '../state/use-live-coverage'
import type { ModelsAgent } from '../lib/workspace-view-state'

interface Props {
  features: Feature[]
  selectedFeature: string | null
  activity?: Map<string, FeatureActivity>
  /** Each suite's last finished test run (passed/failed/aborted), for the row's
   *  leading dot. Absent for a suite that has never run. */
  lastRuns?: ReadonlyMap<string, RunIndexEntry>
  /** Feature whose run is currently active (running or healing), or null. */
  activeRunFeature?: string | null
  /** Status of that active run — drives the chip label/color. */
  activeRunStatus?: RunStatus | null
  /** Execution type of that active run — a `boot` run gets the teal
   *  "services up" treatment instead of the running/healing tint. */
  activeRunExecutionType?: ExecutionType | null
  activeRunWaiting?: RunWaitingState
  onReviewFeature?: (name: string) => void
  onSelectFeature: (name: string) => void
  onOpenConfig: (feature: string) => void
  /** Opens the Requirement Coverage ledger when generation is not active in Flight. */
  onOpenCoverage?: (feature: string) => void
  /** Opens the new-flight dialog (intent + repo picker) — the "+ New" action.
   *  Flight is the only GUI path to a new feature (R40/R50). */
  onStartNewFlight?: () => void
  /** Opens the routed flight view — a pending (pre-scaffold) placeholder row
   *  has no feature dir to select, so clicking it resumes its flight instead.
   *  Also the destination of the per-row flight shortcut below. */
  onOpenFlight?: (flightId: string) => void
  /** The row's hover flight shortcut: where this suite's flight lives and what
   *  state it's in, or null when there's nothing to open yet (see
   *  `resolveFeatureFlightAction`). Omitting the prop drops the action. */
  flightAction?: (feature: string) => FeatureFlightAction | null
  /** Current-vs-latest version + self-update job state. Drives the footer
   *  "update available" indicator; null until the registry check resolves. */
  versionStatus?: VersionStatus | null
  /** Project Settings is route-driven (`?dialog=settings`) when these are
   *  supplied — controlled by App. Omitted (e.g. in unit tests) → the column
   *  falls back to its own internal open-state. Same hybrid the runs column's
   *  Verify dialog uses. */
  settingsOpen?: boolean
  onSettingsOpenChange?: (open: boolean) => void
  /** The model matrix stacked over settings (`?models=…`) — controlled by App
   *  alongside settingsOpen; omitted → SettingsModal's own internal state. */
  modelsFor?: ModelsAgent | null
  onModelsFor?: (agent: ModelsAgent | null) => void
}

// Colour the Coverage icon by the derived headline (R8). Neutral (inherit) for
// setup-needed / no-coverage / unknown so the column stays calm until there's
// real signal; green when mapped, amber when stale, sky while generating.
function coverageHeadlineColor(headline: string | null | undefined): string | undefined {
  if (!headline) return undefined
  if (headline === 'Generating') return 'var(--running)'
  if (headline.startsWith('Mapped') || headline.startsWith('Covered')) return 'var(--success)'
  if (headline === 'Freshness unconfirmed') return 'var(--warning)'
  if (headline === 'Stale') return 'var(--warning)'
  return undefined
}

// R55: the features column groups features that declare a `group` under one
// collapsible accordion, mirroring the flights picker's disclosure treatment.
// Open-state persists per group in localStorage (its own key; same shape as the
// flights picker's map). Default OPEN.
const FEATURE_GROUPS_OPEN_STORAGE_KEY = 'cl-feature-groups-open'

/** Suites keep a fixed place: a run, dirty tests, or a parked flight shows on
 *  the row's own badge and never moves the row or its group. */
const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

export interface FeatureGroupSection {
  group: string
  features: Feature[]
}

/** Split features into the flat top-level bucket (no group) + one section per
 *  group (R55). Sections order by group name and rows by suite name. A
 *  blank/whitespace group is treated as ungrouped. */
export function groupFeatures(
  features: Feature[],
): { ungrouped: Feature[]; groups: FeatureGroupSection[] } {
  const ungrouped: Feature[] = []
  const byGroup = new Map<string, Feature[]>()
  for (const f of [...features].sort((a, b) => byName(a.name, b.name))) {
    const group = f.group?.trim()
    if (!group) { ungrouped.push(f); continue }
    const bucket = byGroup.get(group) ?? []
    bucket.push(f)
    byGroup.set(group, bucket)
  }
  const groups: FeatureGroupSection[] = [...byGroup.entries()]
    .map(([group, groupFeatures]) => ({ group, features: groupFeatures }))
    .sort((a, b) => byName(a.group, b.group))
  return { ungrouped, groups }
}

export function FeaturesColumn({
  features,
  selectedFeature,
  activity,
  lastRuns,
  activeRunFeature,
  activeRunStatus,
  activeRunExecutionType,
  activeRunWaiting,
  onSelectFeature,
  onReviewFeature,
  onOpenConfig,
  onOpenCoverage,
  onStartNewFlight,
  onOpenFlight,
  flightAction,
  versionStatus,
  settingsOpen,
  onSettingsOpenChange,
  modelsFor,
  onModelsFor,
}: Props) {
  const { gatePromo } = useMcpPromo()
  // Controlled when App drives it from the route; uncontrolled otherwise.
  const [settingsOpenInternal, setSettingsOpenInternal] = useState(false)
  const settingsDialogOpen = settingsOpen ?? settingsOpenInternal
  const setSettingsDialogOpen = useCallback((open: boolean) => {
    if (onSettingsOpenChange) onSettingsOpenChange(open)
    else setSettingsOpenInternal(open)
  }, [onSettingsOpenChange])
  // Per-feature coverage headline → colours the column's Coverage icon (R8).
  // Workspace events plus bounded reconciliation keep source changes live.
  // Failed reads or an expired freshness lease withdraw the previous badge.
  // The effect only asks *whether* coverage is reachable, never calls the handler.
  // Depending on the callback itself made every App re-render refetch the same
  // workspace status index — App passes a fresh arrow each render. The server
  // scan is lightweight now, but duplicate requests are still needless work.
  const canOpenCoverage = Boolean(onOpenCoverage)
  const coverage = useLiveCoverageStates(canOpenCoverage ? features.map((feature) => feature.name) : null)
  const coverageHeadlines = useMemo(() => Object.fromEntries((coverage.value ?? []).map((state) => [state.feature,
    coverage.confirmed ? state.headline : 'Freshness unconfirmed'])), [coverage.value, coverage.confirmed])

  // R55: features declaring a `group` collapse under an accordion; the rest
  // stay flat. Everything sorts by name so a row never jumps.
  const { ungrouped, groups } = groupFeatures(features)
  const renderFeatureRow = (feature: Feature): ReactNode => (
    <FeatureRow
      key={feature.name}
      feature={feature}
      selectedFeature={selectedFeature}
      activity={activity?.get(feature.name)}
      lastRun={lastRuns?.get(feature.name)}
      activeRunFeature={activeRunFeature}
      activeRunStatus={activeRunStatus}
      activeRunExecutionType={activeRunExecutionType}
      activeRunWaiting={activeRunWaiting}
      coverageHeadline={coverageHeadlines[feature.name]}
      onSelectFeature={onSelectFeature}
      onReviewFeature={onReviewFeature}
      onOpenCoverage={onOpenCoverage}
      onOpenFlight={onOpenFlight}
      flightAction={flightAction}
      onConfigure={onOpenConfig}
    />
  )

  return (
    <div className="cl-panel flex h-full flex-col">
      <div className="cl-panel-header cl-column-header flex items-center justify-between gap-2 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="cl-kicker">Suites</span>
          {features.length > 0 && <span className="cl-count-chip">{features.length}</span>}
        </div>
        <button
          type="button"
          onClick={() => gatePromo('create-feature', () => onStartNewFlight?.())}
          className="cl-button shrink-0 whitespace-nowrap px-2.5"
          title="Start a flight on new repos"
        >
          + New
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 py-2" style={{ scrollbarGutter: 'stable' }}>
        {features.length === 0 ? (
          <div className="px-2 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>No suites detected.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {ungrouped.length > 0 && (
              <ul className="flex flex-col gap-1">
                {ungrouped.map(renderFeatureRow)}
              </ul>
            )}
            {groups.map((section) => (
              <FeatureGroupAccordion
                key={section.group}
                section={section}
                renderRow={renderFeatureRow}
              />
            ))}
          </div>
        )}
      </div>
      <div className="cl-panel-footer flex items-center justify-between p-2">
        <ThemeToggle />
        <div className="flex items-center gap-1">
          <VersionUpdateButton status={versionStatus ?? null} />
          <button
          type="button"
          onClick={() => setSettingsDialogOpen(true)}
          aria-label="Open settings"
          title="Settings"
          className="cl-icon-button h-7 w-7"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          </button>
        </div>
      </div>
      {settingsDialogOpen && (
        <SettingsModal
          onClose={() => setSettingsDialogOpen(false)}
          {...(modelsFor === undefined ? {} : { modelsFor })}
          {...(onModelsFor ? { onModelsFor } : {})}
        />
      )}

    </div>
  )
}

/** One feature `<li>` — extracted so the flat top-level list and the group
 *  accordions render the identical row (R55). Same markup + testids as before
 *  the accordion split. */
function FeatureRow({
  feature: f,
  selectedFeature,
  activity,
  lastRun,
  activeRunFeature,
  activeRunStatus,
  activeRunExecutionType,
  activeRunWaiting,
  coverageHeadline,
  onSelectFeature,
  onReviewFeature,
  onOpenCoverage,
  onOpenFlight,
  flightAction,
  onConfigure,
}: {
  feature: Feature
  selectedFeature: string | null
  activity?: FeatureActivity
  lastRun?: RunIndexEntry
  activeRunFeature?: string | null
  activeRunStatus?: RunStatus | null
  activeRunExecutionType?: ExecutionType | null
  activeRunWaiting?: RunWaitingState
  coverageHeadline?: string | null
  onReviewFeature?: (name: string) => void
  onSelectFeature: (name: string) => void
  onOpenCoverage?: (feature: string) => void
  onOpenFlight?: (flightId: string) => void
  flightAction?: (feature: string) => FeatureFlightAction | null
  onConfigure: (feature: string) => void
}) {
  // A pending placeholder (First-Flight batch, pre-scaffold) has no feature dir
  // to select or configure — render it muted with its flight's status chip;
  // clicking the row resumes the flight.
  if (f.pending) return <PendingFeatureRow feature={f} onOpenFlight={onOpenFlight} />
  const isSelected = f.name === selectedFeature
  const tone = featureTone(f)
  const activityRunPresentation = presentActivityRunStatus(activity)
  const isActive = activityRunPresentation != null || (!activity && Boolean(activeRunFeature) && f.name === activeRunFeature)
  const runWaiting = activityRunPresentation ? activity?.waiting : activeRunWaiting
  const runPresentation = activityRunPresentation
    ?? (isActive ? presentRunStatus({ status: activeRunStatus ?? 'running', executionType: activeRunExecutionType, waiting: runWaiting }) : null)
  const runState = activityRunPresentation && activity
    ? activity.waiting?.kind === 'queued' ? 'queued' : activity.kind === 'healing' ? 'healing' : 'running'
    : isActive ? activeRunStatus === 'running' && activeRunExecutionType === 'boot' ? 'booted' : activeRunStatus ?? 'running' : null
  const runCue = !runState || runState === 'queued'
    ? ''
    : runWaiting
      ? ' cl-list-row-waiting'
      : runState ? ` cl-list-row-${runState}` : ''
  // The Review action carries modified-test attention while an execution cue
  // owns the row colour. Without this guard the later neutral CSS wash masks a
  // live or waiting run and makes the suite read as idle.
  const rowCue = tone && !runCue ? ' cl-list-row-changed' : ''
  // The hover shortcut to this suite's flight — absent for a suite nothing has
  // touched yet (starting stays with "+ New" / the picker, per R40), and absent
  // without a destination handler. Resolved once so the reserved width below
  // can't disagree with what actually renders.
  const flight = onOpenFlight ? flightAction?.(f.name) ?? null : null
  // A flight moving through this suite gets the column's quietest treatment: a
  // bare wash plus its status chip at rest, no ring and no motion (the hover-only
  // paper-plane icon was the ONLY cue before, so a suite mid-flight read as idle).
  // A resting/finished flight gets nothing — every flown suite carrying a
  // permanent tint would make the column noise again.
  const inFlight = Boolean(flight?.live || flight?.attention)
  const showFlightChip = (inFlight || flight?.queued === true) && flight != null
  const showRunChip = !showFlightChip && runPresentation != null
  // The action cluster FLOATS over the row's right edge instead of sitting in
  // flow, so three icons cost the suite name zero width at rest — in a column
  // of long `cns_*` names that width is the column's actual content. The name
  // only makes room (padding-right) while the row is hovered/focused, so
  // nothing ever moves: the ellipsis just lands earlier. Width is computed from
  // the visible count so a 1-action row doesn't reserve space for three.
  const actionCount = 1 + (onOpenCoverage ? 1 : 0) + (flight ? 1 : 0)
  // The at-rest status chip already sits in flow at that same right edge, so it
  // has ALREADY cost the name its width — reserving the full cluster on top of it
  // left an in-flight row with ~18px of readable name on hover (204px row − 72px
  // chip − 100px reservation). Subtract what the chip yields; the cluster floats
  // over the chip's box as it fades, so the icons still land clear of the text.
  const chipWidth = showFlightChip ? (flight?.chipWidth ?? 72) + 6 : showRunChip ? (runPresentation?.chipWidth ?? 72) + 6 : 0
  const actionsWidth = Math.max(0, actionCount * 28 + (actionCount - 1) * 2 + 12 - chipWidth)
  return (
    <li
      className={`feature-row group cl-list-row text-sm${isSelected ? ' cl-list-row-selected' : ''}${inFlight ? (flight?.attention ? ' cl-list-row-inflight-attention' : ' cl-list-row-inflight') : ''}${runCue}${rowCue}`}
      style={{
        // An in-flight suite reads at full text contrast like a selected one: at 6%
        // the wash alone is nearly invisible on the dark theme, so the brighter
        // name does as much of the work as the tint.
        color: isSelected || inFlight || Boolean(runCue) ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontWeight: isSelected ? 500 : 400,
        ['--feature-row-actions' as string]: `${actionsWidth}px`,
      }}
      title={showFlightChip ? flight?.title : runPresentation?.title}
    >
      <LastRunDot feature={f.name} run={lastRun} />
      {tone && (
        <Tooltip label={`${SPEC_TONE[tone].title} Click to review.`}>
          <button type="button" onClick={() => { onSelectFeature(f.name); onReviewFeature?.(f.name) }}
            aria-label={`Review test changes in ${f.name}`}
            data-testid={`dirty-badge-${f.name}`}
            data-tone={tone}
            className="ml-1.5 flex h-4 w-4 shrink-0 items-center justify-center self-center rounded"
            style={{
              color: 'var(--warning)',
              background: 'color-mix(in srgb, var(--warning) 14%, transparent)',
            }}
          >
            {/* A file with a +/− — "the tests changed", in a 16px box. */}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 3v4a1 1 0 0 0 1 1h4" />
              <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
              <path d="M12 10v4M10 12h4M10 17h4" />
            </svg>
          </button>
        </Tooltip>
      )}
      <button
        type="button"
        onClick={() => onSelectFeature(f.name)}
        title={f.name}
        className="feature-row__name flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-2 text-left"
        style={{ color: 'inherit', fontWeight: 'inherit' }}
      >
        <span className="min-w-0 truncate">{f.name}</span>
        {/* A capability, not a status — so it trails the name in muted text
            rather than wearing the success hue beside the last-run dot. */}
        {f.portified && (
          <Tooltip label="Ready for parallel runs.">
            <span
              aria-label="Portified"
              data-testid={`portified-badge-${f.name}`}
              className="shrink-0 text-[11px] leading-none"
              style={{ color: 'var(--text-muted)' }}
            >
              ⇄
            </span>
          </Tooltip>
        )}
      </button>
      {showRunChip && runPresentation && (
        <span className="feature-row__status-chip mr-1.5 shrink-0 self-center" aria-label={runPresentation.label}>
          <Chip testId={runWaiting ? `run-waiting-${f.name}` : undefined} tone={runPresentation.tone} background={runPresentation.background} chrome="fill" label={runPresentation.label} width={runPresentation.chipWidth ?? 72} uppercase fontSize={10} title={runPresentation.title} />
        </span>
      )}
      {showFlightChip && flight && (
        /* In flow, not floating — it keeps its box while fading under the hover
           action cluster, so the row can't reflow as the pointer arrives. */
        <span className="feature-row__status-chip mr-1.5 shrink-0 self-center" data-testid={`flight-chip-${f.name}`}>
          <FeatureChipBadge chip={flight} />
        </span>
      )}
      <span className="feature-row__actions">
        {flight && (
          /* Reads state, not just destination: "Flight · to approve" beats a bare
             "Flight" when the point of coming here is to find out. */
          <Tooltip label={`Flight · ${flight.label}`}>
            <button
              type="button"
              onClick={() => { onSelectFeature(f.name); onOpenFlight?.(flight.flightId) }}
              aria-label={`Open flight for ${f.name} — ${flight.title}`}
              data-testid={`flight-shortcut-${f.name}`}
              data-flight-id={flight.flightId}
              className="cl-icon-button h-7 w-7 shrink-0"
              /* The flight chip's own hue — green done, sky running, amber
                 needs-you — so the icon carries the state it jumps to. A
                 resting `idle` tone is the neutral secondary text colour, which
                 is exactly the calm the column wants. */
              style={{ color: flight.tone }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4Z" />
              </svg>
            </button>
          </Tooltip>
        )}
        {onOpenCoverage && (
          <Tooltip label={coverageHeadline === 'Generating' ? 'Coverage · updating' : 'Coverage'}>
            <button
              type="button"
              onClick={() => { onSelectFeature(f.name); onOpenCoverage(f.name) }}
              aria-label={`Open coverage for ${f.name}`}
              data-testid={`coverage-action-${f.name}`}
              data-headline={coverageHeadline ?? ''}
              className="cl-icon-button h-7 w-7 shrink-0"
              style={{ color: coverageHeadlineColor(coverageHeadline) }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="4.5" />
                <circle cx="12" cy="12" r="0.6" fill="currentColor" />
              </svg>
            </button>
          </Tooltip>
        )}
        <Tooltip label="Config">
          <button
            type="button"
            onClick={() => onConfigure(f.name)}
            aria-label={`Configure ${f.name}`}
            className="cl-icon-button h-7 w-7 shrink-0"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </Tooltip>
      </span>
    </li>
  )
}

/** The suite's last finished run as one dot, in a slot every row reserves so
 *  names line up whether or not a suite has run. A live run keeps showing the
 *  previous result; the chip on the right says what is happening now. A pass
 *  that needed repair cycles wears a ring: it is a different story from a
 *  clean pass. */
function LastRunDot({ feature, run }: { feature: string; run?: RunIndexEntry }) {
  if (!run) return <span aria-hidden="true" className="ml-2 w-[0.55rem] shrink-0" />
  const cycles = run.status === 'passed' ? run.healCycles ?? 0 : 0
  const outcome = cycles > 0 ? `passed after ${cycles} repair cycle${cycles === 1 ? '' : 's'}` : run.status
  const label = [`Last run ${outcome}`, shortDateTime(run.endedAt ?? run.startedAt), run.env].filter(Boolean).join(' · ')
  return (
    <Tooltip label={label}>
      <span
        role="img"
        aria-label={label}
        data-testid={`last-run-${feature}`}
        data-status={cycles > 0 ? 'repaired' : run.status}
        className="ml-2 flex shrink-0 self-center"
      >
        <StatusDot
          state={run.status === 'passed' ? 'success' : run.status === 'failed' ? 'failed' : 'idle'}
          className={cycles > 0 ? 'outline outline-1 outline-offset-[1.5px] outline-success' : ''}
        />
      </span>
    </Tooltip>
  )
}

/** A collapsible feature-group section (R55): chevron + group name + count;
 *  the group's rows render under the disclosure. Open-state persists per group
 *  in localStorage (own key), default OPEN — mirrors the flights picker's
 *  disclosure. */
function FeatureGroupAccordion({
  section,
  renderRow,
}: {
  section: FeatureGroupSection
  renderRow: (feature: Feature) => ReactNode
}) {
  const { group } = section
  const [open, setOpen] = useState(() => readGroupOpen(FEATURE_GROUPS_OPEN_STORAGE_KEY, group))
  const toggle = (): void => setOpen((v) => { const next = !v; writeGroupOpen(FEATURE_GROUPS_OPEN_STORAGE_KEY, group, next); return next })
  return (
    <section data-testid={`feature-group-${group}`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        data-testid={`feature-group-toggle-${group}`}
        className="cl-hover-row flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
      >
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 transition-transform duration-150"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'none' }}
        >
          <ChevronRightIcon />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          {group}
        </span>
        <span className="cl-count-chip shrink-0">{section.features.length}</span>
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-1 pl-4">
          {section.features.map(renderRow)}
        </ul>
      )}
    </section>
  )
}

/** A placeholder row for a First-Flight batch feature whose flight is queued or
 *  running but hasn't scaffolded `feature.config.cjs` yet (R69). Muted and
 *  cog-less — there's no config/coverage to open — it carries the flight's live
 *  status chip and resumes the flight on click, so a just-launched batch shows
 *  in the ledger immediately and the user can pick up from where they left off. */
function PendingFeatureRow({
  feature: f,
  onOpenFlight,
}: {
  feature: Feature
  onOpenFlight?: (flightId: string) => void
}) {
  const pending = f.pending
  if (!pending) return null
  return (
    <li
      className="feature-row group cl-list-row text-sm"
      data-testid={`pending-feature-${f.name}`}
      style={{ color: 'var(--text-muted)' }}
    >
      {/* Holds the last-run slot so the name lines up with its neighbours. */}
      <span aria-hidden="true" className="ml-2 w-[0.55rem] shrink-0" />
      <button
        type="button"
        onClick={() => onOpenFlight?.(pending.flightId)}
        title={`${f.name} — setting up; open the flight`}
        className="min-w-0 flex-1 truncate rounded-md px-2 py-2 text-left"
        style={{ color: 'inherit' }}
      >
        {f.name}
      </button>
      <span className="mr-1.5 shrink-0 self-center">
        <FlightStatusChip flight={pending} />
      </span>
    </li>
  )
}
