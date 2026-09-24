import { useMemo } from 'react'
import { comparisonPatchRows } from '@/shared/lib/comparison-diff'
import { ComparisonLegend, ComparisonTable } from './ComparisonTable'

/** Captured patches use the same before/after presentation as semantic changes.
 * File and hunk metadata remain visible so the comparison keeps its context. */
export function DiffView({ diff, onOpenInEditor, openTitle = 'Open project in editor' }: { diff: string; onOpenInEditor?: () => void; openTitle?: string }) {
  const rows = useMemo(() => comparisonPatchRows(diff).map((row, index) => row.kind === 'section'
    ? { id: String(index), kind: 'section' as const, label: row.text }
    : { id: String(index), before: row.before, after: row.after }), [diff])
  if (!diff.trim()) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>(no diff captured)</div>
  return (
    <div style={{ position: 'relative' }}>
      {onOpenInEditor && (
        <button
          type="button"
          title={openTitle}
          aria-label={openTitle}
          onClick={onOpenInEditor}
          className="cl-icon-button"
          style={{
            position: 'absolute', top: 8, right: 8, zIndex: 10, height: 26, width: 26, fontSize: 13,
            border: '1px solid var(--border-default)',
            background: 'color-mix(in srgb, var(--bg-surface) 92%, transparent)',
            boxShadow: 'var(--shadow-panel)', cursor: 'pointer',
          }}
        >
          ↗
        </button>
      )}
      <div className="mb-2 pr-10"><ComparisonLegend /></div>
      <div className="max-h-[360px] overflow-auto scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
        <ComparisonTable rows={rows} code ariaLabel="Patch before and after" />
      </div>
    </div>
  )
}
