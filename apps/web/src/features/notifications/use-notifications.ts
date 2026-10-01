import { useEffect, useRef, useState } from 'react'
import * as api from '@/shared/api/notifications'
import { useLiveResource } from '@/shared/state/use-live-resource'

export function useNotifications() {
  const resource = useLiveResource('notifications', 'workspace', () => api.getNotifications(), { reconcileMs: 10_000 })
  // Actions have their own UI lifetime; list ordering belongs to the reader.
  const [actionError, setActionError] = useState<{ value: typeof resource.value; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const lifetime = useRef({ active: false, busy: false })
  const latestValue = useRef(resource.value)
  latestValue.current = resource.value
  useEffect(() => {
    const mounted = { active: true, busy: false }
    lifetime.current = mounted
    return () => { mounted.active = false }
  }, [])
  const start = () => {
    const mounted = lifetime.current
    if (!mounted.active || mounted.busy) return null
    mounted.busy = true
    setBusy(true)
    return mounted
  }
  const fail = (message: string) => setActionError({ value: latestValue.current, message })
  const finish = (mounted: typeof lifetime.current) => {
    if (mounted.active) { mounted.busy = false; setBusy(false) }
  }
  return {
    items: resource.value ?? [],
    error: resource.error ?? (actionError?.value === resource.value ? actionError.message : null),
    loading: resource.value === null && !resource.error,
    busy,
    refresh: resource.refresh,
    resolveAction: async (id: string): Promise<{ target: api.NotificationTarget; item: api.WorkspaceNotification } | undefined> => {
      const mounted = start()
      if (!mounted) return undefined
      try {
        const result = await api.resolveNotificationAction(id)
        if (!mounted.active || !resource.accept(result.items)) return undefined
        setActionError(result.status === 'unavailable'
          ? { value: result.items, message: 'Could not verify the current notification. Retrying automatically.' } : null)
        const item = result.items.find((entry) => entry.id === id)
        return result.status === 'current' && item && result.target ? { target: result.target, item } : undefined
      } catch (err) {
        if (mounted.active) fail(err instanceof Error ? err.message : 'Could not verify notification action')
        return undefined
      } finally { finish(mounted) }
    },
    remove: async (id: string): Promise<boolean> => {
      const mounted = start()
      if (!mounted) return false
      try {
        await api.deleteNotification(id)
        if (!mounted.active || !resource.accept((current) => (current ?? []).filter((item) => item.id !== id))) return false
        setActionError(null)
        return true
      } catch (err) {
        if (mounted.active) fail(err instanceof Error ? err.message : 'Could not update notifications')
        return false
      } finally { finish(mounted) }
    },
  }
}
