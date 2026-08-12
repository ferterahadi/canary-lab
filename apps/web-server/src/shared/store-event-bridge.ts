import { publishWorkspaceEvent, type WorkspaceEvent, type WorkspaceEventPublisher } from './workspace-events'

// One rule for the whole server: **the state owner emits**. A feature store is
// the owner of its records, so a write to it — from a route, an MCP tool, a
// background stage, anywhere — is what broadcasts, not the caller.
//
// Before this, every caller published by hand right after saving:
//
//     store.save(manifest)
//     publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
//
// …repeated at 15 sites for flights alone. Every one of them was a place a new
// code path could forget, and forgetting is invisible: the state persists
// correctly and the UI is simply stale until the user reloads. Bridging the
// store's own event stream makes the emission structural — a write cannot
// happen without it.
//
// The precedents this generalizes are `dirtySpecStore.onEvent` (server.ts) and
// `runStore.onEvent` (run-scheduling.ts), which already did exactly this by
// hand for two stores.
//
// NOT every publisher belongs here: an event that reports something with no
// stored record (a registry version check, a file written straight to the
// feature directory) has no store to hang off and stays an explicit publish.

/** The shape every feature store's emitter satisfies. Each store names its id
 *  field differently (`flightId`, `workflowId`, `taskId`), so the bridge stays
 *  generic in the event type and lets the caller's mapper read it. */
export interface StoreEventSource<E> {
  onEvent(fn: (event: E) => void): void
}

export interface StoreBridgeOptions {
  /** Collapse a burst of writes into ONE publish per distinct event.
   *
   *  A driving flight saves its manifest on every stage transition, progress
   *  tick and checkpoint — bursts of writes seconds apart. Each one used to be
   *  a hand-placed publish at a coarse grain; bridging the store would
   *  otherwise multiply that into a fan-out per write, and every client
   *  refetches the whole list per event. Coalescing keeps the live behaviour
   *  (the client still learns within the window) at the old event volume.
   *
   *  Omit (or 0) to publish per event — right for a store whose writes are
   *  already user-paced. */
  coalesceMs?: number
  /** Timer seam. The default unrefs, so a pending flush can never hold the
   *  process open at shutdown; tests pass their own to run flushes eagerly. */
  setTimer?: (fn: () => void, ms: number) => void
}

function defaultSetTimer(fn: () => void, ms: number): void {
  // `unref` so a pending flush can never hold the process open at shutdown.
  // Server-only module, so the Node timer type is guaranteed — no `typeof`
  // guard, which would be an untestable branch rather than a real check.
  setTimeout(fn, ms).unref()
}

/**
 * Publish a `WorkspaceEvent` for every change a store records.
 *
 * `toEvent` maps one store event to the workspace event it should broadcast,
 * or `null` for a change the UI does not care about. Coalescing keys on the
 * mapped event's own contents, so two features' `coverage-changed` stay
 * distinct while a burst of identical `flights-changed` collapses to one.
 */
export function bridgeStoreEvents<E>(
  source: StoreEventSource<E>,
  events: WorkspaceEventPublisher | undefined,
  toEvent: (event: E) => WorkspaceEvent | null,
  opts: StoreBridgeOptions = {},
): void {
  // No publisher (a store built in a test, or a server wired without a bus):
  // stay out of the store's listener set entirely rather than subscribe and
  // drop every event.
  if (!events) return
  const coalesceMs = opts.coalesceMs ?? 0
  const setTimer = opts.setTimer ?? defaultSetTimer
  const pending = new Map<string, WorkspaceEvent>()
  let flushScheduled = false

  const flush = (): void => {
    flushScheduled = false
    const batch = [...pending.values()]
    pending.clear()
    for (const event of batch) publishWorkspaceEvent(events, event)
  }

  source.onEvent((storeEvent) => {
    const event = toEvent(storeEvent)
    if (!event) return
    if (coalesceMs <= 0) {
      publishWorkspaceEvent(events, event)
      return
    }
    pending.set(JSON.stringify(event), event)
    if (flushScheduled) return
    flushScheduled = true
    setTimer(flush, coalesceMs)
  })
}

/**
 * The same rule for a store whose events CARRY the record — drafts and
 * evaluation exports both push the full task so an open dialog can render it
 * without a refetch.
 *
 * Two things the plain bridge can't do for them: it must load the record the
 * change refers to, and it must tell a create from an update. A store event
 * says only `changed`, so first-write-wins is tracked here — seeded from what
 * is already on disk at boot, so a restart doesn't re-announce every existing
 * record as newly created.
 */
export function bridgeRecordEvents<R>(opts: {
  source: StoreEventSource<{ kind: 'changed' | 'removed'; id?: string }>
  events: WorkspaceEventPublisher | undefined
  /** Ids already persisted, read once when the bridge is attached. */
  knownIds: () => string[]
  load: (id: string) => R | null
  created: (record: R) => WorkspaceEvent
  updated: (record: R) => WorkspaceEvent
  removed: (id: string) => WorkspaceEvent
}): void {
  const { events } = opts
  if (!events) return
  const seen = new Set<string>(opts.knownIds())
  opts.source.onEvent((event) => {
    const id = event.id
    if (!id) return
    if (event.kind === 'removed') {
      seen.delete(id)
      publishWorkspaceEvent(events, opts.removed(id))
      return
    }
    const record = opts.load(id)
    // Written and already gone (a delete racing us), or unreadable: the
    // `removed` event for it is the one worth sending, and that is its own
    // branch above.
    if (!record) return
    const isNew = !seen.has(id)
    seen.add(id)
    publishWorkspaceEvent(events, isNew ? opts.created(record) : opts.updated(record))
  })
}
