import type { WizardStep } from '../../lib/wizard-state'

const STEPS: { key: WizardStep; label: string }[] = [
  { key: 'configure', label: '1. Configure' },
  { key: 'plan', label: '2. Plan Review' },
  { key: 'spec', label: '3. Spec Review' },
  { key: 'done', label: '4. Done' },
]

// Linear progress indicator at the top of the wizard. The active step is
// highlighted; previously-passed steps are shown in a muted "complete"
// color. Display-only — clicks do not navigate.
export function Stepper({ current }: { current: WizardStep }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current)
  return (
    <ol className="flex w-full items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-6 py-3 text-xs">
      {STEPS.map((s, i) => {
        const state = i === currentIdx ? 'current' : i < currentIdx ? 'done' : 'upcoming'
        const cls =
          state === 'current'
            ? 'text-zinc-900 dark:text-zinc-100 font-medium'
            : state === 'done'
              ? 'text-emerald-400'
              : 'text-zinc-500'
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span className={cls}>{s.label}</span>
            {i < STEPS.length - 1 && <span className="text-zinc-300 dark:text-zinc-700">›</span>}
          </li>
        )
      })}
    </ol>
  )
}
