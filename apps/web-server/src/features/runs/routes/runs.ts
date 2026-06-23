import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import type { RunDetail } from '../../runs/logic/run-store'
import type { RunStore, OrchestratorLike, RestartHealResult, RestartRunResult, StartRunOutcome } from '../../runs/logic/run-store'
import { loadFeatures } from '../../config/logic/feature-loader'
import { isHealClaimAllowed } from '../logic/heal/heal-claim-policy'
import type { ClientKind } from '../../../../../../shared/run-mode'
import { getGitRoot, resolveRepoPath } from '../../../shared/git-repo'
import { removeWorktree } from '../../runs/logic/runtime/repo-worktree'
import { listWorktrees, isUnder } from '../../runs/logic/runtime/worktree-inventory'
import { launchEditorDir } from '../../../shared/editor-launch'
import { buildRunPaths, runDirFor } from '../../runs/logic/runtime/run-paths'
import { loadProjectConfig } from '../../runs/logic/runtime/launcher/project-config'
import {
  loadAgentSession,
  locateMostRecentAgentSessionRef,
  parseAgentSessionRefFile,
  selectAgentSessionRef,
} from '../../agent-sessions/logic/agent-session-log'
import { isTerminalRunStatus } from '../../../../../../shared/run-state'
import type { ExecutionType } from '../../../../../../shared/verification'
import type { ExternalHealBroker } from '../logic/heal/external-heal-broker'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'

export interface ExternalHealAgentRequest {
  kind: 'external'
  sessionId: string
  clientKind: ClientKind
  clientVersion?: string
  conversationName?: string
  /** Whether this external client may *own* the heal loop (Desktop-only per
   *  heal-claim-policy). Defaults to true. When false, the run still uses
   *  External-client heal mode (external origin), but gets no externalHealSession
   *  and no broker claim — it waits for a Desktop/UI drive instead. */
  claimable?: boolean
}

export interface RunsRouteDeps {
  featuresDir: string
  projectRoot?: string
  /** Single source of truth for run state. Routes read + mutate exclusively
   *  through this — no direct manifest/index file access. */
  store: RunStore
  // Factory: given a feature name + optional healAgent override, build + start
  // an orchestrator. Returns the orchestrator synchronously after `start()` is
  // in flight (the factory awaits the initial spawn but not test completion).
  // When `healAgent.kind === 'external'`, the orchestrator must be configured
  // with externalHeal=true and the external-heal broker claim should be
  // bootstrapped before the orchestrator's heal-loop entry condition triggers.
  startRun(
    feature: string,
    env?: string,
    healAgent?: ExternalHealAgentRequest,
    isolation?: 'worktree' | 'queue',
    executionType?: ExecutionType,
  ): Promise<StartRunOutcome>
  /** Cancel a run still waiting in the admission queue (no orchestrator yet).
   *  Returns true when it was queued and is now aborted. */
  cancelQueuedRun?(runId: string): boolean
  /** Whether a worktree's owning run/benchmark is still active (non-terminal),
   *  so the cleanup UI can refuse to remove a worktree in use. Wired in the
   *  server factory where both the run + benchmark stores are in scope. */
  isWorktreeOwnerActive?(kind: 'run' | 'benchmark', id: string): boolean
  broker?: Pick<ExternalHealBroker, 'claim'>
  workspaceEvents?: WorkspaceEventPublisher
  restartHeal?(runId: string, text: string): Promise<RestartHealResult>
  restartRun?(runId: string): Promise<RestartRunResult>
}

