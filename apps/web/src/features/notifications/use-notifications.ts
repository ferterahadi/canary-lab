import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '@/shared/api/notifications'
import { useInvalidationKey } from '@/shared/state/invalidation'

export function useNotifications() {
  const [items, setItems] = useState<api.WorkspaceNotification[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const version = useInvalidationKey('notifications')
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++generation.current
    try {
      const next = await api.getNotifications()
      if (current === generation.current) { setItems(next); setError(null) }
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : 'Could not load notifications')
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    return () => { generation.current++ }
  }, [refresh, version])
  // Workspace events are the fast path. The bus has no replay, so a bounded
  // reconciliation keeps this attention surface current after a dropped frame
  // even when the socket never disconnects and triggers its full resync.
  useEffect(() => {
    const interval = setInterval(() => { void refresh() }, 10_000)
    return () => clearInterval(interval)
  }, [refresh])

  return {
    items, error, loading, busy, refresh,
    resolveAction: async (id: string): Promise<{ target: api.NotificationTarget; item: api.WorkspaceNotification } | undefined> => {
      setBusy(true)
      try {
        const result = await api.resolveNotificationAction(id)
        // The action response is a fresh server snapshot; an older list request
        // must not put its stale row back while navigation is happening.
        generation.current++
        setItems(result.items)
        setError(result.status === 'unavailable' ? 'Could not verify the current notification. Retrying automatically.' : null)
        const item = result.items.find((entry) => entry.id === id)
        return result.status === 'current' && item && result.target ? { target: result.target, item } : undefined
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not verify notification action')
        return undefined
      } finally { setBusy(false) }
    },
    remove: async (id: string): Promise<boolean> => {
      setBusy(true)
      try {
        await api.deleteNotification(id)
        // A list request started before the delete must not restore its stale row.
        generation.current++
        setItems((current) => current.filter((item) => item.id !== id))
        setError(null)
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update notifications')
        return false
      } finally { setBusy(false) }
    },
  }
}
