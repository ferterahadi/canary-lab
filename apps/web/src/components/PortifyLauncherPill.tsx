// Portify launcher pill: ALWAYS visible in the GlobalStatusBar action cluster
// (next to Cleanup) to promote port-ification. Clicking opens a feature picker
// to start a workflow on any feature. Distinct from `PortifyPill`, which only
// appears while a workflow is in-flight and reopens that single active one.
export function PortifyLauncherPill({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="cl-button flex shrink-0 items-center gap-1.5 px-2.5 py-1"
      title="Portify — make a feature's ports injectable so it can boot concurrently"
      aria-label="Open Portify feature picker"
    >
      <span aria-hidden="true">🔌</span>
      <span style={{ fontSize: 12, fontWeight: 500 }}>Portify</span>
    </button>
  )
}
