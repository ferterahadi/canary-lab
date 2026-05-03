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
    <div className="flex h-full flex-col">
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border-default)' }}>
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: 'var(--text-muted)' }}>Features</span>
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wide transition-colors duration-150"
            style={{
              color: 'var(--border-focus)',
              border: '1px solid color-mix(in srgb, var(--border-focus) 40%, transparent)',
              background: 'color-mix(in srgb, var(--border-focus) 8%, transparent)',
            }}
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
                className="feature-row group flex w-full items-center text-sm transition-colors duration-150"
                style={{
                  color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: isSelected ? 500 : 400,
                  background: isSelected ? 'var(--bg-elevated)' : 'transparent',
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
                  className="feature-row__cog mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors duration-150"
                  style={{ color: 'var(--text-muted)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)' }}
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
      <div className="flex items-center justify-between p-2" style={{ borderTop: '1px solid var(--border-default)' }}>
        <ThemeToggle />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Open settings"
          title="Settings"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)' }}
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
