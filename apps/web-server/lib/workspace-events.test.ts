import { describe, expect, it, vi } from 'vitest'
import { publishWorkspaceEvent, WorkspaceEventBus } from './workspace-events'

describe('workspace-events', () => {
  it('publishes events to subscribers until they unsubscribe', () => {
    const bus = new WorkspaceEventBus()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe(listener)

    bus.publish({ type: 'features-changed' })
    unsubscribe()
    bus.publish({ type: 'tests-changed', feature: 'checkout' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ type: 'features-changed' })
  })

  it('publishes through optional publishers when present', () => {
    const publisher = { publish: vi.fn() }

    publishWorkspaceEvent(undefined, { type: 'features-changed' })
    publishWorkspaceEvent(publisher, { type: 'envsets-changed', feature: 'checkout' })

    expect(publisher.publish).toHaveBeenCalledWith({ type: 'envsets-changed', feature: 'checkout' })
  })
})
