import type { FastifyInstance } from 'fastify'
import {
  createAgentProbeService,
  type AgentProbeService,
} from '../../agent-sessions/logic/agent-probe'

export interface AgentProbeRouteDeps {
  /** Injectable for tests; production uses the default subprocess-backed service. */
  probeService?: AgentProbeService
}

/**
 * CLI presence/auth/version plus discoverable models for the model-cockpit
 * surfaces (settings matrix + launch gate). Informational only — no launch is
 * blocked when probing or catalog discovery fails.
 */
export async function agentProbeRoutes(
  app: FastifyInstance,
  deps: AgentProbeRouteDeps = {},
): Promise<void> {
  const service = deps.probeService ?? createAgentProbeService()

  app.get<{ Querystring: { fresh?: string } }>('/api/agent-probe', async (req) => {
    return service.snapshot(req.query?.fresh === '1')
  })
}
