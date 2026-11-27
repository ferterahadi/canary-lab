import { ComparisonLegend } from './ComparisonTable'
import { CapturedPatchEditor } from './FileComparisonEditor'
import { TestLanguageSwitch } from './TestLanguageSwitch'

/** Captured patches use the same before/after presentation as semantic changes.
 * File and hunk metadata remain visible so the comparison keeps its context. */
export function DiffView({ diff, onOpenInEditor, openTitle = 'Open project in editor' }: { diff: string; onOpenInEditor?: () => void; openTitle?: string }) {
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
      <div className="cl-context-toolbar pr-10"><TestLanguageSwitch reader="compact" mode="code" onVisual={() => {}} onChange={() => {}}
        disabled={{ reason: 'This patch contains changed lines. A flowchart needs the complete file.' }} /><ComparisonLegend /></div>
      <div className="flex max-h-[360px] flex-col overflow-hidden">
        <CapturedPatchEditor diff={diff} />
      </div>
    </div>
  )
}
