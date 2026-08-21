// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FlightIndexEntry } from '@/shared/api/client'
import type { ToastItem } from '@/shared/ui/atoms'
import { AGGREGATE_TOAST_ID } from './flight-toasts'
import { useFlightToasts } from './use-flight-toasts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The seed-vs-transition rules, the copy and the on-screen suppression are all
// `diffFlightToasts`, covered in flight-toasts.test.ts against the real rules —
// so nothing is stubbed here. What this suite proves is the part the pure module
// cannot: that the hook keeps its prev-key ref across renders, re-raises rather
// than duplicates an id, and wires each descriptor to the right navigation.
function flight(over: Partial<FlightIndexEntry>): FlightIndexEntry {
  return {
    flightId: 'fl-1', feature: 'checkout', status: 'running',
    startedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as FlightIndexEntry
}

let container: HTMLDivElement
let root: Root
let toasts: ToastItem[]
let dismiss: (id: string) => void
let openedFlights: string[]
let openedViews: number

function Probe({ flights, view, selectedFlightId, tag }: {
  flights: FlightIndexEntry[]
  view: string
  selectedFlightId: string | null
  /** Forces a fresh `nav` identity, which the hook must absorb via its ref
   *  rather than by re-running the diff effect. */
  tag: string
}) {
  const result = useFlightToasts(flights, view, selectedFlightId, {
    openFlight: (id) => { openedFlights.push(`${tag}:${id}`) },
    openFlightsView: () => { openedViews += 1 },
  })
  toasts = result.toasts
  dismiss = result.dismissToast
  return null
}

async function render(props: {
  flights: FlightIndexEntry[]
  view?: string
  selectedFlightId?: string | null
  tag?: string
}): Promise<void> {
  await act(async () => {
    root.render(
      <Probe
        flights={props.flights}
        view={props.view ?? 'workspace'}
        selectedFlightId={props.selectedFlightId ?? null}
        tag={props.tag ?? 'a'}
      />,
    )
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  toasts = []
  openedFlights = []
  openedViews = 0
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('useFlightToasts', () => {
  it('raises nothing when no flight is waiting on the user', async () => {
    await render({ flights: [flight({ status: 'running' })] })

    expect(toasts).toEqual([])
  })

  it('collapses the first load into one aggregate toast that opens the flights view', async () => {
    await render({
      flights: [
        flight({ flightId: 'fl-1', status: 'waiting-for-approval' }),
        flight({ flightId: 'fl-2', status: 'paused', pauseReason: 'stage-failed' }),
      ],
    })

    expect(toasts.map((t) => t.id)).toEqual([AGGREGATE_TOAST_ID])
    expect(toasts[0].title).toBe('2 flights need your input')
    expect(toasts[0].sticky).toBe(true)

    toasts[0].onClick?.()
    expect(openedViews).toBe(1)
    expect(openedFlights).toEqual([])
  })

  it('raises a per-flight toast on a transition, wired to that flight', async () => {
    await render({ flights: [flight({ flightId: 'fl-1', status: 'running' })] })
    expect(toasts).toEqual([])

    await render({
      flights: [flight({ flightId: 'fl-1', status: 'waiting-for-approval', currentStage: 'run' })],
    })

    expect(toasts.map((t) => t.id)).toEqual(['fl-1'])
    expect(toasts[0].title).toBe('checkout needs input')
    toasts[0].onClick?.()
    expect(openedFlights).toEqual(['a:fl-1'])
  })

  it('names a stage it has no label for by its raw key', async () => {
    await render({ flights: [flight({ flightId: 'fl-1' })] })
    // A newer server can report a stage this build has no label for; the toast
    // still has to say which one rather than reading as a generic failure.
    await render({
      flights: [flight({
        flightId: 'fl-1',
        status: 'paused',
        pauseReason: 'stage-failed',
        currentStage: 'future-stage' as FlightIndexEntry['currentStage'],
      })],
    })

    expect(toasts[0].body).toBe('future-stage failed — open to resume')
  })

  it('appends a second flight\'s toast without disturbing the first', async () => {
    await render({
      flights: [flight({ flightId: 'fl-1' }), flight({ flightId: 'fl-2', feature: 'search' })],
    })
    await render({
      flights: [
        flight({ flightId: 'fl-1', status: 'paused', pauseReason: 'stage-failed' }),
        flight({ flightId: 'fl-2', feature: 'search' }),
      ],
    })
    await render({
      flights: [
        flight({ flightId: 'fl-1', status: 'paused', pauseReason: 'stage-failed' }),
        flight({ flightId: 'fl-2', feature: 'search', status: 'waiting-for-approval' }),
      ],
    })

    expect(toasts.map((t) => t.id)).toEqual(['fl-1', 'fl-2'])
  })

  it('re-raises the same flight in place rather than stacking a duplicate', async () => {
    await render({ flights: [flight({ flightId: 'fl-1' })] })
    await render({ flights: [flight({ flightId: 'fl-1', status: 'paused', pauseReason: 'restart' })] })
    expect(toasts.map((t) => t.id)).toEqual(['fl-1'])
    expect(toasts[0].body).toContain('server restart')

    // A second attention transition for the same flight replaces its toast.
    await render({ flights: [flight({ flightId: 'fl-1', status: 'waiting-for-approval' })] })

    expect(toasts.map((t) => t.id)).toEqual(['fl-1'])
    expect(toasts[0].title).toBe('checkout needs input')
  })

  it('routes a re-raised toast through the newest nav callbacks', async () => {
    await render({ flights: [flight({ flightId: 'fl-1' })], tag: 'a' })
    await render({
      flights: [flight({ flightId: 'fl-1', status: 'waiting-for-approval' })],
      tag: 'b',
    })

    toasts[0].onClick?.()

    // Read through the ref, so the click uses the current props — not the
    // identities captured when the effect that raised the toast ran.
    expect(openedFlights).toEqual(['b:fl-1'])
  })

  it('dismisses one toast and leaves the rest', async () => {
    await render({
      flights: [flight({ flightId: 'fl-1' }), flight({ flightId: 'fl-2', feature: 'search' })],
    })
    await render({
      flights: [
        flight({ flightId: 'fl-1', status: 'waiting-for-approval' }),
        flight({ flightId: 'fl-2', feature: 'search', status: 'waiting-for-approval' }),
      ],
    })
    expect(toasts).toHaveLength(2)

    await act(async () => { dismiss('fl-1') })

    expect(toasts.map((t) => t.id)).toEqual(['fl-2'])
  })
})
