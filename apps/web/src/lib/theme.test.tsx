// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  getStoredChoice,
  resolveTheme,
  applyTheme,
  bootstrapTheme,
  subscribeTheme,
  currentResolvedTheme,
  useTheme,
} from './theme'

const STORAGE_KEY = 'canary-lab.theme'

function createStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => { data.delete(key) },
    setItem: (key, value) => { data.set(key, value) },
  }
}

function installStorage(storage: Storage): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
}

beforeEach(() => {
  document.documentElement.className = ''
  installStorage(createStorage())
  localStorage.clear()
  // Default matchMedia stub: prefers dark.
  window.matchMedia = (q: string) =>
    ({
      matches: q.includes('dark'),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList
})

describe('getStoredChoice', () => {
  it('returns dark when storage is empty', () => {
    expect(getStoredChoice()).toBe('dark')
  })

  it('returns the stored value when valid', () => {
    localStorage.setItem(STORAGE_KEY, 'light')
    expect(getStoredChoice()).toBe('light')
    localStorage.setItem(STORAGE_KEY, 'system')
    expect(getStoredChoice()).toBe('system')
  })

  it('falls back to dark on invalid stored value', () => {
    localStorage.setItem(STORAGE_KEY, 'rainbow')
    expect(getStoredChoice()).toBe('dark')
  })

  it('falls back to dark when localStorage throws', () => {
    const windowOrig = Object.getOwnPropertyDescriptor(window, 'localStorage')!
    const globalOrig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
    const throwingStorage = {
      configurable: true,
      get() { throw new Error('blocked') },
    }
    Object.defineProperty(window, 'localStorage', throwingStorage)
    Object.defineProperty(globalThis, 'localStorage', throwingStorage)
    try {
      expect(getStoredChoice()).toBe('dark')
    } finally {
      Object.defineProperty(window, 'localStorage', windowOrig)
      Object.defineProperty(globalThis, 'localStorage', globalOrig)
    }
  })
})

describe('resolveTheme', () => {
  it('passes light/dark through', () => {
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('consults matchMedia for system', () => {
    expect(resolveTheme('system')).toBe('dark')
    window.matchMedia = (q: string) =>
      ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
    expect(resolveTheme('system')).toBe('light')
  })
})

describe('applyTheme', () => {
  it('toggles the dark class on documentElement', () => {
    applyTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('dispatches the cl:theme event with the resolved theme', () => {
    const seen: string[] = []
    const handler = (e: Event): void => {
      seen.push((e as CustomEvent<string>).detail)
    }
    window.addEventListener('cl:theme', handler)
    try {
      applyTheme('light')
      applyTheme('dark')
    } finally {
      window.removeEventListener('cl:theme', handler)
    }
    expect(seen).toEqual(['light', 'dark'])
  })
})

describe('bootstrapTheme + currentResolvedTheme', () => {
  it('applies the stored theme and is idempotent', () => {
    localStorage.setItem(STORAGE_KEY, 'light')
    bootstrapTheme()
    bootstrapTheme()
    expect(currentResolvedTheme()).toBe('light')
  })

  it('reflects the dark class on documentElement', () => {
    document.documentElement.classList.add('dark')
    expect(currentResolvedTheme()).toBe('dark')
    document.documentElement.classList.remove('dark')
    expect(currentResolvedTheme()).toBe('light')
  })
})

describe('subscribeTheme', () => {
  it('fires on applyTheme and stops after unsubscribe', () => {
    const calls: string[] = []
    const unsub = subscribeTheme((t) => calls.push(t))
    applyTheme('light')
    unsub()
    applyTheme('dark')
    expect(calls).toEqual(['light'])
  })
})

describe('useTheme', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  function captureHook() {
    const captured: { current: ReturnType<typeof useTheme> | null } = { current: null }
    function Probe() {
      captured.current = useTheme()
      return null
    }
    return { captured, Probe }
  }

  it('initializes from storage', () => {
    localStorage.setItem(STORAGE_KEY, 'light')
    const { captured, Probe } = captureHook()
    act(() => { root.render(<Probe />) })
    expect(captured.current?.choice).toBe('light')
    expect(captured.current?.resolved).toBe('light')
  })

  it('setChoice updates state, storage, and DOM', () => {
    const { captured, Probe } = captureHook()
    act(() => { root.render(<Probe />) })
    act(() => { captured.current?.setChoice('light') })
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
    expect(captured.current?.choice).toBe('light')
    expect(captured.current?.resolved).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('subscribes to matchMedia change when choice is system', () => {
    const handlers: Array<(e: MediaQueryListEvent) => void> = []
    let removed = 0
    window.matchMedia = (q: string) =>
      ({
        matches: true,
        media: q,
        addEventListener: (_: string, h: (e: MediaQueryListEvent) => void) => { handlers.push(h) },
        removeEventListener: () => { removed++ },
      }) as unknown as MediaQueryList
    const { captured, Probe } = captureHook()
    act(() => { root.render(<Probe />) })
    act(() => { captured.current?.setChoice('system') })
    expect(handlers.length).toBe(1)
    // Simulating the OS flipping shouldn't throw.
    act(() => { handlers[0]({ matches: false } as MediaQueryListEvent) })
    // Switching away from system unsubscribes.
    act(() => { captured.current?.setChoice('light') })
    expect(removed).toBeGreaterThan(0)
  })
})
