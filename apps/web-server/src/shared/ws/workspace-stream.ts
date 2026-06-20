import type { FastifyInstance } from 'fastify'
import type { WorkspaceEvent, WorkspaceEventBus } from '../workspace-events'

export interface WorkspaceStreamDeps {
  events: WorkspaceEventBus
}

export type WorkspaceStreamFrame =
  | { type: 'connected' }
  | WorkspaceEvent

export async function workspaceStreamRoutes(
  app: FastifyInstance,
  deps: WorkspaceStreamDeps,
): Promise<void> {
  app.get('/ws/workspace', { websocket: true }, (socket) => {
    const send = (frame: WorkspaceStreamFrame): void => {
      try { socket.send(JSON.stringify(frame)) } catch { /* socket closed */ }
    }

    send({ type: 'connected' })
    const unsubscribe = deps.events.subscribe(send)
    socket.on('close', () => unsubscribe())
  })
}
