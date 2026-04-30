import { useEffect, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'canary-lab.theme'
const EVENT_NAME = 'cl:theme'

export function getStoredChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* localStorage may be unavailable */ }
  return 'system'
}

function setStoredChoice(choice: ThemeChoice): void {
  try { localStorage.setItem(STORAGE_KEY, choice) } catch { /* ignore */ }
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return choice
}

export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  window.dispatchEvent(new CustomEvent<ResolvedTheme>(EVENT_NAME, { detail: resolved }))
  return resolved
}

// Apply once before React mounts to avoid a flash. Safe to call repeatedly.
export function bootstrapTheme(): void {
  applyTheme(getStoredChoice())
}

export function useTheme(): {
  choice: ThemeChoice
  resolved: ResolvedTheme
  setChoice: (choice: ThemeChoice) => void
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => getStoredChoice())
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(getStoredChoice()))

  // Re-resolve when the OS theme changes and the user is in 'system' mode.
  useEffect(() => {
    if (choice !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => { setResolved(applyTheme('system')) }
    mq.addEventListener('change', onChange)
    return () => { mq.removeEventListener('change', onChange) }
  }, [choice])

  const setChoice = (next: ThemeChoice): void => {
    setStoredChoice(next)
    setChoiceState(next)
    setResolved(applyTheme(next))
  }

  return { choice, resolved, setChoice }
}

// For non-React listeners (xterm, Shiki) that need to react to live theme changes.
export function subscribeTheme(listener: (theme: ResolvedTheme) => void): () => void {
  const handler = (e: Event): void => {
    const ce = e as CustomEvent<ResolvedTheme>
    listener(ce.detail)
  }
  window.addEventListener(EVENT_NAME, handler)
  return () => { window.removeEventListener(EVENT_NAME, handler) }
}

export function currentResolvedTheme(): ResolvedTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}