export async function runsRoutes(app: FastifyInstance, deps: RunsRouteDeps): Promise<void> {
  app.get<{ Querystring: { feature?: string } }>('/api/runs', async (req) => {
    return deps.store.list({ feature: req.query.feature })
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    return detail
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/verification-report', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    if ((detail.manifest.executionType ?? 'run') !== 'verify') {
      reply.code(409)
      return { error: 'run is not a verification execution' }
    }
    return {
      runId: detail.runId,
      executionType: 'verify',
      status: detail.manifest.status,
      verification: detail.manifest.verification ?? null,
    }
  })

  // Structured heal-agent session view. Reads the per-run pointer file
  // (`agent-session.json`) the orchestrator writes after a heal cycle ends,
  // then parses + normalizes the agent CLI's own JSONL log into a uniform
  // event stream for both claude and codex. 404 with a `reason` field in
  // every failure mode — the UI falls back to the raw transcript replay.
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/agent-session', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { reason: 'run-not-found' }
    }
    const runDir = runDirFor(deps.store.logsDir, req.params.runId)
    // Prefer the most-recently-modified agent JSONL on disk over the
    // orchestrator-written ref file. The ref file is only updated when the
    // heal loop's cleanup runs cleanly — a SIGKILL'd server or a one-off
    // locator miss leaves it pointing at a stale agent (e.g. claude) even
    // when codex has since produced newer cycles for the same runDir. Fall
    // back to the ref file when no on-disk logs are locatable.
    const refPath = buildRunPaths(runDir).agentSessionRefPath
    let raw: string | null = null
    try { raw = fs.readFileSync(refPath, 'utf-8') } catch { /* missing or unreadable */ }
    const parsed = raw ? parseAgentSessionRefFile(raw) : null
    const ref = locateMostRecentAgentSessionRef(runDir)
      ?? (parsed ? selectAgentSessionRef(parsed) : null)
    if (!ref) {
      reply.code(404)
      return { reason: 'no-session-ref' }
    }
    if (!fs.existsSync(ref.logPath)) {
      reply.code(404)
      return { reason: 'session-log-missing' }
    }
    const { events, meta } = loadAgentSession(ref)
    return { agent: ref.agent, sessionId: ref.sessionId, model: meta.model, effort: meta.effort, events }
  })

  app.get<{ Params: { runId: string; '*': string } }>('/api/runs/:runId/artifacts/*', async (req, reply) => {
    const runDir = runDirFor(deps.store.logsDir, req.params.runId)
    const runPaths = buildRunPaths(runDir)
    // Try the live `playwright-artifacts/` first, then fall back to the
    // durable `playwright-artifacts-keep/` snapshot. Heal-cycle reruns wipe
    // the live dir at the start of every Playwright invocation, so the keep
    // dir is what carries the videos/traces for tests not in the latest
    // rerun selection.
    const bases = [runPaths.playwrightArtifactsDir, runPaths.playwrightArtifactsKeepDir]
    let validRel: string | null = null
    for (const base of bases) {
      const requested = path.resolve(base, req.params['*'])
      const rel = path.relative(base, requested)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      validRel = rel
      try {
        const stat = fs.statSync(requested)
        if (stat.isFile()) {
          reply.type(contentTypeFor(requested))
          return reply.send(fs.createReadStream(requested))
        }
      } catch { /* try next base */ }
    }
    if (validRel === null) {
      reply.code(400)
      return { error: 'invalid artifact path' }
    }
    reply.code(404)
    return { error: 'artifact not found' }
  })

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
    // Heal-claim policy: only Desktop clients may own a heal claim. A
    // disallowed (CLI / 'other') client still triggers an external-origin run
    // (so it uses External-client heal, not the project Heal Agent) — it just
    // can't claim, so it starts with `claimable: false` and waits for a
    // Desktop/UI drive. A request with no healAgent body (e.g. the UI Run
    // button) is left untouched and uses the project config. The reuse-active
    // path below funnels through broker.claim, which rejects on its own.
    const claimSuppressed = !!healAgent && !('error' in healAgent) && !isHealClaimAllowed(healAgent.clientKind)
    const externalRunReq = healAgent ? { ...healAgent, claimable: !claimSuppressed } : undefined
    if (healAgent) {
      const active = findActiveRunForFeature(deps.store, feature, env)
      if (active) {
        const claim = deps.broker?.claim(active.manifest.runId, {
          sessionId: healAgent.sessionId,
          clientKind: healAgent.clientKind,
          ...(healAgent.clientVersion ? { clientVersion: healAgent.clientVersion } : {}),
          ...(healAgent.conversationName ? { conversationName: healAgent.conversationName } : {}),
        }) ?? null
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
                  'Heal claiming is restricted to Claude/Codex Desktop clients. CLI clients can run/verify but cannot own a heal claim.',
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
        // Same-repo collision and the caller didn't choose how to handle it.
        // Nothing started — surface the choice so the UI / MCP client can ask.
        reply.code(409)
        return {
          type: 'repo_collision_requires_choice',
          conflictingRunId: outcome.conflictingRunId,
          conflictingFeature: outcome.conflictingFeature,
          repoPaths: outcome.repoPaths,
          options: ['worktree', 'queue'] as const,
          message: `Another run (${outcome.conflictingFeature}) is using the same app. Re-send with isolation:"worktree" to run it isolated, or isolation:"queue" to wait until that run finishes.`,
        }
      }
      if (outcome.kind === 'queued') {
        reply.code(202)
        return { runId: outcome.runId, status: 'queued', queueReason: outcome.reason }
      }
      // started — the factory registers the orchestrator; set here too so the
      // registration is guaranteed regardless of factory implementation.
      deps.store.registry.set(outcome.orch.runId, outcome.orch)
      reply.code(201)
      return {
        runId: outcome.orch.runId,
        ...(claimSuppressed
          ? {
              claimSuppressed: true,
              message:
                'Heal claiming is restricted to Claude/Codex Desktop clients; this run started without a heal claim. Drive heal from Desktop or the web UI.',
            }
          : {}),
      }
    } catch (err) {
      const code = typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500
      reply.code(code)
      return { error: err instanceof Error ? err.message : String(err) }
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
  app.get('/api/cleanup/runs', async () => {
    return deps.store.cleanupListing()
  })

  // GET /api/cleanup/worktrees — every git worktree canary-lab created under the
  // logs dir (per-run isolation, benchmark arm/staging, inspect snapshots, plus
  // stale ones left by crashed runs). `active` worktrees belong to a still-
  // running run/benchmark and must not be removed out from under it.
  app.get('/api/cleanup/worktrees', async () => {
    const sourceRoots = await featureRepoRoots(deps.featuresDir)
    const entries = await listWorktrees({ logsDir: deps.store.logsDir, sourceRoots, now: Date.now() })
    return {
      worktrees: entries.map((e) => ({
        ...e,
        active:
          (e.ownerKind === 'run' || e.ownerKind === 'benchmark') && e.ownerId
            ? !!deps.isWorktreeOwnerActive?.(e.ownerKind, e.ownerId)
            : false,
      })),
    }
  })

  // POST /api/cleanup/worktrees/open — open a worktree folder in the user's
  // editor ("visit"). Guarded to paths inside the logs dir. Best-effort launch.
  app.post<{ Body: { path?: string } }>('/api/cleanup/worktrees/open', async (req, reply) => {
    const target = req.body?.path
    if (!target || typeof target !== 'string') {
      reply.code(400)
      return { error: 'path is required' }
    }
    if (!isUnder(target, deps.store.logsDir)) {
      reply.code(400)
      return { error: 'path must be inside the logs directory' }
    }
    if (!fs.existsSync(target)) {
      reply.code(404)
      return { error: 'worktree directory not found' }
    }
    const editor = deps.projectRoot ? loadProjectConfig(deps.projectRoot).editor : 'auto'
    try {
      const usedEditor = launchEditorDir(editor, target)
      return { opened: true, path: target, editor: usedEditor }
    } catch (err) {
      reply.code(200)
      return { opened: false, path: target, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // DELETE /api/cleanup/worktrees — remove one worktree via `git worktree
  // remove` (+ prune), guarded to paths inside the logs dir and not in use.
  app.delete<{ Body: { path?: string } }>('/api/cleanup/worktrees', async (req, reply) => {
    const target = req.body?.path
    if (!target || typeof target !== 'string') {
      reply.code(400)
      return { error: 'path is required' }
    }
    if (!isUnder(target, deps.store.logsDir)) {
      reply.code(400)
      return { error: 'path must be inside the logs directory' }
    }
    const sourceRoots = await featureRepoRoots(deps.featuresDir)
    const entries = await listWorktrees({ logsDir: deps.store.logsDir, sourceRoots, now: Date.now() })
    const entry = entries.find((e) => e.path === target)
    if (!entry) {
      reply.code(404)
      return { error: 'worktree not found' }
    }
    const active =
      (entry.ownerKind === 'run' || entry.ownerKind === 'benchmark') && entry.ownerId
        ? !!deps.isWorktreeOwnerActive?.(entry.ownerKind, entry.ownerId)
        : false
    if (active) {
      reply.code(409)
      return { error: 'worktree belongs to an active run — abort it first' }
    }
    await removeWorktree({ sourceRoot: entry.sourceRoot, worktreeRoot: entry.path })
    return { removed: true, freedBytes: entry.bytes }
  })

  // POST /api/runs/:runId/trim — reclaim disk by deleting a terminal run's
  // Playwright artifact dirs while keeping the run in history. Same active/
  // stale policy as DELETE (enforced in `RunStore.trimArtifacts`), mapped to
  // HTTP codes here.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/trim', async (req, reply) => {
    const result = deps.store.trimArtifacts(req.params.runId)
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
    return { freedBytes: result.freedBytes ?? 0 }
  })
}

// Distinct git toplevels for every repo declared by a feature — the source
// repos whose `git worktree list` we scan for canary-lab worktrees.
async function featureRepoRoots(featuresDir: string): Promise<string[]> {
  const roots = new Set<string>()
  for (const feature of loadFeatures(featuresDir)) {
    for (const repo of feature.repos ?? []) {
      try {
        const root = await getGitRoot(resolveRepoPath(repo.localPath))
        if (root) roots.add(root)
      } catch { /* skip repos that aren't resolvable */ }
    }
  }
  return [...roots]
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.zip') return 'application/zip'
  return 'application/octet-stream'
}

const EXTERNAL_CLIENT_KINDS: ExternalHealAgentRequest['clientKind'][] = [
  'claude',
  'codex',
  'claude-pty',
  'codex-pty',
  'other',
]

function parseExternalHealAgent(
  value: unknown,
): ExternalHealAgentRequest | { error: string } | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') return { error: 'healAgent must be an object' }
  const v = value as Record<string, unknown>
  if (v.kind === undefined) return null
  // v1 only wires up the external kind via this body field; the existing
  // project-config healAgent setting remains the source of truth for
  // 'auto' / 'claude' / 'codex' / 'manual'. The body override is *only* the
  // hook for external MCP clients to register themselves at run start.
  if (v.kind !== 'external') {
    return { error: 'healAgent.kind must be "external" when overriding from the request body' }
  }
  if (typeof v.sessionId !== 'string' || !v.sessionId) {
    return { error: 'healAgent.sessionId is required when kind="external"' }
  }
  if (typeof v.clientKind !== 'string' || !(EXTERNAL_CLIENT_KINDS as string[]).includes(v.clientKind)) {
    return { error: `healAgent.clientKind must be one of: ${EXTERNAL_CLIENT_KINDS.join(', ')}` }
  }
  return {
    kind: 'external',
    sessionId: v.sessionId,
    clientKind: v.clientKind as ExternalHealAgentRequest['clientKind'],
    ...(typeof v.clientVersion === 'string' ? { clientVersion: v.clientVersion } : {}),
    ...(typeof v.conversationName === 'string' ? { conversationName: v.conversationName } : {}),
  }
}

function findActiveRunForFeature(
  store: RunStore,
  feature: string,
  env: string | undefined,
): RunDetail | null {
  const candidates: Array<{ detail: RunDetail; startedAt: string }> = []
  for (const entry of store.list({ feature })) {
    if (entry.status !== 'healing') continue
    const detail = store.get(entry.runId)
    if (!detail) continue
    if (env && detail.manifest.env !== env) continue
    candidates.push({ detail, startedAt: entry.startedAt })
  }
  candidates.sort((a, b) => {
    const priorityDiff = activeRunPriority(a.detail) - activeRunPriority(b.detail)
    if (priorityDiff !== 0) return priorityDiff
    return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
  })
  return candidates[0]?.detail ?? null
}

function activeRunPriority(detail: RunDetail): number {
  if (detail.manifest.lifecycle?.phase === 'waiting-for-signal') return 0
  if (detail.manifest.status === 'healing') return 1
  return 2
}
