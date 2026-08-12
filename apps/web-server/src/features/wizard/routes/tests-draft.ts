import fs from 'fs'
import type { FastifyInstance } from 'fastify'
import { deleteDraft, listDrafts, paths as draftPaths, readDraft } from '../logic/draft-store'
import {
  buildAgentSessionResponse,
} from '../../agent-sessions/logic/agent-session-log'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { isTransientGenerationStatus, transitionDraft } from './tests-draft-support'

// Draft records are read/tracked here; they are AUTHORED entirely by external
// MCP clients (start_external_draft / update_external_draft_stage /
// apply_external_draft in mcp/tool-groups/authoring-drafts.ts). Canary spawns no
// local authoring agent: the internal two-stage wizard (plan agent → spec agent)
// was retired once the flight pipeline took over the same ground — scout +
// scaffold plan the feature and specs↔coverage authors the specs, with a
// coverage-gated repair loop the wizard never had. What remains is the tracking
// surface the routed DraftDialog reads.

export interface TestsDraftRouteDeps {
  logsDir: string
  projectRoot: string
  workspaceEvents?: WorkspaceEventPublisher
}

export async function testsDraftRoutes(
  app: FastifyInstance,
  deps: TestsDraftRouteDeps,
): Promise<void> {
  app.get('/api/tests/draft', async () => {
    return listDrafts(deps.logsDir)
  })

  app.get<{ Params: { id: string } }>('/api/tests/draft/:id', async (req, reply) => {
    const rec = readDraft(deps.logsDir, req.params.id)
    if (!rec) {
      reply.code(404)
      return { error: 'draft not found' }
    }
    return rec
  })

  // An external draft sits in `generating` for every stage before ready/applied
  // (statusForExternalStage), so this is the stop control for a client-driven
  // authoring session: it settles the RECORD. There is no local process to kill
  // — the agent lives in the user's own client window.
  app.post<{ Params: { id: string } }>('/api/tests/draft/:id/cancel-generation', async (req, reply) => {
    const rec = readDraft(deps.logsDir, req.params.id)
    if (!rec) {
      reply.code(404)
      return { error: 'draft not found' }
    }
    if (!isTransientGenerationStatus(rec.status)) {
      reply.code(409)
      return { error: `cannot cancel-generation from status ${rec.status}` }
    }
    transitionDraft(deps, rec.draftId, 'cancelled', {
      activeAgentStage: undefined,
      errorMessage: 'Generation cancelled by user',
    })
    return { draftId: rec.draftId, status: 'cancelled' }
  })

  app.delete<{ Params: { id: string } }>('/api/tests/draft/:id', async (req, reply) => {
    const removed = deleteDraft(deps.logsDir, req.params.id)
    if (!removed) {
      reply.code(404)
      return { error: 'draft not found' }
    }
    reply.code(204)
    return null
  })
}
