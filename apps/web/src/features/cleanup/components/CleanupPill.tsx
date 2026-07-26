// Cleanup pill: opens the log-cleanup page to reclaim disk and tidy old runs.
export function CleanupPill({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="cl-button flex shrink-0 items-center gap-1.5 px-2.5 py-1"
      title="Log cleanup — reclaim disk and tidy old runs"
      aria-label="Open log cleanup"
    >
      {/* Stroke glyph (brush) — matches the shell's monochrome SVG icon
          language; the emoji it replaces ignored the theme. */}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
        <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
        <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
      </svg>
      <span style={{ fontSize: 12, fontWeight: 500 }}>Cleanup</span>
    </button>
  )
}
