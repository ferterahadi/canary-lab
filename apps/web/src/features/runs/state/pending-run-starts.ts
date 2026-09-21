export interface PendingRunStart {
  requestId: string
  feature: string
  mode: 'test' | 'boot'
}

const STORAGE_KEY = 'canary.pending-run-starts'

/** Continuation belongs to the server/client owner. This tab only remembers
 * which durable requests it should observe after a refresh. */
export function readPendingRunStarts(): PendingRunStart[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is PendingRunStart =>
      !!item && typeof item.requestId === 'string' && typeof item.feature === 'string' && (item.mode === 'test' || item.mode === 'boot')) : []
  } catch { return [] /* Storage can be unavailable; live observation still works. */ }
}

export function savePendingRunStarts(requests: PendingRunStart[]): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(requests)) }
  catch { /* Storage can be unavailable; the server still retains the requests. */ }
}
