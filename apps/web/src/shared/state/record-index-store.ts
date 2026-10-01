import { useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react'
import { createDetailHydration } from './detail-hydration'
import { createObservedReads } from './observed-reads'
import { connectRecordStream, type ConnectionState } from './record-stream'

// The browser half of a record store whose server pushes the whole manifest on
// every change: an index list (newest first) plus the manifests it has, fed by a
// `snapshot` frame and then `update`/`removed` deltas. Portify and benchmark are
// both this shape. Their list and id keys stay their own (`workflows` +
// `workflowId`, `benchmarks` + `benchmarkId`) because the frames carry them on
// the wire and the views read them, so the keys are parameters here, not a
// rename to something neutral.

export interface RecordIndexKeys<List extends string, Id extends string> {
  list: List
  id: Id
}

export type RecordIndexState<Entry, Detail, List extends string> = Record<List, Entry[]> & {
  details: Record<string, Detail>
  connection: ConnectionState
}

/** The server's frames. `detail-missing` is in the union only because the wire
 *  type lists it; the stream never sends it, and it is ignored if it arrives. */
export type RecordIndexFrame<Entry, Detail, List extends string, Id extends string> =
  | ({ type: 'snapshot'; details: Record<string, Detail> } & Record<List, Entry[]>)
  | ({ type: 'update'; manifest: Detail } & Record<Id, string>)
  | ({ type: 'removed' } & Record<Id, string>)
  | ({ type: 'detail-missing' } & Record<Id, string>)

export type RecordIndexAction<Entry, Detail, List extends string, Id extends string> =
  | RecordIndexFrame<Entry, Detail, List, Id>
  | { type: 'connection'; status: ConnectionState }

type Indexed<Id extends string> = Record<Id, string> & { startedAt: string }

export interface RecordIndex<Entry, Detail, List extends string, Id extends string> {
  keys: RecordIndexKeys<List, Id>
  initialState: RecordIndexState<Entry, Detail, List>
  reducer(
    state: RecordIndexState<Entry, Detail, List>,
    action: RecordIndexAction<Entry, Detail, List, Id>,
  ): RecordIndexState<Entry, Detail, List>
  /** A WS frame as a reducer action; an unknown frame type → null. */
  frameToAction(frame: RecordIndexFrame<Entry, Detail, List, Id>): RecordIndexAction<Entry, Detail, List, Id> | null
}

/** The reducer and frame decoder for one record store. `entryOf` derives the
 *  index row from a manifest, so an `update` keeps both in step. */
export function createRecordIndex<
  Entry extends Indexed<Id>,
  Detail,
  List extends string,
  Id extends string,
>({ keys, entryOf }: {
  keys: RecordIndexKeys<List, Id>
  entryOf: (detail: Detail) => Entry
}): RecordIndex<Entry, Detail, List, Id> {
  type State = RecordIndexState<Entry, Detail, List>
  type Action = RecordIndexAction<Entry, Detail, List, Id>
  type Frame = RecordIndexFrame<Entry, Detail, List, Id>

  // A computed key widens to an index signature, so this is the one place the
  // keyed list is written back under the store's own name.
  const withList = (state: State, entries: Entry[], details: Record<string, Detail>): State =>
    ({ ...state, [keys.list]: entries, details }) as State
  const without = (state: State, id: string) =>
    state[keys.list].filter((entry) => entry[keys.id] !== id)
  const omitDetail = (details: Record<string, Detail>, id: string) => {
    const { [id]: _omitted, ...rest } = details
    return rest
  }

  const initialState = withList(
    { details: {}, connection: 'connecting' } as unknown as State, [], {},
  )

  function reducer(state: State, action: Action): State {
    switch (action.type) {
      case 'snapshot':
        return withList(state, action[keys.list], action.details)
      case 'update': {
        const id = action[keys.id]
        return withList(
          state,
          [entryOf(action.manifest), ...without(state, id)].sort(byStartedDesc),
          { ...state.details, [id]: action.manifest },
        )
      }
      case 'detail-missing':
        return { ...state, details: omitDetail(state.details, action[keys.id]) }
      case 'removed': {
        const id = action[keys.id]
        return withList(state, without(state, id), omitDetail(state.details, id))
      }
      case 'connection':
        return { ...state, connection: action.status }
    }
  }

  function frameToAction(frame: Frame): Action | null {
    switch (frame.type) {
      case 'snapshot':
      case 'update':
      case 'removed':
        return frame
      default:
        return null
    }
  }

  return { keys, initialState, reducer, frameToAction }
}

/** Newest first, the order every index list is kept in. */
export function byStartedDesc(a: { startedAt: string }, b: { startedAt: string }): number {
  return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
}

/** Detail recovery for one record store: the store supplies its actions, the
 *  provider owns the manifests and the read tokens. */
export function createRecordIndexHydration<
  Entry extends Indexed<Id>,
  Detail,
  List extends string,
  Id extends string,
>({ index: { keys }, reads, read, apply, hasDetail, errorMessage }: {
  index: RecordIndex<Entry, Detail, List, Id>
  reads: ReturnType<typeof createObservedReads>
  read: (id: string) => Promise<Detail>
  apply: (action: RecordIndexAction<Entry, Detail, List, Id>) => void
  hasDetail: (id: string) => boolean
  errorMessage: string
}) {
  type Action = RecordIndexAction<Entry, Detail, List, Id>
  const hydration = createDetailHydration({
    reads, read, hasDetail, errorMessage,
    apply: (id, manifest) => apply({ type: 'update', [keys.id]: id, manifest } as Action),
    missing: (id) => apply({ type: 'detail-missing', [keys.id]: id } as Action),
  })
  return { ...hydration, observe: (action: Action) => {
    if (action.type === 'update' || action.type === 'removed') hydration.observe({ type: action.type, id: action[keys.id] })
    if (action.type === 'snapshot') hydration.observe({ type: 'snapshot', ids: action[keys.list].map((row) => row[keys.id]), details: action.details })
  } }
}

export type RecordIndexHydration = ReturnType<typeof createRecordIndexHydration>

/** The provider core: the reducer, its `/ws` stream, and the shared detail
 *  hydration, wired so a pushed frame supersedes an older HTTP read. */
export function useRecordIndexStore<
  Entry extends Indexed<Id>,
  Detail,
  List extends string,
  Id extends string,
>({ index, url, WebSocketImpl, read, errorMessage }: {
  index: RecordIndex<Entry, Detail, List, Id>
  url: string
  WebSocketImpl?: typeof WebSocket
  read: (id: string) => Promise<Detail>
  errorMessage: string
}) {
  const [state, dispatch] = useReducer(index.reducer, index.initialState)
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch
  const readsRef = useRef(createObservedReads())
  const stateRef = useRef(state)
  stateRef.current = state
  // `index` and `read` must be stable (module constants at every call site): a
  // new one rebuilds the hydration and so reconnects the stream.
  const hydration = useMemo(() => createRecordIndexHydration({
    index, reads: readsRef.current, read, errorMessage,
    apply: (action) => dispatchRef.current(action),
    hasDetail: (id) => Boolean(stateRef.current.details[id]),
  }), [index, read, errorMessage])
  useEffect(() => {
    hydration.start()
    const connection = connectRecordStream({
      url,
      WebSocketImpl,
      reads: readsRef.current,
      decode: (frame) => index.frameToAction(frame as RecordIndexFrame<Entry, Detail, List, Id>),
      recordId: (action) => action.type === 'update' || action.type === 'removed' ? action[index.keys.id] : null,
      dispatch: (action) => { dispatchRef.current(action); hydration.observe(action) },
      onConnection: (status) => dispatchRef.current({ type: 'connection', status }),
    })
    return () => { connection.close(); hydration.stop() }
  }, [url, WebSocketImpl, hydration, index])
  return { state, hydration }
}

/** A canonical manifest with mounted recovery demand, never a private copy. */
export function useRecordDetail<Detail>(
  details: Record<string, Detail>,
  hydration: Pick<RecordIndexHydration, 'subscribe' | 'snapshot' | 'watch' | 'retry'>,
  id: string | null | undefined,
) {
  const status = useSyncExternalStore(hydration.subscribe, () => hydration.snapshot(id))
  useEffect(() => id ? hydration.watch(id) : undefined, [id, hydration])
  const manifest = id ? details[id] : undefined
  return {
    manifest,
    loading: Boolean(id && !manifest && (status.status === 'idle' || status.status === 'loading')),
    error: status.error,
    missing: status.status === 'missing',
    retry: () => { if (id) hydration.retry(id) },
  }
}
