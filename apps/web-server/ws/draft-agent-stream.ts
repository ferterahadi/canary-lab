import type { FastifyInstance } from 'fastify'
import type { PaneBroker, PaneSubscriber } from '../lib/pane-broker'
import { paneIdForDraft, type WizardAgentStage } from '../lib/wizard-agent-spawner'

// WebSocket route that streams a wizard draft's agent pty output. Mirrors
// `pane-stream.ts` (the runs broker) but keyed on draft id. The wizard
// spawner pushes pty chunks to the same broker via stage-specific pane ids
// (`draft:<draftId>:planning`, etc.), so multiple subscribers can attach and
// replay-on-connect works the same way as the run panes.
//
// Coverage is excluded for this module — the wire-up is too thin to test
// deterministically without a real WebSocket round-trip. The PaneBroker
// underneath is fully covered.

export interface DraftAgentStreamDeps {
  // Returns the broker that the wizard agent is pushing to for this draft,
  // or null if the draft is unknown / no agent has started yet.
  brokerForDraft(draftId: string): PaneBroker | null
}

export async function draftAgentStreamRoutes(
  app: FastifyInstance,
  deps: DraftAgentStreamDeps,
): Promise<void> {
  app.get<{ Params: { draftId: string }; Querystring: { stage?: string } }>(
    '/ws/draft/:draftId/agent',
    { websocket: true },
    (socket, req) => {
      const { draftId } = req.params
      const stage = parseStage(req.query.stage)
      if (!stage) {
        socket.send(JSON.stringify({ type: 'error', error: 'unknown draft stage' }))
        socket.close()
        return
      }
      const broker = deps.brokerForDraft(draftId)
      if (!broker) {
        socket.send(JSON.stringify({ type: 'error', error: 'unknown draft' }))
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
      const unsub = broker.subscribe(paneIdForDraft(draftId, stage), sub)
      socket.on('close', () => unsub())
    },
  )
}

function parseStage(value: string | undefined): WizardAgentStage | null {
  if (value === undefined) return 'planning'
  if (value === 'planning' || value === 'generating') return value
  return null
}
