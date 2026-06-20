import { StatusPill } from '../../../shared/ui/StatusPill'

// Runs pill: surfaced only while a test/verify run is running, healing, or
// queued. Self-guards: renders nothing when no such run is active.
export function RunsPill({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null
  return (
    <StatusPill
      dotState="running"
      name="Runs"
      count={count}
      countTone="accent"
      onClick={onOpen}
      title="Show all runs"
      ariaLabel={`Show all runs (${count} active)`}
    />
  )
}
