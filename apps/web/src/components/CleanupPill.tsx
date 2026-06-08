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
      <span aria-hidden="true">🧹</span>
      <span style={{ fontSize: 12, fontWeight: 500 }}>Cleanup</span>
    </button>
  )
}
