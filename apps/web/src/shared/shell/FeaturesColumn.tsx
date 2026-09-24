import { useCallback, useMemo, useState, type ReactNode } from 'react'
import * as api from '../api/client'
import type { ExecutionType, Feature, RunStatus, VersionStatus } from '../api/types'
import { useMcpPromo } from './McpPromoContext'
import { SettingsModal } from '@/features/config'
import { FeatureChipBadge, FlightStatusChip, flightAwaitsUser, readGroupOpen, writeGroupOpen, type FeatureFlightAction } from '@/features/flights'
import { SPEC_TONE, featureTone, type RunWaitingState } from '@/features/runs'
import { ThemeToggle } from '../ui/ThemeToggle'
import { Chip } from '../ui/StatusChip'
import { VersionUpdateButton } from './VersionUpdateButton'
import { ChevronRightIcon } from '@/shared/ui/atoms'
import { Tooltip } from '../ui/Tooltip'
import { useLiveCoverageStates } from '../state/use-live-coverage'
import type { ModelsAgent } from '../lib/workspace-view-state'

interface Props {
  features: Feature[]
  selectedFeature: string | null
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
// real signal; green when mapped, amber when stale. Generating belongs to the
// Flight shortcut, so the Coverage action is absent in that state.
function coverageHeadlineColor(headline: string | null | undefined): string | undefined {
  if (!headline) return undefined
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

/** Attention rank for a feature row — worst floats to the top (0 = needs the
 *  human most). An active run outranks a dirty-tests flag outranks a resting
 *  row; groups order by their worst member so a group with a running/dirty
 *  feature sorts above a calm one. */
function featureRowRank(
  f: Feature,
  activeRunFeature: string | null | undefined,
): number {
  if (activeRunFeature && f.name === activeRunFeature) return 0
  if (f.dirty?.status === 'dirty') return 1
  // A pending placeholder parked on approval needs the human — it ranks with
  // dirty; otherwise it rests with a settled feature so the column stays calm.
  // A hand-off to the user's own agent asks nothing of this reader, so it rests
  // too — floating it to the top would nag about work already under way.
  if (f.pending) return flightAwaitsUser(f.pending) ? 1 : 2
  return 2
}

export interface FeatureGroupSection {
  group: string
  features: Feature[]
  /** The worst (lowest) row rank in the group — orders the sections. */
  worstRank: number
}

/** Split features into the flat top-level bucket (no group) + one section per
 *  group (R55). Rows keep their incoming order within each section; sections
 *  order by their worst member, then group name. A blank/whitespace group is
 *  treated as ungrouped. */
export function groupFeatures(
  features: Feature[],
  activeRunFeature: string | null | undefined,
): { ungrouped: Feature[]; groups: FeatureGroupSection[] } {
  const ungrouped: Feature[] = []
  const byGroup = new Map<string, Feature[]>()
  for (const f of features) {
    const group = f.group?.trim()
    if (!group) { ungrouped.push(f); continue }
    const bucket = byGroup.get(group) ?? []
    bucket.push(f)
    byGroup.set(group, bucket)
  }
  const groups: FeatureGroupSection[] = [...byGroup.entries()].map(([group, groupFeatures]) => ({
    group,
    features: groupFeatures,
    worstRank: Math.min(...groupFeatures.map((f) => featureRowRank(f, activeRunFeature))),
  }))
  groups.sort((a, b) => a.worstRank - b.worstRank || a.group.localeCompare(b.group))
  return { ungrouped, groups }
}

export function FeaturesColumn({
  features,
  selectedFeature,
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
  // stay flat. Sections order worst-first (a group with a running/dirty
  // feature above a calm one).
  const { ungrouped, groups } = groupFeatures(features, activeRunFeature)
  const renderFeatureRow = (feature: Feature): ReactNode => (
    <FeatureRow
      key={feature.name}
      feature={feature}
      selectedFeature={selectedFeature}
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
  const isActive = Boolean(activeRunFeature) && f.name === activeRunFeature
  const runState = isActive
    ? (activeRunStatus === 'queued' ? 'queued' : activeRunExecutionType === 'boot'
        ? 'booted'
        : activeRunStatus === 'healing' ? 'healing' : 'running')
    : null
  const runCue = !runState || runState === 'queued'
    ? ''
    : activeRunWaiting
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
  const showFlightChip = inFlight || flight?.queued === true
  const showRunWaitingChip = isActive && activeRunWaiting != null
  // The Coverage shortcut is for the resting ledger. While its job runs, Flight
  // owns the live work and is already the adjacent shortcut. Hiding this action
  // avoids two icons that describe the same work but open different surfaces.
  const coverageAction = coverageHeadline === 'Generating' ? undefined : onOpenCoverage
  // The action cluster FLOATS over the row's right edge instead of sitting in
  // flow, so three icons cost the suite name zero width at rest — in a column
  // of long `cns_*` names that width is the column's actual content. The name
  // only makes room (padding-right) while the row is hovered/focused, so
  // nothing ever moves: the ellipsis just lands earlier. Width is computed from
  // the visible count so a 1-action row doesn't reserve space for three.
  const actionCount = 1 + (coverageAction ? 1 : 0) + (flight ? 1 : 0)
  // The at-rest status chip already sits in flow at that same right edge, so it
  // has ALREADY cost the name its width — reserving the full cluster on top of it
  // left an in-flight row with ~18px of readable name on hover (204px row − 72px
  // chip − 100px reservation). Subtract what the chip yields; the cluster floats
  // over the chip's box as it fades, so the icons still land clear of the text.
  const chipWidth = showRunWaitingChip || showFlightChip ? 72 + 6 : 0
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
      title={isActive && activeRunWaiting ? activeRunWaiting.label : runState ? (runState === 'queued' ? 'Queued' : runState === 'healing' ? 'Healing now' : runState === 'booted' ? 'Services up (boot-only)' : 'Running now') : inFlight ? flight?.title : undefined}
    >
      {tone && (
        <Tooltip label={`${SPEC_TONE[tone].title} Click to review.`}>
          <button type="button" onClick={() => { onSelectFeature(f.name); onReviewFeature?.(f.name) }}
            aria-label={`Review test changes in ${f.name}`}
            data-testid={`dirty-badge-${f.name}`}
            data-tone={tone}
            className="ml-1.5 flex shrink-0 items-center justify-center self-center rounded px-1 py-1 text-[10px] leading-none"
            style={{
              color: 'var(--warning)',
              background: 'color-mix(in srgb, var(--warning) 14%, transparent)',
              border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)',
            }}
          >
            Review
          </button>
        </Tooltip>
      )}
      {f.portified && (
        <Tooltip label="Ready for parallel runs.">
          <span
            aria-label="Portified"
            data-testid={`portified-badge-${f.name}`}
            className="ml-1.5 flex h-4 w-4 shrink-0 items-center justify-center self-center rounded text-[11px] leading-none"
            style={{
              color: 'var(--success)',
              background: 'color-mix(in srgb, var(--success) 14%, transparent)',
              border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)',
            }}
          >
            ⇄
          </span>
        </Tooltip>
      )}
      <button
        type="button"
        onClick={() => onSelectFeature(f.name)}
        title={f.name}
        className="feature-row__name min-w-0 flex-1 truncate rounded-md px-2 py-2 text-left"
        style={{ color: 'inherit', fontWeight: 'inherit' }}
      >
        {f.name}
      </button>
      {runState && !showRunWaitingChip && (
        <span className="sr-only">{runState === 'queued' ? 'Queued' : runState === 'healing' ? 'Healing' : runState === 'booted' ? 'Services up' : 'Running'}</span>
      )}
      {showRunWaitingChip && activeRunWaiting && (
        <span className="feature-row__status-chip mr-1.5 shrink-0 self-center" aria-label={activeRunWaiting.label}>
          <Chip
            tone={activeRunWaiting.kind === 'queued' ? 'var(--text-muted)' : 'var(--warning)'}
            background={activeRunWaiting.kind === 'queued' ? 'var(--bg-elevated)' : undefined}
            chrome="fill"
            label={activeRunWaiting.shortLabel}
            uppercase
            fontSize={10}
            testId={`run-waiting-${f.name}`}
          />
        </span>
      )}
      {!showRunWaitingChip && showFlightChip && flight && (
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
        {coverageAction && (
          <Tooltip label="Coverage">
            <button
              type="button"
              onClick={() => { onSelectFeature(f.name); coverageAction(f.name) }}
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
