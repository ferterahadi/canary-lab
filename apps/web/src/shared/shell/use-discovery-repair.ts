import { useCallback, useEffect, useRef, useState } from 'react'
import { listDiscoveryRepairs, startDiscoveryRepair, type DiscoveryRepairView } from '../api/discovery-repair'
import { connectReconnectingSocket, defaultWsBase } from '../api/reconnecting-socket'

export function useDiscoveryRepair(feature: string | null) {
  const [snapshot, setSnapshot] = useState<{ feature: string; repairs: DiscoveryRepairView[] } | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const featureRef = useRef(feature)
  featureRef.current = feature
  useEffect(() => {
    if (!feature) return
    let cancelled = false
    let receivedStream = false
    setError(null)
    void listDiscoveryRepairs(feature).then((repairs) => {
      if (!cancelled && !receivedStream && Array.isArray(repairs)) setSnapshot({ feature, repairs })
    }).catch(() => { /* The task stream supplies the same snapshot when REST races a reconnect. */ })
    const connection = connectReconnectingSocket({
      url: `${defaultWsBase()}/ws/features/${encodeURIComponent(feature)}/discovery-repairs`,
      maxReconnects: Infinity, reconnectDelayMs: 1000,
      onMessage: (data) => {
        try {
          const value = JSON.parse(data) as { repairs?: DiscoveryRepairView[] }
          if (!cancelled && Array.isArray(value.repairs)) { receivedStream = true; setSnapshot({ feature, repairs: value.repairs }); setError(null) }
        } catch { /* Ignore malformed frames; reconnect snapshots remain authoritative. */ }
      },
      onReconnect: () => { if (!cancelled) setError('Reconnecting to repair progress…') },
    })
    return () => { cancelled = true; connection.close() }
  }, [feature])
  const start = useCallback(async () => {
    if (!feature) return
    setStarting(true)
    setError(null)
    try {
      const repair = await startDiscoveryRepair(feature)
      if (featureRef.current === feature) setSnapshot((previous) => {
        const repairs = previous?.feature === feature ? previous.repairs : []
        // A terminal stream snapshot can beat the POST response.
        if (repairs.some((r) => r.id === repair.id && r.updatedAt >= repair.updatedAt)) return previous
        return { feature, repairs: [repair, ...repairs.filter((r) => r.id !== repair.id)] }
      })
    } catch (err) { if (featureRef.current === feature) setError(err instanceof Error ? err.message : String(err)) }
    finally { setStarting(false) }
  }, [feature])
  return { repairs: snapshot?.feature === feature ? snapshot.repairs : [], start, starting, error }
}
