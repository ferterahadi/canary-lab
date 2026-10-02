import type { WorkspaceStreamFrame } from '../../../../../shared/workspace-events'
import type { FastifyInstance } from 'fastify'
import type { WorkspaceEventBus } from '../workspace-events'
import { sendFrame } from './record-stream'

export interface WorkspaceStreamDeps {
  events: WorkspaceEventBus
}

export async function workspaceStreamRoutes(
  app: FastifyInstance,
  deps: WorkspaceStreamDeps,
): Promise<void> {
  app.get('/ws/workspace', { websocket: true }, (socket) => {
    const send = (frame: WorkspaceStreamFrame): void => sendFrame(socket, frame)

    send({ type: 'connected' })
    const unsubscribe = deps.events.subscribe(send)
    socket.on('close', () => unsubscribe())
  })
}
