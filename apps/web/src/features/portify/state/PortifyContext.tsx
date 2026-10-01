import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import * as api from '@/shared/api/client'
import { createObservedReads } from '@/shared/state/observed-reads'
import { connectReconnectingSocket, defaultWsBase } from '@/shared/api/reconnecting-socket'
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
// wizard reads a single manifest via usePortifyWorkflow.

interface PortifyContextValue {
  state: PortifyState
  startPortify: (input: { feature: string; agent?: 'claude' | 'codex'; maxAttempts?: number }) => Promise<string>
  savePortify: (id: string) => Promise<void>
  cancelPortify: (id: string) => Promise<void>
  /** Hydrate a terminal workflow's manifest (the WS snapshot omits details for
   *  terminal ones); WS `update`s keep active workflows fresh. */
  loadPortify: (id: string) => Promise<void>
}

const PortifyContext = createContext<PortifyContextValue | null>(null)

const RECONNECT_INITIAL_MS = 500
const RECONNECT_MAX_MS = 10_000

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

  useEffect(() => {
    const reads = readsRef.current
    const url = wsUrl ?? defaultWsUrl()
    const connection = connectReconnectingSocket({
      url,
      WebSocketImpl,
      maxReconnects: Infinity,
      reconnectDelayMs: (attempt) => Math.min(RECONNECT_INITIAL_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS),
      coerceMessageData: true,
      onOpen: () => {
        dispatchRef.current({ type: 'connection', status: 'live' })
      },
      onReconnect: (_attempt, reason) => {
        if (reason === 'close') dispatchRef.current({ type: 'connection', status: 'reconnecting' })
      },
      onReconnectAttempt: (_attempt, delayMs) => {
        // Keep the existing label timing: the capped wait must elapse first.
        if (delayMs >= RECONNECT_MAX_MS) dispatchRef.current({ type: 'connection', status: 'disconnected' })
      },
      onMessage: (data) => {
        let frame: PortifyStreamFrame
        try {
          frame = JSON.parse(data)
        } catch {
          return
        }
        const action = frameToAction(frame)
        if (action) {
          if (action.type === 'update' || action.type === 'removed') reads.invalidate(action.workflowId)
          else reads.clear()
          dispatchRef.current(action)
        }
      },
    })
    return () => { reads.clear(); connection.close() }
  }, [wsUrl, WebSocketImpl])

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

  const loadPortify = useCallback(async (id: string) => {
    const reads = readsRef.current
    const token = reads.begin(id)
    if (!token) return
    try {
      const manifest = await api.getPortify(id)
      if (manifest && reads.current(id, token)) dispatchRef.current({ type: 'update', workflowId: id, manifest })
    } catch {
      /* leave it unhydrated — the caller shows a loading/empty state */
    } finally {
      reads.finish(id, token)
    }
  }, [])

  const value = useMemo<PortifyContextValue>(
    () => ({ state, startPortify, savePortify, cancelPortify, loadPortify }),
    [state, startPortify, savePortify, cancelPortify, loadPortify],
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
