// Coverage pill: opens the Verified Coverage Ledger for the selected feature.
export function CoveragePill({ onOpen, disabled }: { onOpen: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className="cl-button flex shrink-0 items-center gap-1.5 px-2.5 py-1"
      title={disabled ? 'Select a feature first' : 'Verified Coverage — requirements grounded by passing runs'}
      aria-label="Open verified coverage ledger"
    >
      <span aria-hidden="true">🎯</span>
      <span style={{ fontSize: 12, fontWeight: 500 }}>Coverage</span>
    </button>
  )
}
