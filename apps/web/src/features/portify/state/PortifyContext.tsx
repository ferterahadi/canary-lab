import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import * as portifyApi from '@/shared/api/portify'
import { defaultWsBase } from '@/shared/api/reconnecting-socket'
import { useRecordDetail, useRecordIndexStore } from '@/shared/state/record-index-store'
import type { PortifyManifest, PortifyIndexEntry } from '@shared/portify-index'
import { portifyIndex } from './portify-state'
import { isActionablePortifyStatus as isActivePortify } from '@shared/portify-index'

// Port-ification store, mirroring BenchmarkContext: a `/ws/portify`-fed reducer
// for the index + per-workflow manifests, plus one-shot start/save/cancel
// actions. The GlobalStatusBar button reads the active workflow from here; the
// detail consumers share hydration through usePortifyDetail.

type PortifyStore = ReturnType<typeof useRecordIndexStore<PortifyIndexEntry, PortifyManifest, 'workflows', 'workflowId'>>

interface PortifyContextValue extends PortifyStore {
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
  const { state, hydration } = useRecordIndexStore({
    index: portifyIndex,
    url: wsUrl ?? defaultWsUrl(),
    WebSocketImpl,
    read: portifyApi.getPortify,
    errorMessage: 'Could not load port work',
  })

  const startPortify = useCallback(
    async (input: { feature: string; agent?: 'claude' | 'codex'; maxAttempts?: number }) => {
      const { workflowId } = await portifyApi.startPortify(input)
      return workflowId
    },
    [],
  )

  const savePortify = useCallback(async (id: string) => {
    await portifyApi.savePortify(id)
  }, [])

  const cancelPortify = useCallback(async (id: string) => {
    await portifyApi.cancelPortify(id)
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
  return useRecordDetail(state.details, hydration, id)
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
