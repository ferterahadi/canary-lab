// Runs REST — start/heal/lifecycle actions: start a run, pause/cancel heal, write
// to the agent, restart, abort, delete. Split out of runs.ts; bodies unchanged.
import type { FastifyInstance } from 'fastify'
import type { RunsRouteDeps } from './runs-route-deps'
import fs from 'fs'
import path from 'path'
import type { RunStore } from '../logic/run-store'
import { loadFeatures } from '../../../shared/feature-loader'
import { isHealClaimAllowed } from '../logic/heal/heal-claim-policy'
import { type RepoBranchMismatch } from '../../../shared/git-repo'
import type { ExecutionType } from '../../../../../../shared/verification'
import { ExternalHealAgentRequest, findActiveRunForFeature, parseExternalHealAgent } from './runs-route-support'
import { GettingStartedBusyError, type GettingStartedOwner } from '../../config/logic/getting-started-session'

export { compareActiveRuns } from './runs-route-support'
export type { ExternalHealAgentRequest } from './runs-route-support'

export async function registerRunActionRoutes(app: FastifyInstance, deps: RunsRouteDeps): Promise<void> {
  app.post<{
    Body: {
      feature?: string
      env?: string
      healAgent?: ExternalHealAgentRequest | { kind?: string }
      forceNew?: boolean
      isolation?: 'worktree' | 'queue'
      // 'boot' = apply envset + boot the feature's services and hold them, no
      // Playwright. Stop the run (POST /api/runs/:runId/abort) to tear down +
      // revert env. Defaults to a normal test run.
      mode?: 'test' | 'boot'
      gettingStartedSource?: GettingStartedOwner
    }
  }>('/api/runs', async (req, reply) => {
    const feature = req.body?.feature
    if (typeof feature !== 'string' || feature.length === 0) {
      reply.code(400)
      return { error: 'feature required' }
    }
    const features = loadFeatures(deps.featuresDir)
    const featureCfg = features.find((f) => f.name === feature)
    if (!featureCfg) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    // env is optional only when the feature didn't declare any. Otherwise it
    // must be one of feature.envs (default: first entry).
    const declared = featureCfg.envs ?? []
    const env = declared.length > 0 ? (req.body?.env ?? declared[0]) : undefined
    if (declared.length > 0 && (typeof env !== 'string' || !declared.includes(env))) {
      reply.code(400)
      return { error: `env must be one of: ${declared.join(', ')}` }
    }
    const healAgent = parseExternalHealAgent(req.body?.healAgent)
    if (healAgent && 'error' in healAgent) {
      reply.code(400)
      return { error: healAgent.error }
    }
    // Heal-claim policy: only runner-spawned PTY agents Canary Lab launches
    // itself (claude-pty/codex-pty) are denied a heal claim. A disallowed
    // client still triggers an external-origin run (so it uses External-client
    // heal, not the project Heal Agent) — it just can't claim, so it starts
    // with `claimable: false` and waits for an interactive Claude/Codex client
    // or the web UI to drive it. A request with no healAgent body (e.g. the UI
    // Run button) is left untouched and uses the project config. The
    // reuse-active path below funnels through broker.claim, which rejects on
    // its own.
    const claimSuppressed = !!healAgent && !('error' in healAgent) && !isHealClaimAllowed(healAgent.clientKind)
    // The caller's own claimable:false survives (never the reverse — policy
    // suppression cannot be overridden upward). See parseExternalHealAgent.
    const externalRunReq = healAgent ? { ...healAgent, claimable: !claimSuppressed && healAgent.claimable !== false } : undefined
    let gettingStartedSession: string | null = null
    if (req.body?.gettingStartedSource && deps.gettingStarted) {
      try {
        gettingStartedSession = deps.gettingStarted.claim('run', req.body.gettingStartedSource).sessionId
      } catch (err) {
        if (!(err instanceof GettingStartedBusyError)) throw err
        reply.code(409)
        return { type: err.type, error: err.message, active: err.active }
      }
    }
    if (healAgent) {
      const active = findActiveRunForFeature(deps.store, feature, env)
      if (active) {
        if (gettingStartedSession) {
          deps.gettingStarted?.attach(gettingStartedSession, { kind: 'run', id: active.manifest.runId })
        }
        // A caller that explicitly declined the claim must not grab the reuse
        // claim either — the whole point of claimable:false is leaving the loop
        // for a real client. Policy suppression (a PTY kind) still funnels
        // through broker.claim, which rejects with its own reason.
        const claim = healAgent.claimable !== false
          ? deps.broker?.claim(active.manifest.runId, {
              sessionId: healAgent.sessionId,
              clientKind: healAgent.clientKind,
              ...(healAgent.clientVersion ? { clientVersion: healAgent.clientVersion } : {}),
              ...(healAgent.conversationName ? { conversationName: healAgent.conversationName } : {}),
            }) ?? null
          : null
        reply.code(200)
        return {
          runId: active.manifest.runId,
          reused: true,
          status: active.manifest.status,
          claimed: claim ? claim.accepted : false,
          claim,
          ...(claimSuppressed
            ? {
                claimSuppressed: true,
                message:
                  'Heal claiming is blocked for runner-spawned agents (the benchmark/portify PTY sessions Canary Lab launches itself). Interactive Claude/Codex clients (Desktop or CLI) can run, verify, and own a heal claim.',
              }
            : {}),
          ...(req.body?.forceNew
            ? {
                ignoredForceNew: true,
                warning: 'An active run already exists for this feature. Continue it with signal_run and wait_for_heal_task instead of starting a fresh run.',
              }
            : {}),
        }
      }
    }
    const isolation = req.body?.isolation === 'worktree' || req.body?.isolation === 'queue'
      ? req.body.isolation
      : undefined
    const executionType: ExecutionType = req.body?.mode === 'boot' ? 'boot' : 'run'
    try {
      const outcome = await deps.startRun(feature, env, externalRunReq, isolation, executionType)
      if (outcome.kind === 'collision') {
        if (gettingStartedSession) deps.gettingStarted?.abandon(gettingStartedSession)
        // Same-repo collision and the caller didn't choose how to handle it.
        // Nothing started — surface the choice so the UI / MCP client can ask.
        reply.code(409)
        return {
          type: 'repo_collision_requires_choice',
          conflictingRunId: outcome.conflictingRunId,
          conflictingFeature: outcome.conflictingFeature,
          repoPaths: outcome.repoPaths,
          options: ['worktree', 'queue'] as const,
          // `error` is what the GUI shows (the client only lifts `error` into
          // Error.message, so without it this 409 rendered as literally
          // "HTTP 409"); `message` keeps the agent-facing re-send instructions.
          error: `Another run (${outcome.conflictingFeature}) is using the same app. Wait for it to finish, then try again.`,
          message: `Another run (${outcome.conflictingFeature}) is using the same app. Re-send with isolation:"worktree" to run it isolated, or isolation:"queue" to wait until that run finishes.`,
        }
      }
      if (outcome.kind === 'queued') {
        if (gettingStartedSession) {
          deps.gettingStarted?.attach(gettingStartedSession, { kind: 'run', id: outcome.runId })
        }
        reply.code(202)
        return { runId: outcome.runId, status: 'queued', queueReason: outcome.reason }
      }
      // started — the factory registers the orchestrator; set here too so the
      // registration is guaranteed regardless of factory implementation.
      deps.store.registry.set(outcome.orch.runId, outcome.orch)
      if (gettingStartedSession) {
        deps.gettingStarted?.attach(gettingStartedSession, { kind: 'run', id: outcome.orch.runId })
      }
      reply.code(201)
      return {
        runId: outcome.orch.runId,
        ...(claimSuppressed
          ? {
              claimSuppressed: true,
              message:
                'Heal claiming is blocked for runner-spawned agents (the benchmark/portify PTY sessions Canary Lab launches itself), so this run started without a heal claim. Drive heal from an interactive Claude/Codex client or the web UI.',
            }
          : {}),
      }
    } catch (err) {
      if (gettingStartedSession) deps.gettingStarted?.abandon(gettingStartedSession)
      const code = typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500
      reply.code(code)
      const message = err instanceof Error ? err.message : String(err)
      // A configured-branch mismatch carries structured rows — surface them as a
      // typed 409 (like repo_collision_requires_choice) so the UI can offer to
      // switch the repos onto the pinned branch, or re-pin the feature.
      const mismatch = (err as { branchMismatch?: RepoBranchMismatch[] }).branchMismatch
      if (Array.isArray(mismatch) && mismatch.length > 0) {
        return { type: 'repo_branch_mismatch' as const, feature, repos: mismatch, error: message }
      }
      return { error: message }
    }
  })

  // Mid-Run Heal: manual interruption. Looks up the orchestrator in the
  // registry, asks it to SIGTERM Playwright + jump into the heal cycle.
  // 404 when unknown, 409 with a reason when pausing is meaningless,
  // 202 + status payload on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/pause-heal', async (req, reply) => {
    const orch = deps.store.registry.get(req.params.runId)
    if (!orch) {
      reply.code(404)
      return { error: 'run not active' }
    }
    const result = await orch.pauseAndHeal()
    if (!result.ok) {
      reply.code(409)
      return { reason: result.reason }
    }
    reply.code(202)
    return { status: 'healing', failureCount: result.failureCount }
  })

  // Cancel an in-flight heal cycle. SIGTERMs the agent pty, breaks the heal
  // loop, appends a journal entry. 404 when unknown, 409 with a reason when
  // there's nothing to cancel, 202 on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/cancel-heal', async (req, reply) => {
    const orch = deps.store.registry.get(req.params.runId)
    if (!orch) {
      reply.code(404)
      return { error: 'run not active' }
    }
    const result = await orch.cancelHeal()
    if (!result.ok) {
      reply.code(409)
      return { reason: result.reason }
    }
    reply.code(202)
    return { status: 'cancelled' }
  })

  // Live interject — pipe a line of text to the running heal agent's stdin
  // so the user can guide the agent without restarting the cycle. 404 when
  // unknown, 409 when there's no agent running for this run.
  app.post<{ Params: { runId: string }; Body: { data: string } }>(
    '/api/runs/:runId/agent-input',
    async (req, reply) => {
      if (typeof req.body?.data !== 'string') {
        reply.code(400)
        return { error: 'data must be a string' }
      }
      const orch = deps.store.registry.get(req.params.runId)
      if (!orch) {
        const restarted = await deps.restartHeal?.(req.params.runId, req.body.data)
        if (restarted?.ok) {
          reply.code(202)
          return { status: 'restarted' }
        }
        reply.code(restarted?.reason === 'spawn-failed' ? 500 : 409)
        return { reason: restarted?.reason ?? 'no-agent-running' }
      }
      if (!orch.interjectHealAgent) {
        reply.code(409)
        return { reason: 'no-agent-running' }
      }
      const result = await orch.interjectHealAgent(req.body.data)
      if (!result.ok) {
        if (result.reason === 'no-agent-running') {
          const restarted = await deps.restartHeal?.(req.params.runId, req.body.data)
          if (restarted?.ok) {
            reply.code(202)
            return { status: 'restarted' }
          }
        }
        reply.code(409)
        return { reason: result.reason }
      }
      reply.code(202)
      return { status: 'sent' }
    },
  )

  app.post<{ Params: { runId: string } }>('/api/runs/:runId/restart', async (req, reply) => {
    const restarted = await deps.restartRun?.(req.params.runId)
    if (restarted?.ok) {
      reply.code(202)
      return { status: 'restarted', mode: restarted.mode }
    }
    const reason = restarted?.reason ?? 'not-restartable'
    reply.code(reason === 'run-not-found' ? 404 : reason === 'spawn-failed' ? 500 : 409)
    return { reason }
  })

  // POST /api/runs/:runId/abort — explicit abort of an active run. Stops
  // the orchestrator (kills Playwright + heal agent + service ptys) and
  // marks the manifest 'aborted'. The run is preserved in history so the
  // user can audit the logs after. 404 when not active, 204 on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/abort', async (req, reply) => {
    const result = await deps.store.abort(req.params.runId)
    if (!result.ok) {
      // A run still waiting in the admission queue has no orchestrator, so the
      // store can't abort it — cancel it out of the queue instead.
      if (deps.cancelQueuedRun?.(req.params.runId)) {
        reply.code(204)
        return ''
      }
      reply.code(404)
      return { error: 'run not active' }
    }
    reply.code(204)
    return ''
  })

  // DELETE /api/runs/:runId — hard-remove a terminal run from history.
  // The action-matrix policy (active runs must be aborted first) lives in
  // `RunStore.delete`; the route just maps the structured failure into HTTP
  // status codes.
  app.delete<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const result = deps.store.delete(req.params.runId)
    if (!result.ok) {
      if (result.reason === 'not-found') {
        reply.code(404)
        return { error: 'run not found' }
      }
      reply.code(409)
      return {
        error: result.reason === 'active'
          ? 'run is still active; abort it first'
          : 'run is still active; reap or abort first',
      }
    }
    reply.code(204)
    return ''
  })

  // GET /api/cleanup/runs — disk-usage view for the Log Cleanup page: every
  // indexed run annotated with folder/artifact byte sizes + an `active` flag,
  // plus orphan directories (on disk, missing from index.json), plus
  // reclaimable totals. Walks each run dir on demand (the page is opened
  // rarely; sizes must be accurate after a trim).
}
