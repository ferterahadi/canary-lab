import { useState } from 'react'
import type { Feature } from '../api/types'
import { AddTestWizard } from './AddTestWizard'
import { FeatureConfigEditor } from './FeatureConfigEditor'
import { ThemeToggle } from './ThemeToggle'
import { SettingsModal } from './SettingsModal'

interface Props {
  features: Feature[]
  selectedFeature: string | null
  onSelectFeature: (name: string) => void
  onFeaturesChanged?: (acceptedFeature?: string) => void
}

export function FeaturesColumn({
  features,
  selectedFeature,
  onSelectFeature,
  onFeaturesChanged,
}: Props) {
  const [wizardOpen, setWizardOpen] = useState(false)
  const [configFor, setConfigFor] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <div className="cl-panel flex h-full flex-col">
      <div className="cl-panel-header px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="cl-kicker">Features</span>
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="cl-button px-2 py-1 text-[10px] font-semibold uppercase tracking-wide"
            style={{ color: 'var(--accent)' }}
          >
            + New
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin py-1">
        {features.length === 0 ? (
          <div className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>No features detected.</div>
        ) : (
          features.map((f) => {
            const isSelected = f.name === selectedFeature
            return (
              <div
                key={f.name}
                className={`feature-row group flex w-full items-center text-sm ${isSelected ? 'cl-row-selected' : 'cl-row'}`}
                style={{
                  color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: isSelected ? 500 : 400,
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelectFeature(f.name)}
                  title={f.name}
                  className="min-w-0 flex-1 truncate px-4 py-2 text-left"
                  style={{ color: 'inherit', fontWeight: 'inherit' }}
                >
                  {f.name}
                </button>
                <button
                  type="button"
                  onClick={() => setConfigFor(f.name)}
                  aria-label={`Configure ${f.name}`}
                  title="View feature config"
                  className="feature-row__cog cl-icon-button mr-2 h-6 w-6 shrink-0"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
              </div>
            )
          })
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

      {wizardOpen && (
        <AddTestWizard
          features={features}
          onClose={({ acceptedFeature }) => {
            setWizardOpen(false)
            if (acceptedFeature) onFeaturesChanged?.(acceptedFeature)
          }}
        />
      )}

      {configFor && (
        <FeatureConfigEditor feature={configFor} onClose={() => setConfigFor(null)} />
      )}
    </div>
  )
}
