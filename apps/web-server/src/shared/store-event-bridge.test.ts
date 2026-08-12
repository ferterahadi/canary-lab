import { describe, expect, it } from 'vitest'
import { bridgeStoreEvents, type StoreEventSource } from './store-event-bridge'
import { WorkspaceEventBus, type WorkspaceEvent } from './workspace-events'

// A store stand-in: `emit` plays the part of a record being written.
function fakeStore<E>(): StoreEventSource<E> & { emit(event: E): void } {
  const listeners: ((event: E) => void)[] = []
  return {
    onEvent: (fn) => { listeners.push(fn) },
    emit: (event) => { for (const fn of listeners) fn(event) },
  }
}

function capture(): { bus: WorkspaceEventBus; seen: WorkspaceEvent[] } {
  const bus = new WorkspaceEventBus()
  const seen: WorkspaceEvent[] = []
  bus.subscribe((event) => seen.push(event))
  return { bus, seen }
}

interface Change { kind: 'changed' | 'removed'; id?: string }

describe('bridgeStoreEvents', () => {
  it('publishes the mapped event for every store write', () => {
    const store = fakeStore<Change>()
    const { bus, seen } = capture()
    bridgeStoreEvents(store, bus, () => ({ type: 'flights-changed' }))

    store.emit({ kind: 'changed', id: 'fl_1' })
    store.emit({ kind: 'removed', id: 'fl_1' })

    expect(seen).toEqual([{ type: 'flights-changed' }, { type: 'flights-changed' }])
  })

  it('carries the record identity a scoped event needs', () => {
    const store = fakeStore<{ kind: string; feature?: string }>()
    const { bus, seen } = capture()
    bridgeStoreEvents(store, bus, (e) =>
      e.feature ? { type: 'coverage-changed', feature: e.feature } : null)

    store.emit({ kind: 'changed', feature: 'checkout' })
    // Unmapped (`null`) changes are the store's own bookkeeping — a record the
    // UI has no surface for. Publishing them would wake every client for
    // nothing.
    store.emit({ kind: 'changed' })

    expect(seen).toEqual([{ type: 'coverage-changed', feature: 'checkout' }])
  })

  it('collapses a burst of identical events into one publish', () => {
    const store = fakeStore<Change>()
    const { bus, seen } = capture()
    const flushes: (() => void)[] = []
    bridgeStoreEvents(store, bus, () => ({ type: 'flights-changed' }), {
      coalesceMs: 100,
      setTimer: (fn) => { flushes.push(fn) },
    })

    // A driving flight saving its manifest three times in a row.
    store.emit({ kind: 'changed', id: 'fl_1' })
    store.emit({ kind: 'changed', id: 'fl_1' })
    store.emit({ kind: 'changed', id: 'fl_1' })
    expect(seen).toEqual([])
    // ONE timer for the whole burst, not one per write.
    expect(flushes).toHaveLength(1)

    flushes[0]!()
    expect(seen).toEqual([{ type: 'flights-changed' }])
  })

  it('keeps distinct events distinct inside one window', () => {
    const store = fakeStore<{ feature: string }>()
    const { bus, seen } = capture()
    const flushes: (() => void)[] = []
    bridgeStoreEvents(store, bus, (e) => ({ type: 'coverage-changed', feature: e.feature }), {
      coalesceMs: 100,
      setTimer: (fn) => { flushes.push(fn) },
    })

    store.emit({ feature: 'checkout' })
    store.emit({ feature: 'search' })
    store.emit({ feature: 'checkout' })
    flushes[0]!()

    // Two features changed; collapsing them to one would leave a client
    // refetching the wrong suite.
    expect(seen).toEqual([
      { type: 'coverage-changed', feature: 'checkout' },
      { type: 'coverage-changed', feature: 'search' },
    ])
  })

  it('re-arms after a flush so a later write still publishes', () => {
    const store = fakeStore<Change>()
    const { bus, seen } = capture()
    const flushes: (() => void)[] = []
    bridgeStoreEvents(store, bus, () => ({ type: 'flights-changed' }), {
      coalesceMs: 100,
      setTimer: (fn) => { flushes.push(fn) },
    })

    store.emit({ kind: 'changed' })
    flushes[0]!()
    store.emit({ kind: 'changed' })
    expect(flushes).toHaveLength(2)
    flushes[1]!()

    expect(seen).toHaveLength(2)
  })

  it('does not subscribe at all without a publisher', () => {
    const listeners: unknown[] = []
    const store = {
      onEvent: (fn: (e: Change) => void) => { listeners.push(fn) },
    }
    bridgeStoreEvents(store, undefined, () => ({ type: 'flights-changed' }))
    expect(listeners).toHaveLength(0)
  })

  it('drives the real bus end to end, including the unref-ing default timer', async () => {
    const store = fakeStore<Change>()
    const { bus, seen } = capture()
    bridgeStoreEvents(store, bus, () => ({ type: 'pre-flight-changed' }), { coalesceMs: 1 })

    store.emit({ kind: 'changed' })
    expect(seen).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen).toEqual([{ type: 'pre-flight-changed' }])
  })
})
