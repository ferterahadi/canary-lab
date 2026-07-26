import { useCallback, useEffect, useRef, useState } from 'react'
import type { FlightIndexEntry } from '@/shared/api/client'
import { STAGE_LABEL } from '../components/stage-meta'
import type { ToastItem } from '@/features/config/components/atoms'
import { attentionKeyMap, diffFlightToasts } from './flight-toasts'

// R51/R68 attention toasts. The decision of WHICH flights to toast, the seed
// vs transition rules, the aggregate collapse, and the on-screen suppression
// all live in the pure `diffFlightToasts`; this hook owns only the React state
// (the live toast list + the prev-attention-key ref) and attaches navigation to
// each descriptor. Kept out of App so the App is layout + wiring, not logic.

interface FlightToastNav {
  /** Open a specific flight's detail (a per-flight toast). */
  openFlight: (flightId: string) => void
  /** Open the flights view with no flight selected (the aggregate toast). */
  openFlightsView: () => void
}

export function useFlightToasts(
  flights: FlightIndexEntry[],
  view: string,
  selectedFlightId: string | null,
  nav: FlightToastNav,
): { toasts: ToastItem[]; dismissToast: (id: string) => void } {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const dismissToast = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const prevRef = useRef<Map<string, string> | null>(null)
  // Read nav via a ref so the diff effect doesn't re-run when the caller passes
  // fresh callback identities — its real inputs are the flights + what's on screen.
  const navRef = useRef(nav)
  navRef.current = nav

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = attentionKeyMap(flights)
    const descriptors = diffFlightToasts(
      prev,
      flights,
      { view, selectedFlightId },
      (stage) => (stage ? STAGE_LABEL[stage] ?? stage : null),
    )
    if (descriptors.length === 0) return
    setToasts((current) => {
      let next = current
      for (const d of descriptors) {
        const onClick = d.kind === 'aggregate'
          ? () => navRef.current.openFlightsView()
          : () => navRef.current.openFlight(d.flightId)
        // Replace any existing toast with the same id (re-raise), append otherwise.
        next = [...next.filter((x) => x.id !== d.id), { id: d.id, title: d.title, body: d.body, sticky: true, onClick }]
      }
      return next
    })
  }, [flights, view, selectedFlightId])

  return { toasts, dismissToast }
}
