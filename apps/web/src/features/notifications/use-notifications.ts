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

  const act = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      await action()
      await refresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update notifications')
      return false
    } finally { setBusy(false) }
  }

  return {
    items, error, loading, busy, refresh,
    add: (title: string, body: string) => act(() => api.addNotification(title, body)),
    remove: (id: string) => act(() => api.deleteNotification(id)),
    read: (id: string) => act(() => api.readNotification(id)),
  }
}
