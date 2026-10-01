import type { WorkspaceStreamFrame as WorkspaceEvent } from '@shared/workspace-events'
import { useCallback, useEffect, useRef, useState } from 'react'
import { connectWorkspaceEvents } from '@/shared/api/workspace-socket'
import { createObservedReads } from './observed-reads'

export interface RecordSyncState {
  loading: boolean
  stale: boolean
  error: string | null
}

export type RecordMutation<T> =
  | { kind: 'upsert'; record: T; created?: boolean }
  | { kind: 'remove'; id: string }

interface WorkspaceRecordsOptions<T> {
  list: () => Promise<T[]>
  idOf: (record: T) => string
  decode: (event: WorkspaceEvent) => RecordMutation<T> | null
  onUpsert?: (record: T, created: boolean) => void
  onRemove?: (id: string) => void
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
}

/** Records share recovery and ordering; feature adapters retain task actions
 * and log subscriptions. Local observations survive overlapping list reads. */
export function useWorkspaceRecords<T>(options: WorkspaceRecordsOptions<T>) {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [records, setRecords] = useState<Record<string, T>>({})
  const recordsRef = useRef(records)
  const [sync, setSync] = useState<RecordSyncState>({ loading: true, stale: true, error: null })
  const clock = useRef(0)
  // Retain deletion revisions for the provider lifetime: a late list may still
  // contain a removed id even though it no longer appears in recordsRef.
  const revisions = useRef(new Map<string, number>())
  const reads = useRef(createObservedReads())
  const alive = useRef(false)
  const refreshRef = useRef<() => void>(() => {})

  const upsert = useCallback((record: T, created = false): void => {
    if (!alive.current) return
    const id = optionsRef.current.idOf(record)
    revisions.current.set(id, ++clock.current)
    reads.current.invalidate(id)
    recordsRef.current = { ...recordsRef.current, [id]: record }
    setRecords(recordsRef.current)
    optionsRef.current.onUpsert?.(record, created)
  }, [])

  const remove = useCallback((id: string): void => {
    if (!alive.current) return
    revisions.current.set(id, ++clock.current)
    reads.current.invalidate(id)
    const { [id]: _removed, ...remaining } = recordsRef.current
    recordsRef.current = remaining
    setRecords(remaining)
    optionsRef.current.onRemove?.(id)
  }, [])

  const readRecord = useCallback(async (id: string, fetch: () => Promise<T>): Promise<void> => {
    if (!alive.current) return
    const token = reads.current.begin(id)
    if (!token) return
    try {
      const record = await fetch()
      if (alive.current && reads.current.current(id, token)) upsert(record)
    } finally {
      reads.current.finish(id, token)
    }
  }, [upsert])

  const refresh = useCallback(() => refreshRef.current(), [])
  const { wsBase, WebSocketImpl } = options
  useEffect(() => {
    alive.current = true
    const detailReads = reads.current
    let disposed = false
    let requested = 0
    let queued = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const visible = () => document.visibilityState !== 'hidden'
    const schedule = () => {
      if (disposed || queued) return
      queued = true
      // A socket handshake and initial load in the same turn need one read.
      queueMicrotask(() => {
        queued = false
        if (!disposed) fetchList()
      })
    }
    const fetchList = () => {
      clearTimeout(retry)
      const request = ++requested
      const started = clock.current
      setSync((previous) => ({ ...previous, loading: true }))
      void Promise.resolve().then(() => optionsRef.current.list()).then((incoming) => {
        if (disposed || request !== requested) return
        const current = recordsRef.current
        const listed = Object.fromEntries(incoming.map((record) => [optionsRef.current.idOf(record), record]))
        const next = { ...current }
        const accepted: T[] = []
        const removed: string[] = []
        let conflicted = false
        for (const id of new Set([...Object.keys(current), ...Object.keys(listed)])) {
          if ((revisions.current.get(id) ?? 0) > started) {
            conflicted = true
            continue
          }
          reads.current.invalidate(id)
          revisions.current.set(id, ++clock.current)
          if (Object.hasOwn(listed, id)) {
            next[id] = listed[id]
            accepted.push(listed[id])
          } else {
            delete next[id]
            removed.push(id)
          }
        }
        recordsRef.current = next
        setRecords(next)
        setSync({ loading: false, stale: conflicted, error: null })
        for (const id of removed) optionsRef.current.onRemove?.(id)
        for (const record of accepted) optionsRef.current.onUpsert?.(record, false)
        if (conflicted) retry = setTimeout(() => { if (visible()) schedule() }, 2500)
      }).catch((error: unknown) => {
        if (disposed || request !== requested) return
        setSync({ loading: false, stale: true, error: error instanceof Error ? error.message : String(error) })
        retry = setTimeout(() => { if (visible()) schedule() }, 2500)
      })
    }
    refreshRef.current = schedule
    let connection: { close(): void } | undefined
    try {
      connection = connectWorkspaceEvents({
        wsBase,
        WebSocketImpl,
        onEvent: (event) => {
          if (event.type === 'connected') { schedule(); return }
          const mutation = optionsRef.current.decode(event)
          if (mutation?.kind === 'upsert') upsert(mutation.record, mutation.created)
          if (mutation?.kind === 'remove') remove(mutation.id)
        },
        // Some clients/tests expose reopen before the handshake. Coalescing
        // lets either signal recover without issuing duplicate same-turn reads.
        onReconnect: schedule,
        onDisconnect: () => {
          requested++
          detailReads.clear()
          setSync({ loading: false, stale: true, error: 'Connection lost; showing last known state.' })
        },
      })
    } catch {
      // HTTP reconciliation remains available when no socket can be created.
    }
    schedule()
    const reconcile = () => { if (visible()) schedule() }
    const interval = setInterval(reconcile, 30_000)
    document.addEventListener('visibilitychange', reconcile)
    window.addEventListener('online', reconcile)
    return () => {
      disposed = true
      alive.current = false
      detailReads.clear()
      refreshRef.current = () => {}
      clearTimeout(retry)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', reconcile)
      window.removeEventListener('online', reconcile)
      connection?.close()
    }
  }, [wsBase, WebSocketImpl, upsert, remove])

  return { records, recordsRef, sync, upsert, remove, readRecord, refresh }
}
