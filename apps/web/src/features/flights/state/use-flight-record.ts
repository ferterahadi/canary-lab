import { useCallback, useRef } from 'react'
import { ApiError, getFlight, type FlightManifest } from '@/shared/api/client'
import { useLiveResource } from '@/shared/state/use-live-resource'

const RECONCILE_MS = 30_000

/** Pushes supply the record; REST only fills gaps and checks a quiet channel.
 * A failed read retains evidence, but a confirmed 404 must retire it. */
export function useFlightRecord(id: string | null, live: FlightManifest | null | undefined, missing: boolean, refreshKey: number) {
  const push = useRef({ live, at: Date.now() })
  if (push.current.live !== live) push.current = { live, at: Date.now() }
  const resource = useLiveResource('flights', missing ? null : id, async (key) => {
    const current = push.current
    if (current.live?.flightId === key && Date.now() - current.at < RECONCILE_MS) {
      return { manifest: current.live, observedPush: current.live }
    }
    try {
      return { manifest: await getFlight(key), observedPush: current.live }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { manifest: null, observedPush: current.live }
      throw error
    }
  }, { refreshKey: JSON.stringify([refreshKey, live?.flightId]), reconcileMs: RECONCILE_MS, pauseWhenHidden: true })
  const refreshResource = resource.refresh
  const refresh = useCallback(() => {
    push.current.at = -Infinity
    refreshResource()
  }, [refreshResource])
  const absent = missing || (resource.value?.manifest === null && resource.value.observedPush === live)
  const currentLive = live?.flightId === id ? live : null
  return {
    manifest: absent ? null : resource.value && resource.value.observedPush === live
      ? resource.value.manifest : currentLive ?? resource.value?.manifest ?? null,
    missing: absent,
    error: resource.error,
    refresh,
  }
}
