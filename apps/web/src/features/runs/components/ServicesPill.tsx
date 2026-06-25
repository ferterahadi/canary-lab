import { StatusPill } from '../../../shared/ui/StatusPill'

// Services pill: held boot sessions, distinct from runs. Appears whenever
// something is booted; the teal count + a one-shot pulse (keyed on the count)
// signal a fresh boot landing here. Self-guards: renders nothing when idle.
export function ServicesPill({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null
  return (
    <StatusPill
      dotState="booted"
      name="Services"
      count={count}
      countTone="boot"
      freshPulseKey={count}
      onClick={onOpen}
      title="Show booted services"
      ariaLabel={`Show booted services (${count} up)`}
    />
  )
}
