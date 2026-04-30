import { useState } from 'react'
import type { Feature } from '../api/types'
import { AddTestWizard } from './AddTestWizard'
import { ThemeToggle } from './ThemeToggle'

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
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {features.length === 0 ? (
          <div className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>No features detected.</div>
        ) : (
          features.map((f) => {
            const isSelected = f.name === selectedFeature
            return (
              <button
                key={f.name}
                type="button"
                onClick={() => onSelectFeature(f.name)}
                className="flex w-full items-center px-4 py-2 text-left text-sm transition-colors duration-150"
                style={{
                  color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: isSelected ? 500 : 400,
                  background: isSelected ? 'var(--bg-elevated)' : 'transparent',
                }}
              >
                <span className="truncate">{f.name}</span>
              </button>
            )
          })
        )}
      </div>
      <div className="p-2" style={{ borderTop: '1px solid var(--border-default)' }}>
        <ThemeToggle />
      </div>

      {wizardOpen && (
        <AddTestWizard
          features={features}
          onClose={({ acceptedFeature }) => {
            setWizardOpen(false)
            if (acceptedFeature) onFeaturesChanged?.(acceptedFeature)
          }}
        />
      )}
    </div>
  )
}
