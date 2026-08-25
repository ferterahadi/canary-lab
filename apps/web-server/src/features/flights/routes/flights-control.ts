// Flights REST — control actions on an existing flight: remedy, checkpoint
// responses, resume/pause/autopilot/redo/delete/abort. Bodies unchanged.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { FlightRouteDeps } from './flight-route-deps'
import type { FlightRouteContext } from './flight-route-context'
import { resumeFlight } from '../logic/conductor'
import { applyFlightStageRemedy } from '../logic/stage-remedy'

export async function registerFlightControlRoutes(app: FastifyInstance, deps: FlightRouteDeps, ctx: FlightRouteContext): Promise<void> {
  const { store, planStore, conductorDeps } = ctx

  app.post<{ Params: { id: string }; Body: { action?: string } | undefined }>(
    '/api/flights/:id/remedy',
    async (req, reply) => {
      const manifest = store.get(req.params.id)
      if (!manifest) {
        reply.code(404)
        return { error: `flight not found: ${req.params.id}` }
      }
      const action = req.body?.action
      if (action !== 'stash' && action !== 'commit') {
        reply.code(400)
        return { error: 'action must be "stash" or "commit"' }
      }
      try {
        await applyFlightStageRemedy(manifest, action)
        const { manifest: resumed } = resumeFlight(req.params.id, conductorDeps)
        return resumed
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode
        reply.code(typeof statusCode === 'number' ? statusCode : 500)
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}
