import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { Feature, FeatureTests } from '../api/types'

interface Props {
  features: Feature[]
  selectedFeature: string | null
  onSelectFeature: (name: string) => void
}

// Column 1 — features tree. Each feature expands into its tests on click. Test
// rows are display-only in 6a; selection state for tests lands in 6b.
export function FeaturesColumn({ features, selectedFeature, onSelectFeature }: Props): JSX.Element {
  const [tests, setTests] = useState<Record<string, FeatureTests>>({})

  useEffect(() => {
    if (!selectedFeature || tests[selectedFeature]) return
    api.getFeatureTests(selectedFeature)
      .then((data) => setTests((prev) => ({ ...prev, [selectedFeature]: data })))
      .catch(() => { /* leave undefined — UI shows "no tests" */ })
  }, [selectedFeature, tests])

  return (
    <div className="flex flex-col gap-1 p-2">
      <button
        type="button"
        disabled
        title="Coming in 6c"
        className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-left text-xs text-zinc-500 disabled:cursor-not-allowed"
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
                  isSelected ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900'
                }`}
              >
                {f.name}
              </button>
              {isSelected && featureTests && (
                <ul className="ml-3 mt-1 border-l border-zinc-800 pl-2">
                  {featureTests.flatMap((spec) =>
                    spec.tests.map((t) => (
                      <li
                        key={`${spec.file}:${t.line}`}
                        className="truncate py-1 text-xs text-zinc-400 hover:text-zinc-200"
                        title={t.name}
                      >
                        {t.name}
                      </li>
                    )),
                  )}
                  {featureTests.every((spec) => spec.tests.length === 0) && (
                    <li className="py-1 text-xs italic text-zinc-600">No tests defined</li>
                  )}
                </ul>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
