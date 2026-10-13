import { useCallback, useState } from 'react'

// The one home for reading and writing browser storage. Every key here is a
// convenience — a remembered toggle, a panel width, a tab's pending requests —
// so storage that is unavailable (private mode, blocked site data, a full
// quota) reads as "nothing stored" and a write is dropped, never thrown at a
// caller who could only show the user an error about a preference.

export type StorageArea = 'local' | 'session'

function storage(area: StorageArea): Storage {
  return area === 'session' ? window.sessionStorage : window.localStorage
}

/** The raw string under `key`, or null when nothing is stored or storage is
 *  unavailable. */
export function readStored(key: string, area: StorageArea = 'local'): string | null {
  try {
    return storage(area).getItem(key)
  } catch {
    return null /* storage unavailable — the caller's default stands */
  }
}

/** Store `value` under `key`; dropped when storage is unavailable. */
export function writeStored(key: string, value: string, area: StorageArea = 'local'): void {
  try {
    storage(area).setItem(key, value)
  } catch { /* storage unavailable or full — the preference just isn't remembered */ }
}

/** The parsed JSON under `key`, or undefined when nothing is stored, storage is
 *  unavailable, or the stored text is not JSON. Unvalidated: the caller checks
 *  the shape it expects. */
export function readStoredJson(key: string, area: StorageArea = 'local'): unknown {
  const raw = readStored(key, area)
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined /* a corrupt entry reads as absent; the next write replaces it */
  }
}

export function writeStoredJson(key: string, value: unknown, area: StorageArea = 'local'): void {
  writeStored(key, JSON.stringify(value), area)
}

/** How a boolean is spelled in storage. Keys written before this module keep
 *  their own spelling (`open`/`closed`), so an existing user's choice still
 *  reads. */
export interface FlagEncoding {
  on: string
  off: string
}

const TRUE_FALSE: FlagEncoding = { on: 'true', off: 'false' }

/** The stored boolean, or `defaultValue` when the key holds neither spelling. */
export function readStoredFlag(key: string, defaultValue: boolean, encoding: FlagEncoding = TRUE_FALSE): boolean {
  const raw = readStored(key)
  if (raw === encoding.on) return true
  if (raw === encoding.off) return false
  return defaultValue
}

/** A boolean UI choice that survives reloads: read once on mount, written on
 *  every change (never on mount, so an untouched default can still move). */
export function usePersistedFlag(
  key: string,
  defaultValue: boolean,
  encoding: FlagEncoding = TRUE_FALSE,
): [boolean, (next: boolean | ((current: boolean) => boolean)) => void] {
  const [value, setValue] = useState(() => readStoredFlag(key, defaultValue, encoding))
  const { on, off } = encoding
  const set = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    setValue((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      writeStored(key, resolved ? on : off)
      return resolved
    })
  }, [key, on, off])
  return [value, set]
}
