import type { PortifyIndexEntry } from '../api/client'
import { StatusPill } from './StatusPill'

// Portify pill: shown only while a port-ification workflow is active
// (Runs-style). It's one-at-a-time, so clicking reopens that single workflow
// in the wizard. It reads as a normal sibling pill while mid-flight; the accent
// emphasis (+ green dot) only lights up once it's ready to save. Self-guards:
// renders nothing when no workflow is active.
export function PortifyPill({
  portify,
  onOpen,
}: {
  portify: PortifyIndexEntry | undefined
  onOpen: (workflowId: string) => void
}) {
  if (!portify) return null
  const ready = portify.status === 'ready-to-save'
  return (
    <StatusPill
      dotState={ready ? 'success' : 'running'}
      name={ready ? 'Portify · ready' : 'Portify'}
      emphasis={ready}
      onClick={() => onOpen(portify.workflowId)}
      title={`Port-ification of ${portify.feature} — click to view`}
      ariaLabel={`Open port-ification of ${portify.feature}`}
    />
  )
}
