import { useState } from 'react'
import type { Feature, RunStatus } from '../api/types'
import { useWizardDrafts } from '../state/WizardDraftContext'
import { useMcpPromo } from '../state/McpPromoContext'
import { FeatureConfigEditor } from './FeatureConfigEditor'
import { ThemeToggle } from './ThemeToggle'
import { SettingsModal } from './SettingsModal'

interface Props {
  features: Feature[]
  selectedFeature: string | null
  /** Feature whose run is currently active (running or healing), or null. */
  activeRunFeature?: string | null
  /** Status of that active run — drives the chip label/color. */
  activeRunStatus?: RunStatus | null
  onSelectFeature: (name: string) => void
  onFeaturesChanged?: (preferredFeature?: string | null) => void
}

export function FeaturesColumn({
  features,
  selectedFeature,
  activeRunFeature,
  activeRunStatus,
  onSelectFeature,
  onFeaturesChanged,
}: Props) {
  const { startNewWizard } = useWizardDrafts()
  const { gatePromo } = useMcpPromo()
  const [configFor, setConfigFor] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

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
              const runState = isActive ? (activeRunStatus === 'healing' ? 'healing' : 'running') : null
              return (
                <li
                  key={f.name}
                  className={`feature-row group cl-list-row text-sm${isSelected ? ' cl-list-row-selected' : ''}${runState ? ` cl-list-row-${runState}` : ''}`}
                  style={{
                    color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: isSelected ? 500 : 400,
                  }}
                  title={runState ? (runState === 'healing' ? 'Healing now' : 'Running now') : undefined}
                >
                  <button
                    type="button"
                    onClick={() => onSelectFeature(f.name)}
                    title={f.name}
                    className="min-w-0 flex-1 truncate rounded-md px-3 py-2 text-left"
                    style={{ color: 'inherit', fontWeight: 'inherit' }}
                  >
                    {f.name}
                  </button>
                  {runState && (
                    <span className="sr-only">{runState === 'healing' ? 'Healing' : 'Running'}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setConfigFor(f.name)}
                    aria-label={`Configure ${f.name}`}
                    title="View feature config"
                    className="feature-row__cog cl-icon-button mr-1.5 h-7 w-7 shrink-0 self-center"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
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
