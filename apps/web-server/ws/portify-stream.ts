import type { FastifyInstance } from 'fastify'
import type { PortifyStore, PortifyStoreEvent } from '../lib/runtime/portify/store'
import type { PortifyIndexEntry, PortifyManifest, PortifyStatus } from '../lib/runtime/portify/types'

// `/ws/portify` — push channel for the port-ification wizard + the
// GlobalStatusBar button, mirroring ws/benchmark-stream.ts. On connect, sends
// one `snapshot` frame (index + details for active workflows). Subsequent
// PortifyStore mutations are forwarded as `update` (full manifest) / `removed`.
// HTTP is reserved for one-shot mutations (start / commit / cancel).
//
// Coverage is excluded for this module (like the other ws/** wire-ups) — too
// thin to test deterministically without a real WebSocket round-trip. The
// store + reducer underneath are fully covered (store.test.ts, portify-state).

export interface PortifyStreamDeps {
  store: PortifyStore
}

export type PortifyStreamFrame =
  | {
      type: 'snapshot'
      workflows: PortifyIndexEntry[]
      details: Record<string, PortifyManifest>
    }
  | { type: 'update'; workflowId: string; manifest: PortifyManifest }
  | { type: 'removed'; workflowId: string }

function isActivePortifyStatus(status: PortifyStatus): boolean {
  return status === 'planning' || status === 'editing' || status === 'verifying' || status === 'ready-to-commit'
}

export async function portifyStreamRoutes(
  app: FastifyInstance,
  deps: PortifyStreamDeps,
): Promise<void> {
  app.get('/ws/portify', { websocket: true }, (socket) => {
    const send = (frame: PortifyStreamFrame): void => {
      try {
        socket.send(JSON.stringify(frame))
      } catch {
        /* socket closed */
      }
    }

    // Index, plus details only for active workflows (terminal ones load their
    // detail lazily via the first `update` / loadPortify).
    const snapshot = (): PortifyStreamFrame => {
      const workflows = deps.store.list()
      const details: Record<string, PortifyManifest> = {}
      for (const entry of workflows) {
        if (isActivePortifyStatus(entry.status)) {
          const manifest = deps.store.get(entry.workflowId)
          if (manifest) details[entry.workflowId] = manifest
        }
      }
      return { type: 'snapshot', workflows, details }
    }

    send(snapshot())

    const onEvent = (event: PortifyStoreEvent): void => {
      if (event.kind === 'removed' && event.workflowId) {
        send({ type: 'removed', workflowId: event.workflowId })
        return
      }
      if (!event.workflowId) return
      const manifest = deps.store.get(event.workflowId)
      if (!manifest) return
      send({ type: 'update', workflowId: event.workflowId, manifest })
    }

    deps.store.onEvent(onEvent)
    socket.on('close', () => {
      deps.store.offEvent(onEvent)
    })
  })
}
