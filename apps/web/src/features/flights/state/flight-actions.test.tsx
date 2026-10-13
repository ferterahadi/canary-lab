// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FlightActionsProvider, useFlightActions, type FlightActions } from './flight-actions'
import { mountRoot } from '@/test-helpers/mount-root'

let root: Root
let seen: FlightActions[]

mountRoot({ attach: true, onMount: (mounted) => ({ root } = mounted) })
beforeEach(() => {
  seen = []
})

function Probe() {
  seen.push(useFlightActions())
  return null
}

describe('useFlightActions', () => {
  it('reads a frozen empty object outside a provider, so every drill-through stays hidden', async () => {
    await act(async () => root.render(<Probe />))
    expect(seen.at(-1)).toEqual({})
    expect(Object.isFrozen(seen.at(-1))).toBe(true)
  })

  it('hands the stages the callbacks the provider was given', async () => {
    const actions = {
      onOpenRun: vi.fn(), onOpenCoverage: vi.fn(), onOpenConfig: vi.fn(), onOpenSpecReview: vi.fn(), onStartFlight: vi.fn(),
    }
    await act(async () => root.render(<FlightActionsProvider {...actions}><Probe /></FlightActionsProvider>))
    expect(seen.at(-1)).toEqual(actions)
  })

  it('keeps the value while the callbacks keep their identity, and replaces it when one changes', async () => {
    const onOpenRun = vi.fn()
    const mount = (onOpenCoverage: () => void) => root.render(
      <FlightActionsProvider onOpenRun={onOpenRun} onOpenCoverage={onOpenCoverage}><Probe /></FlightActionsProvider>,
    )
    const first = vi.fn()
    await act(async () => mount(first))
    await act(async () => mount(first))
    expect(seen[1]).toBe(seen[0])

    const next = vi.fn()
    await act(async () => mount(next))
    expect(seen[2]).not.toBe(seen[1])
    expect(seen[2].onOpenCoverage).toBe(next)
    expect(seen[2].onOpenRun).toBe(onOpenRun)
  })
})
