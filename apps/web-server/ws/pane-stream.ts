import type { FastifyInstance } from 'fastify'
import type { PaneBroker, PaneId, PaneSubscriber } from '../lib/pane-broker'
import type { OrchestratorRegistry } from '../lib/run-store'

// Wires Fastify's WebSocket plugin to the per-run PaneBroker. Coverage is
// excluded for this module — the wire-up is too thin to test deterministically
// without a real WebSocket round-trip. The buffer + broker logic underneath
// is fully covered.

export interface PaneStreamDeps {
  registry: OrchestratorRegistry
  // Per-run broker lookup. Production builds this when a run starts; tests
  // bypass this module entirely.
  brokerFor(runId: string): PaneBroker | null
}

export async function paneStreamRoutes(
  app: FastifyInstance,
  deps: PaneStreamDeps,
): Promise<void> {
  app.get<{ Params: { runId: string; paneId: string } }>(
    '/ws/run/:runId/pane/:paneId',
    { websocket: true },
    (socket, req) => {
      const { runId, paneId } = req.params
      const broker = deps.brokerFor(runId)
      if (!broker) {
        socket.send(JSON.stringify({ type: 'error', error: 'unknown run' }))
        socket.close()
        return
      }
      const sub: PaneSubscriber = {
        send: (msg) => {
          try { socket.send(JSON.stringify(msg)) } catch { /* socket closed */ }
        },
        close: () => {
          try { socket.close() } catch { /* already closed */ }
        },
      }
      const unsub = broker.subscribe(paneId as PaneId, sub)
      socket.on('close', () => unsub())
    },
  )
}
