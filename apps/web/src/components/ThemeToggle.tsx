import type { ReactNode } from 'react'
import { useTheme, type ThemeChoice } from '../lib/theme'

const OPTIONS: { value: ThemeChoice; label: string; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'Light',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    ),
  },
  {
    value: 'system',
    label: 'System',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="4" width="20" height="14" rx="2" />
        <path d="M8 22h8M12 18v4" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
      </svg>
    ),
  },
]

export function ThemeToggle() {
  const { choice, setChoice } = useTheme()
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-md p-0.5"
      style={{ border: '1px solid var(--border-default)', background: 'var(--bg-input)' }}
    >
      {OPTIONS.map((opt) => {
        const active = choice === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.label}
            onClick={() => setChoice(opt.value)}
            className="flex flex-1 items-center justify-center rounded-md px-2 py-1 transition-colors duration-150"
            style={{
              color: active ? 'var(--text-primary)' : 'var(--text-muted)',
              background: active ? 'var(--bg-selected)' : 'transparent',
              boxShadow: active ? 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 16%, transparent)' : 'none',
            }}
          >
            {opt.icon}
          </button>
        )
      })}
    </div>
  )
}
