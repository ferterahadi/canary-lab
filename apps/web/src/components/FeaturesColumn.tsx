import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { Feature, FeatureTests } from '../api/types'
import { AddTestWizard } from './AddTestWizard'
import { ThemeToggle } from './ThemeToggle'

interface Props {
  features: Feature[]
  selectedFeature: string | null
  onSelectFeature: (name: string) => void
  onFeaturesChanged?: (acceptedFeature?: string) => void
}

// Column 1 — features tree. Each feature expands into its tests on click.
// The "+ Add new test" button opens the full-screen wizard (slice 6c).
export function FeaturesColumn({
  features,
  selectedFeature,
  onSelectFeature,
  onFeaturesChanged,
}: Props) {
  const [tests, setTests] = useState<Record<string, FeatureTests>>({})
  const [wizardOpen, setWizardOpen] = useState(false)

  useEffect(() => {
    if (!selectedFeature || tests[selectedFeature]) return
    api.getFeatureTests(selectedFeature)
      .then((data) => setTests((prev) => ({ ...prev, [selectedFeature]: data })))
      .catch(() => { /* leave undefined — UI shows "no tests" */ })
  }, [selectedFeature, tests])

  return (
    <div className="flex h-full flex-col">
    <div className="flex flex-1 min-h-0 flex-col gap-1 overflow-y-auto p-2">
      <button
        type="button"
        onClick={() => setWizardOpen(true)}
        className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        + Add new test
      </button>
      <div className="mt-2 text-[10px] uppercase tracking-wide text-zinc-500 px-1">Features</div>
      {features.length === 0 ? (
        <div className="text-xs text-zinc-500 px-2 py-3">No features detected.</div>
      ) : (
        features.map((f) => {
          const isSelected = f.name === selectedFeature
          const featureTests = tests[f.name]
          return (
            <div key={f.name}>
              <button
                type="button"
                onClick={() => onSelectFeature(f.name)}
                className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                  isSelected
                    ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                    : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'
                }`}
              >
                {f.name}
              </button>
              {isSelected && featureTests && (
                <ul className="ml-3 mt-1 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                  {featureTests.flatMap((spec) =>
                    spec.tests.map((t) => (
                      <li
                        key={`${spec.file}:${t.line}`}
                        className="truncate py-1 text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                        title={t.name}
                      >
                        {t.name}
                      </li>
                    )),
                  )}
                  {featureTests.every((spec) => spec.tests.length === 0) && (
                    <li className="py-1 text-xs italic text-zinc-400 dark:text-zinc-600">No tests defined</li>
                  )}
                </ul>
              )}
            </div>
          )
        })
      )}

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
      <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
        <ThemeToggle />
      </div>
    </div>
  )
}
