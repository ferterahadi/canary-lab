// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FlightIndexEntry } from '@shared/flights/types'
import type { FeatureActivity } from '@/features/flights/state/feature-activity'
import { WorkStateProvider, useWorkState, type WorkState } from './work-state'
import { mountRoot } from '@/test-helpers/mount-root'

let root: Root
let seen: WorkState[]

mountRoot({ attach: true, onMount: (mounted) => ({ root } = mounted) })
beforeEach(() => {
  seen = []
})

function Probe() {
  seen.push(useWorkState())
  return null
}

describe('useWorkState', () => {
  it('reads a frozen object with every field undefined when no provider is above it', async () => {
    await act(async () => root.render(<Probe />))
    const state = seen.at(-1)!
    expect(state.flights).toBeUndefined()
    expect(state.activity).toBeUndefined()
    expect(Object.isFrozen(state)).toBe(true)
  })

  it('passes the exact references it was given', async () => {
    const snapshot: Required<WorkState> = {
      flights: [{ flightId: 'fl_1' } as FlightIndexEntry],
      preFlights: [],
      activity: new Map<string, FeatureActivity>([['checkout', { kind: 'running', runId: 'r1' }]]),
      externalHistory: new Map(),
      coverageJobs: [],
      portifyWorkflows: [],
      derivedStages: new Map(),
      pickerFeatures: [{ name: 'checkout', group: 'shop' }],
    }
    await act(async () => root.render(<WorkStateProvider {...snapshot}><Probe /></WorkStateProvider>))
    const state = seen.at(-1)!
    for (const key of Object.keys(snapshot) as Array<keyof WorkState>) expect(state[key]).toBe(snapshot[key])
  })

  // A leaf's own `useMemo` over a field must recompute exactly when it did with
  // the field passed as a prop: a re-render with the same references keeps the
  // value, and a new reference for one field replaces it.
  it('keeps the value while the references hold, and replaces it when one changes', async () => {
    const flights: FlightIndexEntry[] = []
    const activity = new Map<string, FeatureActivity>()
    const mount = (current: Map<string, FeatureActivity>) => root.render(
      <WorkStateProvider flights={flights} activity={current}><Probe /></WorkStateProvider>,
    )
    await act(async () => mount(activity))
    await act(async () => mount(activity))
    expect(seen[1]).toBe(seen[0])

    const next = new Map<string, FeatureActivity>([['pay', { kind: 'portifying', workflowId: 'wf1' }]])
    await act(async () => mount(next))
    expect(seen[2]).not.toBe(seen[1])
    expect(seen[2].activity).toBe(next)
    expect(seen[2].flights).toBe(flights)
  })
})
