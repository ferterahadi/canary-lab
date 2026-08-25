import type { FastifyInstance } from 'fastify'
import { agentJobStore } from '../logic/agent-jobs/store'
import { stopAgentProcesses } from '../logic/agent-process'

// Read + stop the spawned-agent records. The read half makes an agent Canary
// started visible outside the flight view that happens to own it; the stop half
// is the narrower alternative to pausing a whole flight.
//
// What stopping ONE agent actually does, stated in the copy because it is easy to
// promise the wrong thing: the flight's drive loop is awaiting that stage, so
// killing its agent fails the stage attempt and the flight parks `stage-failed`.
// The flight does NOT sail on. What you get instead of a pause is narrower and
// better-recorded: the run and the export are left alone, the error is recorded on
// the stage rather than the step being reset to `pending`, and queued sibling
// flights on the same repos are released.

export interface AgentJobRouteDeps {
  logsDir: string
}

export async function agentJobRoutes(app: FastifyInstance, deps: AgentJobRouteDeps): Promise<void> {
  const store = () => agentJobStore(deps.logsDir)

  app.get<{ Querystring: { flight?: string } }>('/api/agent-jobs', async (req) => {
    const jobs = req.query.flight ? store().forFlight(req.query.flight) : store().list()
    return { jobs }
  })

  app.post<{ Params: { jobId: string } }>('/api/agent-jobs/:jobId/stop', async (req, reply) => {
    const record = store().get(req.params.jobId)
    if (!record) {
      reply.code(404)
      return { error: 'agent job not found' }
    }
    if (record.status !== 'running' || !record.scope) {
      // Idempotent, never a 409: "it already finished" is a success for a stop.
      // A running record with no scope predates scoped stopping and cannot be
      // reached — reported honestly rather than silently claimed as stopped.
      return { stopped: false, status: record.status }
    }
    // `by: 'user'` is what separates this ending from a flight-driven teardown in
    // the record — the runner reads it when it settles the row `stopped`.
    await stopAgentProcesses(record.scope, { by: 'user' })
    reply.code(202)
    return { stopped: true, jobId: record.jobId }
  })
}
