import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readStored,
  readStoredFlag,
  readStoredJson,
  usePersistedFlag,
  writeStored,
  writeStoredJson,
  type FlagEncoding,
} from './browser-storage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Makes both storage areas throw on access, the way a private-mode browser or
 *  blocked site data does. Patching `getItem` alone would miss the getter. */
function withUnavailableStorage(run: () => void): void {
  const local = Object.getOwnPropertyDescriptor(window, 'localStorage')!
  const session = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!
  const blocked = { configurable: true, get: () => { throw new Error('SecurityError') } }
  Object.defineProperty(window, 'localStorage', blocked)
  Object.defineProperty(window, 'sessionStorage', blocked)
  try { run() } finally {
    Object.defineProperty(window, 'localStorage', local)
    Object.defineProperty(window, 'sessionStorage', session)
  }
}

beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear() })

describe('raw and JSON values', () => {
  it('round-trips a string in either area, separately', () => {
    writeStored('k', 'local value')
    writeStored('k', 'session value', 'session')
    expect(readStored('k')).toBe('local value')
    expect(readStored('k', 'session')).toBe('session value')
    expect(readStored('missing')).toBeNull()
  })

  it('round-trips JSON and reads a missing or corrupt entry as absent', () => {
    writeStoredJson('j', { a: 1 }, 'session')
    expect(readStoredJson('j', 'session')).toEqual({ a: 1 })
    expect(window.sessionStorage.getItem('j')).toBe('{"a":1}')
    expect(readStoredJson('missing')).toBeUndefined()
    window.localStorage.setItem('bad', '{not json')
    expect(readStoredJson('bad')).toBeUndefined()
  })

  it('reads nothing and drops writes when storage is unavailable', () => {
    window.localStorage.setItem('k', 'kept')
    withUnavailableStorage(() => {
      expect(readStored('k')).toBeNull()
      expect(readStoredJson('k')).toBeUndefined()
      expect(() => writeStored('k', 'lost')).not.toThrow()
      expect(() => writeStoredJson('k', [1], 'session')).not.toThrow()
    })
    expect(readStored('k')).toBe('kept')
  })
})

describe('readStoredFlag', () => {
  const OPEN_CLOSED: FlagEncoding = { on: 'open', off: 'closed' }

  it('reads either spelling and falls back to the default for anything else', () => {
    expect(readStoredFlag('f', true)).toBe(true)
    expect(readStoredFlag('f', false)).toBe(false)
    window.localStorage.setItem('f', 'false')
    expect(readStoredFlag('f', true)).toBe(false)
    window.localStorage.setItem('f', 'true')
    expect(readStoredFlag('f', false)).toBe(true)
    window.localStorage.setItem('f', 'garbage')
    expect(readStoredFlag('f', true)).toBe(true)
  })

  it('honours a legacy spelling', () => {
    window.localStorage.setItem('rail', 'closed')
    expect(readStoredFlag('rail', true, OPEN_CLOSED)).toBe(false)
    window.localStorage.setItem('rail', 'open')
    expect(readStoredFlag('rail', false, OPEN_CLOSED)).toBe(true)
  })
})

describe('usePersistedFlag', () => {
  let root: Root
  let flag: boolean
  let setFlag: (next: boolean | ((current: boolean) => boolean)) => void
  function Probe({ encoding }: { encoding?: FlagEncoding }) {
    [flag, setFlag] = usePersistedFlag('flag', true, encoding)
    return null
  }
  beforeEach(() => { root = createRoot(document.createElement('div')) })
  afterEach(() => { act(() => root.unmount()) })

  it('starts from the default without writing it, then persists each change', () => {
    act(() => root.render(<Probe />))
    expect(flag).toBe(true)
    expect(window.localStorage.getItem('flag')).toBeNull()
    act(() => setFlag(false))
    expect(flag).toBe(false)
    expect(window.localStorage.getItem('flag')).toBe('false')
    act(() => setFlag((current) => !current))
    expect(flag).toBe(true)
    expect(window.localStorage.getItem('flag')).toBe('true')
  })

  it('reads an earlier choice back in its own spelling', () => {
    window.localStorage.setItem('flag', 'closed')
    act(() => root.render(<Probe encoding={{ on: 'open', off: 'closed' }} />))
    expect(flag).toBe(false)
    act(() => setFlag(true))
    expect(window.localStorage.getItem('flag')).toBe('open')
  })
})
