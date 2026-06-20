import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { ExecutionType, Feature, RunStatus } from '../api/types'
import { useWizardDrafts } from '../features/wizard/state/WizardDraftContext'
import { useMcpPromo } from '../state/McpPromoContext'
import { FeatureConfigEditor } from './FeatureConfigEditor'
import { ThemeToggle } from './ThemeToggle'
import { SettingsModal } from './SettingsModal'
import { Tooltip } from './Tooltip'

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
  /** Incremented by App when a coverage job finishes → re-fetches headlines. */
  coverageRefreshKey?: number
  /** Opens the port-ification wizard for a feature (Service tab entry). */
  onStartPortify?: (feature: string) => void
  /** Reopens a past/active port-ification workflow (Ports-tab history). */
  onOpenPortify?: (workflowId: string) => void
  /** Opens the Verified Coverage ledger for a feature (R8 column entry point). */
  onOpenCoverage?: (feature: string) => void
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

export function FeaturesColumn({
  features,
  selectedFeature,
  activeRunFeature,
  activeRunStatus,
  activeRunExecutionType,
  onSelectFeature,
  onFeaturesChanged,
  coverageRefreshKey,
  onStartPortify,
  onOpenPortify,
  onOpenCoverage,
}: Props) {
  const { startNewWizard } = useWizardDrafts()
  const { gatePromo } = useMcpPromo()
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

  return (
    <div className="cl-panel flex h-full flex-col">
      <div className="cl-panel-header flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="cl-kicker">Features</span>
          {features.length > 0 && <span className="cl-count-chip">{features.length}</span>}
        </div>
        <button
          type="button"
          onClick={() => gatePromo('create-feature', startNewWizard)}
          className="cl-button shrink-0 whitespace-nowrap px-2.5 py-1"
          title="Add a new feature"
        >
          + New
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 py-2">
        {features.length === 0 ? (
          <div className="px-2 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>No features detected.</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {features.map((f) => {
              const isSelected = f.name === selectedFeature
              const isActive = Boolean(activeRunFeature) && f.name === activeRunFeature
              const runState = isActive
                ? (activeRunExecutionType === 'boot'
                    ? 'booted'
                    : activeRunStatus === 'healing' ? 'healing' : 'running')
                : null
              return (
                <li
                  key={f.name}
                  className={`feature-row group cl-list-row text-sm${isSelected ? ' cl-list-row-selected' : ''}${runState ? ` cl-list-row-${runState}` : ''}`}
                  style={{
                    color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: isSelected ? 500 : 400,
                  }}
                  title={runState ? (runState === 'healing' ? 'Healing now' : runState === 'booted' ? 'Services up (boot-only)' : 'Running now') : undefined}
                >
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
                        data-headline={coverageHeadlines[f.name] ?? ''}
                        className="feature-row__cog cl-icon-button mr-0.5 h-7 w-7 shrink-0 self-center"
                        style={{ color: coverageHeadlineColor(coverageHeadlines[f.name]) }}
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
                      onClick={() => setConfigFor(f.name)}
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
            })}
          </ul>
        )}
      </div>
      <div className="cl-panel-footer flex items-center justify-between p-2">
        <ThemeToggle />
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
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {configFor && (
        <FeatureConfigEditor
          feature={configFor}
          portified={features.find((f) => f.name === configFor)?.portified ?? false}
          onStartPortify={onStartPortify}
          onOpenPortify={(workflowId) => { setConfigFor(null); onOpenPortify?.(workflowId) }}
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
