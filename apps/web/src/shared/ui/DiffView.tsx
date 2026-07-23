import React from 'react'

/** Unified-diff block with per-line colouring (+ green, − red, `# ` section
 *  headers accent, @@ hunks muted) — the one diff renderer for every surface
 *  that shows a captured patch (Portify wizard review, flight portify-apply
 *  checkpoint). Extracted from PortifyWizard so the flight checkpoint stopped
 *  rendering the same diff as an uncoloured wall of text. */
export function DiffView({ diff, onOpenInEditor }: { diff: string; onOpenInEditor?: () => void }) {
  if (!diff.trim()) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>(no diff captured)</div>
  return (
    <div style={{ position: 'relative' }}>
      {onOpenInEditor && (
        <button
          type="button"
          title="Open project in editor"
          aria-label="Open project in editor"
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
      <pre style={{
        fontSize: 11.5, fontFamily: 'var(--font-mono)', lineHeight: 1.5, color: 'var(--text-secondary)',
        background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
        padding: '12px 14px', maxHeight: 360, overflow: 'auto', whiteSpace: 'pre', margin: 0,
      }}>
        {diff.split('\n').map((line, i) => (
          <div key={i} style={{ color: lineColor(line) }}>{line || ' '}</div>
        ))}
      </pre>
    </div>
  )
}

function lineColor(line: string): string {
  if (line.startsWith('# ')) return 'var(--accent)'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'var(--success)'
  if (line.startsWith('-') && !line.startsWith('---')) return 'var(--danger)'
  if (line.startsWith('@@')) return 'var(--text-muted)'
  return 'var(--text-secondary)'
}
