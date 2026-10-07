import { useState, type ReactNode } from 'react'
import type { FeatureDoc } from '@shared/coverage/feature-docs'

export interface DocDisclosure {
  expanded: boolean
  onToggle: () => void
  sourceCount: number
}

/** A feature's docs as a tree: the generated summary on top, the source docs
 *  it was distilled from nested under its caret. One home for the coverage rail
 *  and the flight Requirements stage, so both read the same relationship the
 *  same way.
 *
 *  `nest` false (no summary yet — the docs are still being edited) keeps a flat
 *  list. A broken source stays visible — its Relink affordance must never hide
 *  behind a collapsed caret. */
export function DocTree({ docs, nest, defaultOpen = false, renderPill }: {
  docs: FeatureDoc[]
  nest: boolean
  /** Whether the sources start expanded. */
  defaultOpen?: boolean
  renderPill: (doc: FeatureDoc, disclosure?: DocDisclosure) => ReactNode
}) {
  const [sourcesOpen, setSourcesOpen] = useState(defaultOpen)
  const sourceDocs = docs.filter((d) => !d.generated)
  const [summaryDoc, ...otherGeneratedDocs] = nest && sourceDocs.length > 0 ? docs.filter((d) => d.generated) : []
  const sourcesExpanded = sourcesOpen || sourceDocs.some((d) => d.broken)

  if (!summaryDoc) return <div className="flex flex-col gap-2">{docs.map((d) => renderPill(d))}</div>
  return (
    <div className="flex flex-col gap-2">
      {renderPill(summaryDoc, { expanded: sourcesExpanded, onToggle: () => setSourcesOpen(!sourcesExpanded), sourceCount: sourceDocs.length })}
      {sourcesExpanded && (
        <div
          data-testid="summary-source-docs"
          className="flex flex-col gap-2"
          style={{ marginLeft: 13, paddingLeft: 10, borderLeft: '1px solid var(--border-default)' }}
        >
          {sourceDocs.map((d) => renderPill(d))}
        </div>
      )}
      {otherGeneratedDocs.map((d) => renderPill(d))}
    </div>
  )
}
