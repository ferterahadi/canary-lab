import type { WizardStep } from '../../utils/wizard-state'

const STEPS: { key: WizardStep; label: string }[] = [
  { key: 'configure', label: 'Configure' },
  { key: 'plan', label: 'Plan' },
  { key: 'spec', label: 'Spec' },
  { key: 'done', label: 'Done' },
]

type State = 'current' | 'done' | 'upcoming'

// Compact horizontal progress indicator. Numbered pills + label; the current
// step is accented, completed steps carry the accent on a filled pill, and
// upcoming steps stay muted. Display-only — clicks do not navigate.
export function Stepper({ current }: { current: WizardStep }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current)
  return (
    <ol
      className="flex w-full items-center gap-2 px-6 py-3"
      style={{
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-default)',
      }}
    >
      {STEPS.map((s, i) => {
        const state: State = i === currentIdx ? 'current' : i < currentIdx ? 'done' : 'upcoming'
        const labelColor =
          state === 'current' ? 'var(--text-primary)'
          : state === 'done' ? 'var(--text-secondary)'
          : 'var(--text-muted)'
        const pillBg =
          state === 'current' ? 'var(--accent)'
          : state === 'done' ? 'var(--accent-soft)'
          : 'transparent'
        const pillColor =
          state === 'current' ? '#ffffff'
          : state === 'done' ? 'var(--accent)'
          : 'var(--text-muted)'
        const pillBorder =
          state === 'upcoming' ? '1px solid var(--border-default)'
          : state === 'done' ? '1px solid color-mix(in srgb, var(--accent) 40%, transparent)'
          : '1px solid transparent'
        const isLast = i === STEPS.length - 1
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full"
              style={{
                background: pillBg,
                color: pillColor,
                border: pillBorder,
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                fontWeight: 600,
              }}
            >
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span
              className="text-xs"
              style={{ color: labelColor, fontWeight: state === 'current' ? 600 : 500 }}
            >
              {s.label}
            </span>
            {!isLast && (
              <span
                aria-hidden="true"
                className="mx-1 inline-block h-px w-6"
                style={{ background: i < currentIdx ? 'var(--accent)' : 'var(--border-default)', opacity: i < currentIdx ? 0.5 : 1 }}
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}
