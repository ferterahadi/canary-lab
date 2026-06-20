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
import * as api from '../../../api/client'
import type { PortifyManifest, PortifyIndexEntry } from '../../../api/client'
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

  useEffect(() => {
    const url = wsUrl ?? defaultWsUrl()
    const Ctor = WebSocketImpl ?? WebSocket
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoff = RECONNECT_INITIAL_MS
    let cancelled = false

    const connect = (): void => {
      if (cancelled) return
      try {
        socket = new Ctor(url)
      } catch {
        scheduleReconnect()
        return
      }
      socket.onopen = () => {
        backoff = RECONNECT_INITIAL_MS
        dispatchRef.current({ type: 'connection', status: 'live' })
      }
      socket.onmessage = (e) => {
        let frame: PortifyStreamFrame
        try {
          frame = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
        } catch {
          return
        }
        const action = frameToAction(frame)
        if (action) dispatchRef.current(action)
      }
      socket.onclose = () => {
        if (cancelled) return
        dispatchRef.current({ type: 'connection', status: 'reconnecting' })
        scheduleReconnect()
      }
    }

    const scheduleReconnect = (): void => {
      if (cancelled) return
      reconnectTimer = setTimeout(() => {
        if (backoff >= RECONNECT_MAX_MS) {
          dispatchRef.current({ type: 'connection', status: 'disconnected' })
        }
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
        connect()
      }, backoff)
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try {
        socket?.close()
      } catch {
        /* already closed */
      }
    }
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
    try {
      const manifest = await api.getPortify(id)
      if (manifest) dispatchRef.current({ type: 'update', workflowId: id, manifest })
    } catch {
      /* leave it unhydrated — the caller shows a loading/empty state */
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
  if (typeof window === 'undefined') return 'ws://localhost/ws/portify'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws/portify`
}
