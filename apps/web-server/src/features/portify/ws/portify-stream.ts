import type { FastifyInstance } from 'fastify'
import type { PortifyStore, PortifyStoreEvent } from '../logic/runtime/store'
import { activeDetails, registerRecordStream } from '../../../shared/ws/record-stream'
import {
  isActionablePortifyStatus as isActivePortifyStatus,
  type PortifyStreamFrame,
} from '../../../../../../shared/portify-index'

// `/ws/portify` — push channel for the port-ification wizard + the
// GlobalStatusBar button, mirroring ws/benchmark-stream.ts. On connect, sends
// one `snapshot` frame (index + details for active workflows). Subsequent
// PortifyStore mutations are forwarded as `update` (full manifest) / `removed`.
// HTTP is reserved for one-shot mutations (start / commit / cancel).
//
// The socket lifecycle is `registerRecordStream`'s (shared/ws/record-stream.ts,
// tested there); this module only maps store events to frames.

export interface PortifyStreamDeps {
  store: PortifyStore
}

export async function portifyStreamRoutes(
  app: FastifyInstance,
  deps: PortifyStreamDeps,
): Promise<void> {
  registerRecordStream<PortifyStreamFrame, PortifyStoreEvent>(app, {
    path: '/ws/portify',
    store: deps.store,
    // Index, plus details only for active workflows (terminal ones load their
    // detail lazily via the first `update` / loadPortify).
    snapshot: () => {
      const workflows = deps.store.list()
      const details = activeDetails(workflows, (entry) => isActivePortifyStatus(entry.status), (entry) => entry.workflowId, (id) => deps.store.get(id))
      return { type: 'snapshot', workflows, details }
    },
    frameFor: (event) => {
      if (event.kind === 'removed' && event.workflowId) return { type: 'removed', workflowId: event.workflowId }
      if (!event.workflowId) return undefined
      const manifest = deps.store.get(event.workflowId)
      return manifest ? { type: 'update', workflowId: event.workflowId, manifest } : undefined
    },
  })
}
