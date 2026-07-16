import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { ExecutionType, Feature, RunStatus, VersionStatus } from '../api/types'
import { useMcpPromo } from './McpPromoContext'
import { FeatureConfigEditor } from '../../features/config/components/FeatureConfigEditor'
import { ThemeToggle } from '../ui/ThemeToggle'
import { VersionUpdateButton } from './VersionUpdateButton'
import { SettingsModal } from '../../features/config/components/SettingsModal'
import { ChevronRightIcon } from '../../features/config/components/atoms'
import { Tooltip } from '../ui/Tooltip'
import { readGroupOpen, writeGroupOpen } from '../../features/flights/lib/group-open-state'
import { FlightStatusChip } from '../../features/flights/components/FlightsPill'
import { useInvalidationKey } from '../state/invalidation'

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
  onSelectFeature: (name: string) => void
  onFeaturesChanged?: (preferredFeature?: string | null) => void
  /** Opens the Requirement Coverage ledger for a feature (R8 column entry point). */
  onOpenCoverage?: (feature: string) => void
  /** Opens the new-flight dialog (intent + repo picker) — the "+ New" action.
   *  Flight is the only GUI path to a new feature (R40/R50). */
  onStartNewFlight?: () => void
  /** Opens the routed flight view — a pending (pre-scaffold) placeholder row
   *  has no feature dir to select, so clicking it resumes its flight instead. */
  onOpenFlight?: (flightId: string) => void
  /** Current-vs-latest version + self-update job state. Drives the footer
   *  "update available" indicator; null until the registry check resolves. */
  versionStatus?: VersionStatus | null
}

