import { describe, expect, it } from 'vitest'
import { bridgeRecordEvents, bridgeStoreEvents, type StoreEventSource } from './store-event-bridge'
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

describe('bridgeRecordEvents', () => {
  interface Draft { draftId: string; status: string }

  function setup(known: string[] = []) {
    const store = fakeStore<Change>()
    const records = new Map<string, Draft>()
    const { bus, seen } = capture()
    bridgeRecordEvents<Draft>({
      source: store,
      events: bus,
      knownIds: () => known,
      load: (id) => records.get(id) ?? null,
      created: (draft) => ({ type: 'draft-created', draft: draft as never }),
      updated: (draft) => ({ type: 'draft-updated', draft: draft as never }),
      removed: (draftId) => ({ type: 'draft-deleted', draftId }),
    })
    return { store, records, seen }
  }

  it('calls the first write to an unknown id a creation, and the rest updates', () => {
    const { store, records, seen } = setup()
    records.set('d-1', { draftId: 'd-1', status: 'planning' })

    store.emit({ kind: 'changed', id: 'd-1' })
    records.set('d-1', { draftId: 'd-1', status: 'ready' })
    store.emit({ kind: 'changed', id: 'd-1' })

    expect(seen.map((e) => e.type)).toEqual(['draft-created', 'draft-updated'])
    // The record rides the event — the dialog renders it without a refetch.
    expect((seen[1] as { draft: Draft }).draft.status).toBe('ready')
  })

  it('treats a record that already existed at boot as an update, not a creation', () => {
    // Seeded from disk: a restart must not re-announce every existing draft as
    // newly created, which would reopen dialogs and re-fire creation toasts.
    const { store, records, seen } = setup(['d-1'])
    records.set('d-1', { draftId: 'd-1', status: 'ready' })
    store.emit({ kind: 'changed', id: 'd-1' })
    expect(seen.map((e) => e.type)).toEqual(['draft-updated'])
  })

  it('announces a removal and forgets the id', () => {
    const { store, records, seen } = setup()
    records.set('d-1', { draftId: 'd-1', status: 'ready' })
    store.emit({ kind: 'changed', id: 'd-1' })
    store.emit({ kind: 'removed', id: 'd-1' })
    // Re-created under the same id later: a creation again, not an update.
    records.set('d-1', { draftId: 'd-1', status: 'planning' })
    store.emit({ kind: 'changed', id: 'd-1' })
    expect(seen.map((e) => e.type)).toEqual(['draft-created', 'draft-deleted', 'draft-created'])
  })

  it('stays quiet when the record cannot be read', () => {
    // Written and already gone (a delete racing the write): the `removed` event
    // is the one worth sending, and that is its own branch.
    const { store, seen } = setup()
    store.emit({ kind: 'changed', id: 'gone' })
    expect(seen).toEqual([])
  })

  it('ignores an event with no id', () => {
    const { store, seen } = setup()
    store.emit({ kind: 'changed' })
    expect(seen).toEqual([])
  })

  it('does not subscribe without a publisher', () => {
    const listeners: unknown[] = []
    bridgeRecordEvents<Draft>({
      source: { onEvent: (fn) => { listeners.push(fn) } },
      events: undefined,
      knownIds: () => [],
      load: () => null,
      created: () => ({ type: 'draft-created', draft: {} as never }),
      updated: () => ({ type: 'draft-updated', draft: {} as never }),
      removed: (draftId) => ({ type: 'draft-deleted', draftId }),
    })
    expect(listeners).toHaveLength(0)
  })
})
