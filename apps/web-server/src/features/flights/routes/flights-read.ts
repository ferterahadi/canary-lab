// Flights REST — reads: the flight index, the per-feature lookup, one flight,
// its stage remedy, and stage evidence. Split out of flights.ts; bodies unchanged.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { FlightRouteDeps } from './flight-route-deps'
import type { FlightRouteContext } from './flight-route-context'
import { FLIGHT_STAGE_KEYS, isActiveFlightStatus, type FlightEntryOptions, type FlightStageEntryOption } from '../logic/types'
import { flightStageRemedy } from '../logic/stage-remedy'
import { loadFeatures } from '../../../shared/feature-loader'
import { buildStageEntryValidator } from './flight-route-support'
import { withWorkspaceEvidence, workspaceStageEvidence } from '../logic/workspace-evidence'

export async function registerFlightReadRoutes(app: FastifyInstance, deps: FlightRouteDeps, ctx: FlightRouteContext): Promise<void> {
  const { store, planStore, conductorDeps } = ctx

  // the latest (list is newest-first) instead of destructively pruning disk.
  app.get('/api/flights', async () => {
    const seen = new Set<string>()
    const flights = store.list().filter((e) => {
      if (seen.has(e.feature)) return false
      seen.add(e.feature)
      return true
    })
    return { flights }
  })

  // Stage-entry menu for one feature (the UI's "flight from here" dialog).
  // Static segment, so it never shadows /api/flights/:id.
  app.get<{ Querystring: { feature?: string; env?: string } }>(
    '/api/flights/entry',
    async (req, reply) => {
      const feature = req.query?.feature?.trim()
      if (!feature) {
        reply.code(400)
        return { error: 'feature query is required' }
      }
      const env = req.query?.env?.trim() || 'local'

      const entry = store.latestForFeature(feature)
      const manifest = entry ? store.get(entry.flightId) : null
      // Best-effort config read for the prefill — a config that fails
      // validation elsewhere must not take the entry menu down with it.
      let config
      try {
        config = loadFeatures(deps.featuresDir).find((c) => c.name === feature)
      } catch {
        config = undefined
      }
      if (!manifest && !config) {
        reply.code(404)
        return { error: `"${feature}" isn't set up yet — no flight has run and the suite has no settings.` }
      }

      // R81: a stage is unlocked by EVIDENCE, not by the existence of a flight
      // record. Work done outside the conductor — a standalone coverage run,
      // repo/requirement/docs setup, MCP authoring — completes the same stage
      // the conductor would have, so it must open the same entry point. (This
      // replaces the R41 blanket lock, which made a fully-built feature look
      // like it had never flown and offered only a start-from-scratch.) The
      // validator's on-disk probes are the single gate, exactly as they are for
      // a jump inside an existing record.
      const validate = buildStageEntryValidator(deps.featuresDir, deps.logsDir)
      const stages: FlightStageEntryOption[] = FLIGHT_STAGE_KEYS.map((key) => {
        const reason = validate({ feature, fromStage: key, env, existing: manifest })
        return reason ? { key, allowed: false, reason } : { key, allowed: true }
      })

      // Configs may declare repos as `~/...` — expand so the prefill posts
      // paths the start route's realpath check accepts.
      //
      // Deduplicated: several services legitimately share one source tree (a
      // suite declaring one repo per service over a single checkout, so each
      // gets its own per-run worktree). One entry each put the same directory in
      // the launcher's repo list three times over — three identical rows the
      // user cannot tell apart, and a repoPaths list that then made the flight
      // claim three repositories everywhere it was counted.
      const seen = new Set<string>()
      const configRepoPaths = (config?.repos ?? [])
        .map((r) => r.localPath)
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p))
        .filter((p) => {
          const key = p.replace(/[\\/]+$/, '')
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      const options: FlightEntryOptions = {
        feature,
        flight: manifest
          ? {
              flightId: manifest.flightId,
              status: manifest.status,
              stages: manifest.stages.map((s) => ({ key: s.key, status: s.status })),
            }
          : null,
        active: manifest ? isActiveFlightStatus(manifest.status) : false,
        canContinue: manifest?.status === 'paused',
        prefill: {
          repoPaths: manifest?.repoPaths ?? configRepoPaths,
          // A feature that never flew has no recorded intent, but its config
          // already carries one — the sentence the suite was authored against.
          // Falling through to it means the derived flight's "Intent · what to
          // test" card reads the suite's own purpose instead of a blank line,
          // and the launcher opens prefilled rather than empty.
          description: manifest?.description ?? config?.description ?? '',
          env: manifest?.opts.env ?? env,
          coverageTarget: manifest?.opts.coverageTarget ?? 100,
        },
        stages,
        // A derived flight has no manifest, so its panels have nowhere else to
        // get facts from. Probed here because this is the one call the derived
        // view already makes — no extra round trip, nothing persisted.
        evidence: workspaceStageEvidence(
          { featuresDir: deps.featuresDir, logsDir: deps.logsDir },
          feature,
          [...FLIGHT_STAGE_KEYS],
          env,
        ),
      }
      return options
    },
  )

  app.get<{ Params: { id: string } }>('/api/flights/:id', async (req, reply) => {
    const manifest = store.get(req.params.id)
    if (!manifest) {
      reply.code(404)
      return { error: `flight not found: ${req.params.id}` }
    }
    // A settled stage that recorded no evidence reads its artifacts from the
    // workspace instead of rendering blank — same read-time derivation the
    // /remedy route uses, and nothing is written back. Recorded evidence always
    // wins; a stage with none costs the probes and no more.
    const stages = withWorkspaceEvidence(
      { featuresDir: deps.featuresDir, logsDir: deps.logsDir },
      manifest.feature,
      manifest.stages,
      manifest.opts.env,
    )
    // The header strip's RUN reads `runVerdict`, written only by a conducted run
    // stage — a record whose run stage settled by evidence (external work, older
    // records) showed no RUN next to a green run one click below. Same
    // fill-the-gap rule as stage evidence: only when the stored field is absent
    // AND the stage actually settled, and never written back.
    const run = stages.find((s) => s.key === 'run')
    const runEv = run && (run.status === 'done' || run.status === 'skipped')
      ? (run.evidence as { status?: unknown } | undefined)
      : undefined
    const probedVerdict = runEv?.status === 'passed' || runEv?.status === 'failed' || runEv?.status === 'aborted'
      ? runEv.status
      : undefined
    // REPORT existence is checked at read time: `links.evaluationZip` is a
    // persisted absolute path, and "REPORT ready" over a deleted archive is a
    // claim the download button immediately disproves. The stored link is left
    // alone — re-exporting restores it.
    let links = manifest.links
    if (links?.evaluationZip && !fs.existsSync(links.evaluationZip)) {
      const { evaluationZip: _gone, ...rest } = links
      links = rest
    }
    return {
      ...manifest,
      ...(manifest.runVerdict === undefined && probedVerdict !== undefined ? { runVerdict: probedVerdict } : {}),
      ...(links !== manifest.links ? { links } : {}),
      stages,
    }
  })

  // Machine-actionable fix for a failed stage — derived at read time (live
  // `git status`), never persisted. `remedy: null` = nothing actionable;
  // `repos: []` = the error is stale and everything is clean (just Continue).
  app.get<{ Params: { id: string } }>('/api/flights/:id/remedy', async (req, reply) => {
    const manifest = store.get(req.params.id)
    if (!manifest) {
      reply.code(404)
      return { error: `flight not found: ${req.params.id}` }
    }
    return { remedy: await flightStageRemedy(manifest) }
  })

  // Execute the remedy (stash or commit every currently-dirty repo), then
  // resume the flight — the same path as the header Continue, so the retried
  // stage and the flights-changed events flow exactly as a manual resume.
}
