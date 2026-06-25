import { StatusDot, type StatusDotState } from '../../features/config/components/atoms'

// Labelled status chip: a semantic dot + label + state word. Used in the status
// bar for the active run's service count.
export function StatusChip({ label, state }: { label: string; state: 'running' | 'healing' | 'idle' }) {
  const dotState: StatusDotState =
    state === 'running' ? 'success'
    : state === 'healing' ? 'warning'
    : 'idle'
  return (
    <div
      className="flex items-center gap-1.5"
      style={{ color: 'var(--text-primary)', fontSize: 11.5, fontWeight: 500 }}
    >
      <StatusDot state={dotState} pulse={state !== 'idle'} halo={state !== 'idle'} />
      <span>{label}</span>
      <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 400 }}>
        {state}
      </span>
    </div>
  )
}
