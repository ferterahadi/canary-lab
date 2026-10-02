import { useCallback, useEffect, useRef, useState } from 'react'
import { listDiscoveryRepairs, startDiscoveryRepair, type DiscoveryRepairView } from '../api/discovery-repair'
import { useMountedIdentity } from '../state/use-mounted-identity'
import { connectReconnectingSocket, defaultWsBase } from '../api/reconnecting-socket'

export function useDiscoveryRepair(feature: string | null) {
  const [snapshot, setSnapshot] = useState<{ feature: string; repairs: DiscoveryRepairView[] } | null>(null)
  const pending = useRef(new Map<string, symbol>())
  const [, renderPending] = useState(0)
  const current = useMountedIdentity(feature ?? '')
  const mounted = useMountedIdentity('discovery-repair')
  // Only a failed `start` reaches here. A dropped socket used to set this too,
  // which put an amber line in the tests column for a transport blip on a
  // stream that is open for every suite, repair or no repair — and, because the
  // line was not gated on a run, over a run's recorded roster as well.
  const [startError, setStartError] = useState<string | null>(null)
  useEffect(() => {
    setStartError(null)
    if (!feature) return
    let cancelled = false
    let receivedStream = false
    void listDiscoveryRepairs(feature).then((repairs) => {
      if (!cancelled && !receivedStream && Array.isArray(repairs)) setSnapshot({ feature, repairs })
    }).catch(() => { /* The task stream supplies the same snapshot when REST races a reconnect. */ })
    const connection = connectReconnectingSocket({
      url: `${defaultWsBase()}/ws/features/${encodeURIComponent(feature)}/discovery-repairs`,
      maxReconnects: Infinity, reconnectDelayMs: 1000,
      onMessage: (data) => {
        try {
          const value = JSON.parse(data) as { repairs?: DiscoveryRepairView[] }
          if (!cancelled && Array.isArray(value.repairs)) { receivedStream = true; setSnapshot({ feature, repairs: value.repairs }) }
        } catch { /* Ignore malformed frames; reconnect snapshots remain authoritative. */ }
      },
    })
    return () => { cancelled = true; connection.close() }
  }, [feature])
  const start = useCallback(async () => {
    if (!feature || !current() || pending.current.has(feature)) return
    const operation = Symbol(feature)
    pending.current.set(feature, operation)
    renderPending((version) => version + 1)
    setStartError(null)
    try {
      const repair = await startDiscoveryRepair(feature)
      if (current()) setSnapshot((previous) => {
        const repairs = previous?.feature === feature ? previous.repairs : []
        // A terminal stream snapshot can beat the POST response.
        if (repairs.some((r) => r.id === repair.id && r.updatedAt >= repair.updatedAt)) return previous
        return { feature, repairs: [repair, ...repairs.filter((r) => r.id !== repair.id)] }
      })
    } catch (err) { if (current()) setStartError(err instanceof Error ? err.message : String(err)) }
    finally {
      if (pending.current.get(feature) === operation) pending.current.delete(feature)
      if (mounted()) renderPending((version) => version + 1)
    }
  }, [feature, current, mounted])
  return { repairs: snapshot?.feature === feature ? snapshot.repairs : [], start, starting: feature !== null && pending.current.has(feature), startError }
}
