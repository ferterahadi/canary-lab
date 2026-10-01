import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { createPortifyHydration } from './portify-hydration'
import * as api from '@/shared/api/client'
import { createObservedReads } from '@/shared/state/observed-reads'
import { defaultWsBase } from '@/shared/api/reconnecting-socket'
import { connectRecordStream } from '@/shared/state/record-stream'
import type { PortifyManifest, PortifyIndexEntry } from '@/shared/api/client'
import {
  portifyReducer,
  initialPortifyState,
  frameToAction,
  isActivePortify,
  type PortifyState,
  type PortifyStreamFrame,
} from './portify-state'

// Port-ification store, mirroring BenchmarkContext: a `/ws/portify`-fed reducer
// for the index + per-workflow manifests, plus one-shot start/save/cancel
// actions. The GlobalStatusBar button reads the active workflow from here; the
// detail consumers share hydration through usePortifyDetail.

interface PortifyContextValue {
  state: PortifyState
  hydration: ReturnType<typeof createPortifyHydration>
  startPortify: (input: { feature: string; agent?: 'claude' | 'codex'; maxAttempts?: number }) => Promise<string>
  savePortify: (id: string) => Promise<void>
  cancelPortify: (id: string) => Promise<void>
  /** Hydrate a terminal workflow's manifest (the WS snapshot omits details for
   *  terminal ones); WS `update`s keep active workflows fresh. */
  loadPortify: (id: string) => Promise<void>
}

const PortifyContext = createContext<PortifyContextValue | null>(null)

export function PortifyProvider({
  children,
  wsUrl,
  WebSocketImpl,
}: {
  children: ReactNode
  wsUrl?: string
  WebSocketImpl?: typeof WebSocket
}) {
  const [state, dispatch] = useReducer(portifyReducer, initialPortifyState)
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch
  const readsRef = useRef(createObservedReads())

  const stateRef = useRef(state)
  stateRef.current = state
  const hydration = useMemo(() => createPortifyHydration({
    reads: readsRef.current, read: api.getPortify,
    apply: (action) => dispatchRef.current(action),
    hasDetail: (id) => Boolean(stateRef.current.details[id]),
  }), [])
  useEffect(() => {
    hydration.start()
    const connection = connectRecordStream({
      url: wsUrl ?? defaultWsUrl(),
      WebSocketImpl,
      reads: readsRef.current,
      decode: (frame) => frameToAction(frame as PortifyStreamFrame),
      recordId: (action) => action.type === 'update' || action.type === 'removed' ? action.workflowId : null,
      dispatch: (action) => { dispatchRef.current(action); hydration.observe(action) },
      onConnection: (status) => dispatchRef.current({ type: 'connection', status }),
    })
    return () => { connection.close(); hydration.stop() }
  }, [wsUrl, WebSocketImpl, hydration])

  const startPortify = useCallback(
    async (input: { feature: string; agent?: 'claude' | 'codex'; maxAttempts?: number }) => {
      const { workflowId } = await api.startPortify(input)
      return workflowId
    },
    [],
  )

  const savePortify = useCallback(async (id: string) => {
    await api.savePortify(id)
  }, [])

  const cancelPortify = useCallback(async (id: string) => {
    await api.cancelPortify(id)
  }, [])

  const loadPortify = hydration.load

  const value = useMemo<PortifyContextValue>(
    () => ({ state, hydration, startPortify, savePortify, cancelPortify, loadPortify }),
    [state, hydration, startPortify, savePortify, cancelPortify, loadPortify],
  )
  return <PortifyContext.Provider value={value}>{children}</PortifyContext.Provider>
}

function usePortifyContext(): PortifyContextValue {
  const ctx = useContext(PortifyContext)
  if (!ctx) throw new Error('usePortify must be used inside <PortifyProvider>')
  return ctx
}

export function usePortify() {
  const ctx = usePortifyContext()
  return {
    workflows: ctx.state.workflows,
    details: ctx.state.details,
    connection: ctx.state.connection,
    startPortify: ctx.startPortify,
    savePortify: ctx.savePortify,
    cancelPortify: ctx.cancelPortify,
    loadPortify: ctx.loadPortify,
  }
}

export function usePortifyWorkflow(id: string | null | undefined): PortifyManifest | undefined {
  const ctx = usePortifyContext()
  return id ? ctx.state.details[id] : undefined
}

/** A canonical manifest with mounted recovery demand, never a private copy. */
export function usePortifyDetail(id: string | null | undefined) {
  const { state, hydration } = usePortifyContext()
  const status = useSyncExternalStore(hydration.subscribe, () => hydration.snapshot(id))
  useEffect(() => id ? hydration.watch(id) : undefined, [id, hydration])
  const manifest = id ? state.details[id] : undefined
  return {
    manifest,
    loading: Boolean(id && !manifest && (status.status === 'idle' || status.status === 'loading')),
    error: status.error,
    missing: status.status === 'missing',
    retry: () => { if (id) hydration.retry(id) },
  }
}

/** The single active workflow, if any (portify is one-at-a-time). */
export function useActivePortify(): PortifyIndexEntry | undefined {
  const ctx = usePortifyContext()
  return ctx.state.workflows.find((w) => isActivePortify(w.status))
}

function defaultWsUrl(): string {
  // The app's one origin→ws-base helper, rather than a third copy of the same
  // protocol/host derivation.
  return `${defaultWsBase()}/ws/portify`
}
