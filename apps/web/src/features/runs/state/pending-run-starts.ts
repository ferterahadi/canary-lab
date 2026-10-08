import { readStoredJson, writeStoredJson } from '@/shared/state/browser-storage'

export interface PendingRunStart {
  requestId: string
  feature: string
  mode: 'test' | 'boot'
}

const STORAGE_KEY = 'canary.pending-run-starts'

/** Continuation belongs to the server/client owner. This tab only remembers
 * which durable requests it should observe after a refresh. */
export function readPendingRunStarts(): PendingRunStart[] {
  // Storage can be unavailable or corrupt; live observation still works.
  const value = readStoredJson(STORAGE_KEY, 'session')
  return Array.isArray(value) ? value.filter((item): item is PendingRunStart =>
    !!item && typeof item.requestId === 'string' && typeof item.feature === 'string' && (item.mode === 'test' || item.mode === 'boot')) : []
}

/** A dropped write is fine: the server still retains the requests. */
export function savePendingRunStarts(requests: PendingRunStart[]): void {
  writeStoredJson(STORAGE_KEY, requests, 'session')
}
