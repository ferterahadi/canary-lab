import type { WizardStep } from '../../lib/wizard-state'
import { StatusDot, type StatusDotState } from '../config/atoms'

const STEPS: { key: WizardStep; label: string }[] = [
  { key: 'configure', label: 'Configure' },
  { key: 'plan', label: 'Plan Review' },
  { key: 'spec', label: 'Spec Review' },
  { key: 'done', label: 'Done' },
]

type State = 'current' | 'done' | 'upcoming'

const DOT_STATE: Record<State, StatusDotState> = {
  current: 'running',
  done: 'success',
  upcoming: 'idle',
}

// Linear progress indicator at the top of the wizard. Same status-dot
// language as the rest of the app: pulsing dot for the current step, solid
// green for completed, muted idle for upcoming. Display-only — clicks do
// not navigate.
export function Stepper({ current }: { current: WizardStep }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current)
  return (
    <ol className="cl-panel-header flex w-full items-center gap-3 px-6 py-3 text-[11px]">
      {STEPS.map((s, i) => {
        const state: State = i === currentIdx ? 'current' : i < currentIdx ? 'done' : 'upcoming'
        const labelColor =
          state === 'current' ? 'var(--text-primary)'
          : state === 'done' ? 'var(--text-secondary)'
          : 'var(--text-muted)'
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot state={DOT_STATE[state]} />
              <span
                className={state === 'upcoming' ? 'uppercase tracking-wider' : 'font-medium'}
                style={{ color: labelColor, fontSize: state === 'upcoming' ? '10px' : undefined }}
              >
                {`${i + 1}. ${s.label}`}
              </span>
            </span>
            {i < STEPS.length - 1 && (
              <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>›</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