// Colour the Coverage icon by the derived headline (R8). Neutral (inherit) for
// setup-needed / no-coverage / unknown so the column stays calm until there's
// real signal; green when covered, sky while generating, amber when stale.
function coverageHeadlineColor(headline: string | null | undefined): string | undefined {
  if (!headline) return undefined
  if (headline.startsWith('Covered')) return 'rgb(52, 211, 153)'
  if (headline === 'Generating') return 'rgb(56, 189, 248)'
  if (headline === 'Stale') return 'rgb(251, 191, 36)'
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
  if (f.pending) return f.pending.status === 'waiting-for-approval' ? 1 : 2
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
  onSelectFeature,
  onFeaturesChanged,
  onOpenCoverage,
  onStartNewFlight,
  onOpenFlight,
  versionStatus,
}: Props) {
  const { gatePromo } = useMcpPromo()
  // Coverage headlines re-fetch when a coverage job finishes (`coverage-changed`).
  const coverageRefreshKey = useInvalidationKey('coverage')
  const [configFor, setConfigFor] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Per-feature coverage headline → colours the column's Coverage icon (R8).
  // Fetched on mount + when the feature set changes (not polled — generating
  // state is surfaced by the status-bar pill instead, which avoids recomputing
  // every feature's coverage on a tight loop).
  const [coverageHeadlines, setCoverageHeadlines] = useState<Record<string, string | null>>({})
  const featureKey = features.map((f) => f.name).join(',')
  useEffect(() => {
    if (!onOpenCoverage || features.length === 0) return
    let alive = true
    api.listCoverageStates()
      .then((states) => {
        if (!alive) return
        const map: Record<string, string | null> = {}
        for (const s of states) map[s.feature] = s.headline
        setCoverageHeadlines(map)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [featureKey, onOpenCoverage, features.length, coverageRefreshKey])

  // R55: features declaring a `group` collapse under an accordion; the rest
  // stay flat. Sections order worst-first (a group with a running/dirty
  // feature above a calm one).
  const { ungrouped, groups } = groupFeatures(features, activeRunFeature)

  return (
    <div className="cl-panel flex h-full flex-col">
      <div className="cl-panel-header flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="cl-kicker">Suites</span>
          {features.length > 0 && <span className="cl-count-chip">{features.length}</span>}
        </div>
        <button
          type="button"
          onClick={() => gatePromo('create-feature', () => onStartNewFlight?.())}
          className="cl-button shrink-0 whitespace-nowrap px-2.5 py-1"
          title="Start a flight on new repos"
        >
          + New
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 py-2" style={{ scrollbarGutter: 'stable' }}>
        {features.length === 0 ? (
          <div className="px-2 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>No features detected.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {ungrouped.length > 0 && (
              <ul className="flex flex-col gap-1">
                {ungrouped.map((f) => (
                  <FeatureRow
                    key={f.name}
                    feature={f}
                    selectedFeature={selectedFeature}
                    activeRunFeature={activeRunFeature}
                    activeRunStatus={activeRunStatus}
                    activeRunExecutionType={activeRunExecutionType}
                    coverageHeadline={coverageHeadlines[f.name]}
                    onSelectFeature={onSelectFeature}
                    onOpenCoverage={onOpenCoverage}
                    onOpenFlight={onOpenFlight}
                    onConfigure={setConfigFor}
                  />
                ))}
              </ul>
            )}
            {groups.map((section) => (
              <FeatureGroupAccordion
                key={section.group}
                section={section}
                selectedFeature={selectedFeature}
                activeRunFeature={activeRunFeature}
                activeRunStatus={activeRunStatus}
                activeRunExecutionType={activeRunExecutionType}
                coverageHeadlines={coverageHeadlines}
                onSelectFeature={onSelectFeature}
                onOpenCoverage={onOpenCoverage}
                onOpenFlight={onOpenFlight}
                onConfigure={setConfigFor}
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
          onClick={() => setSettingsOpen(true)}
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
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {configFor && (
        <FeatureConfigEditor
          feature={configFor}
          portified={features.find((f) => f.name === configFor)?.portified ?? false}
          onClose={() => setConfigFor(null)}
          onRenamed={(_, nextFeature) => {
            setConfigFor(nextFeature)
            onFeaturesChanged?.(nextFeature)
          }}
          onDeleted={(deletedFeature) => {
            setConfigFor(null)
            onFeaturesChanged?.(selectedFeature === deletedFeature ? null : selectedFeature)
          }}
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
  coverageHeadline,
  onSelectFeature,
  onOpenCoverage,
  onOpenFlight,
  onConfigure,
}: {
  feature: Feature
  selectedFeature: string | null
  activeRunFeature?: string | null
  activeRunStatus?: RunStatus | null
  activeRunExecutionType?: ExecutionType | null
  coverageHeadline?: string | null
  onSelectFeature: (name: string) => void
  onOpenCoverage?: (feature: string) => void
  onOpenFlight?: (flightId: string) => void
  onConfigure: (feature: string) => void
}) {
  // A pending placeholder (First-Flight batch, pre-scaffold) has no feature dir
  // to select or configure — render it muted with its flight's status chip;
  // clicking the row resumes the flight.
  if (f.pending) return <PendingFeatureRow feature={f} onOpenFlight={onOpenFlight} />
  const isSelected = f.name === selectedFeature
  const isDirty = f.dirty?.status === 'dirty'
  const isActive = Boolean(activeRunFeature) && f.name === activeRunFeature
  const runState = isActive
    ? (activeRunExecutionType === 'boot'
        ? 'booted'
        : activeRunStatus === 'healing' ? 'healing' : 'running')
    : null
  return (
    <li
      className={`feature-row group cl-list-row text-sm${isSelected ? ' cl-list-row-selected' : ''}${runState ? ` cl-list-row-${runState}` : ''}${isDirty ? ' cl-list-row-dirty' : ''}`}
      style={{
        color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontWeight: isSelected ? 500 : 400,
      }}
      title={runState ? (runState === 'healing' ? 'Healing now' : runState === 'booted' ? 'Services up (boot-only)' : 'Running now') : undefined}
    >
      {isDirty && (
        <Tooltip label="Test files modified — review in the status bar">
          <span
            aria-label="Tests modified"
            data-testid={`dirty-badge-${f.name}`}
            className="ml-1.5 flex h-4 w-4 shrink-0 items-center justify-center self-center rounded text-[11px] font-semibold leading-none"
            style={{
              color: 'var(--danger)',
              background: 'color-mix(in srgb, var(--danger) 14%, transparent)',
              border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)',
            }}
          >
            !
          </span>
        </Tooltip>
      )}
      {f.portified && (
        <Tooltip label="Portified">
          <span
            aria-label="Portified"
            data-testid={`portified-badge-${f.name}`}
            className="ml-1.5 flex h-4 w-4 shrink-0 items-center justify-center self-center rounded text-[11px] leading-none"
            style={{
              color: 'rgb(52,211,153)',
              background: 'color-mix(in srgb, rgb(52,211,153) 14%, transparent)',
              border: '1px solid color-mix(in srgb, rgb(52,211,153) 35%, transparent)',
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
        className="min-w-0 flex-1 truncate rounded-md px-2 py-2 text-left"
        style={{ color: 'inherit', fontWeight: 'inherit' }}
      >
        {f.name}
      </button>
      {runState && (
        <span className="sr-only">{runState === 'healing' ? 'Healing' : runState === 'booted' ? 'Services up' : 'Running'}</span>
      )}
      {onOpenCoverage && (
        <Tooltip label="Coverage">
          <button
            type="button"
            onClick={() => { onSelectFeature(f.name); onOpenCoverage(f.name) }}
            aria-label={`Open coverage for ${f.name}`}
            data-testid={`coverage-action-${f.name}`}
            data-headline={coverageHeadline ?? ''}
            className="feature-row__cog cl-icon-button mr-0.5 h-7 w-7 shrink-0 self-center"
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
          className="feature-row__cog cl-icon-button mr-1.5 h-7 w-7 shrink-0 self-center"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </Tooltip>
    </li>
  )
}

/** A collapsible feature-group section (R55): chevron + group name + count;
 *  the group's rows render under the disclosure. Open-state persists per group
 *  in localStorage (own key), default OPEN — mirrors the flights picker's
 *  disclosure. */
function FeatureGroupAccordion({
  section,
  selectedFeature,
  activeRunFeature,
  activeRunStatus,
  activeRunExecutionType,
  coverageHeadlines,
  onSelectFeature,
  onOpenCoverage,
  onOpenFlight,
  onConfigure,
}: {
  section: FeatureGroupSection
  selectedFeature: string | null
  activeRunFeature?: string | null
  activeRunStatus?: RunStatus | null
  activeRunExecutionType?: ExecutionType | null
  coverageHeadlines: Record<string, string | null>
  onSelectFeature: (name: string) => void
  onOpenCoverage?: (feature: string) => void
  onOpenFlight?: (flightId: string) => void
  onConfigure: (feature: string) => void
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
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
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
          {section.features.map((f) => (
            <FeatureRow
              key={f.name}
              feature={f}
              selectedFeature={selectedFeature}
              activeRunFeature={activeRunFeature}
              activeRunStatus={activeRunStatus}
              activeRunExecutionType={activeRunExecutionType}
              coverageHeadline={coverageHeadlines[f.name]}
              onSelectFeature={onSelectFeature}
              onOpenCoverage={onOpenCoverage}
              onOpenFlight={onOpenFlight}
              onConfigure={onConfigure}
            />
          ))}
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
