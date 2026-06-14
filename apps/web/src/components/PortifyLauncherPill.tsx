import type { PortifyIndexEntry } from '../api/client'
import { StatusDot } from './config/atoms'

// Portify launcher pill: ALWAYS visible in the GlobalStatusBar action cluster
// (next to Cleanup) to promote port-ification. Clicking opens the feature picker
// to start a workflow on any feature — and, while a workflow is in-flight, to see
// which feature is being portified and reopen it.
//
// The in-flight state lives here now (the separate active-only pill was folded
// in): a blinking dot replaces the 🔌, the feature name moves into the tooltip,
// and the accent emphasis (+ "· ready") lights up once it's ready to save.
export function PortifyLauncherPill({
  activePortify,
  onOpen,
}: {
  activePortify?: PortifyIndexEntry
  onOpen: () => void
}) {
  const ready = activePortify?.status === 'ready-to-save'
  const title = activePortify
    ? ready
      ? `Port-ification of ${activePortify.feature} is ready to save — click to view`
      : `Portifying ${activePortify.feature}… — click to view`
    : "Portify — make a feature's ports injectable so it can boot concurrently"
  return (
    <button
      type="button"
      onClick={onOpen}
      className="cl-button flex shrink-0 items-center gap-1.5 px-2.5 py-1"
      title={title}
      aria-label="Open Portify feature picker"
      style={
        ready
          ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border-default))' }
          : undefined
      }
    >
      {activePortify ? (
        <StatusDot state={ready ? 'success' : 'running'} className="shrink-0" />
      ) : (
        <span aria-hidden="true">🔌</span>
      )}
      <span style={{ fontSize: 12, fontWeight: 500, color: ready ? 'var(--accent)' : undefined }}>
        {ready ? 'Portify · ready' : 'Portify'}
      </span>
    </button>
  )
}
