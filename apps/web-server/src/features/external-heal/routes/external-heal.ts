import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import type { RunStore } from '../../orchestration/logic/run-store'
import {
  ExternalHealBroker,
  type ClaimInput,
  type ExternalHealAuditEntry,
} from '../logic/external-heal-broker'
import type {
  ExternalHealClientKind,
  ExternalHealSessionStatus,
} from '../../orchestration/logic/runtime/manifest'
import { buildExternalHealContext, buildExternalRunSnapshot, writeHealSignal } from '../logic/external-heal-surface'
import { runDirFor } from '../../orchestration/logic/runtime/run-paths'
import {
  isActiveRunStatus,
  isRestartableRunStatus,
  isTerminalRunStatus,
  deriveRunActionAvailability,
  type HealSignalKind,
} from '../../../../../../shared/run-state'

const VALID_CLIENT_KINDS: ExternalHealClientKind[] = [
  'claude-cli',
  'claude-desktop',
  'codex-cli',
  'codex-desktop',
  'other',
]

const VALID_STATUS: ExternalHealSessionStatus[] = [
  'connected',
  'waiting',
  'healing',
  'running-tests',
  'paused',
  'disconnected',
]

const VALID_SIGNAL_KINDS: HealSignalKind[] = ['restart', 'rerun', 'heal']

const VALID_HANDOFF_TARGETS = ['auto', 'claude', 'codex', 'manual'] as const
export type HealHandoffTarget = typeof VALID_HANDOFF_TARGETS[number]

export interface ExternalHealRouteDeps {
  store: RunStore
  broker: ExternalHealBroker
  /** Optional hook so MCP / WS layers can react synchronously when a signal is
   *  accepted. The orchestrator picks signals up by polling the file system,
   *  but other consumers may want to broadcast immediately. */
  onSignalAccepted?(runId: string, kind: HealSignalKind, body: Record<string, unknown>): void
  /** Hook for `to ∈ {auto, claude, codex}` handoff on a terminal run — wraps
   *  the same `restartHeal` path the runs route uses. Returning `ok: false`
   *  surfaces as a 409 to the caller. Omit when local heal restart isn't
   *  available (e.g. test harnesses). */
  restartLocalHeal?(runId: string, guidance: string): Promise<{ ok: true } | { ok: false; reason: string }>
}

interface ClaimBody {
  sessionId?: string
  clientKind?: string
  clientVersion?: string
  conversationName?: string
}

interface ReleaseBody {
  sessionId?: string
}

interface HeartbeatBody {
  sessionId?: string
  status?: string
}

interface SignalBody {
  kind?: string
  body?: Record<string, unknown>
  sessionId?: string
}

interface HandoffBody {
  to?: string
  sessionId?: string
  guidance?: string
}

export async function externalHealRoutes(
  app: FastifyInstance,
  deps: ExternalHealRouteDeps,
): Promise<void> {
  // POST /api/runs/:runId/heal-agent/claim
  app.post<{ Params: { runId: string }; Body: ClaimBody }>(
    '/api/runs/:runId/heal-agent/claim',
    async (req, reply) => {
      const detail = deps.store.get(req.params.runId)
      if (!detail) {
        reply.code(404)
        return { error: 'run not found' }
      }
      const sessionId = req.body?.sessionId
      const clientKind = req.body?.clientKind
      if (typeof sessionId !== 'string' || !sessionId) {
        reply.code(400)
        return { error: 'sessionId is required' }
      }
      if (!isClientKind(clientKind)) {
        reply.code(400)
        return { error: `clientKind must be one of: ${VALID_CLIENT_KINDS.join(', ')}` }
      }
      const input: ClaimInput = {
        sessionId,
        clientKind,
        ...(typeof req.body?.clientVersion === 'string' ? { clientVersion: req.body.clientVersion } : {}),
        ...(typeof req.body?.conversationName === 'string' ? { conversationName: req.body.conversationName } : {}),
      }
      const result = deps.broker.claim(req.params.runId, input)
      if (!result.accepted) {
        if (result.reason === 'client-kind-not-allowed') {
          reply.code(403)
          return {
            reason: result.reason,
            clientKind: result.clientKind,
            message:
              'Heal claiming is restricted to Claude/Codex Desktop clients. CLI clients can run and verify, but cannot own a heal claim.',
          }
        }
        reply.code(409)
        return { reason: result.reason, currentSession: result.currentSession }
      }
      return { accepted: true, session: result.session }
    },
  )

  // POST /api/runs/:runId/heal-agent/release
  app.post<{ Params: { runId: string }; Body: ReleaseBody }>(
    '/api/runs/:runId/heal-agent/release',
    async (req, reply) => {
      const sessionId = req.body?.sessionId
      if (typeof sessionId !== 'string' || !sessionId) {
        reply.code(400)
        return { error: 'sessionId is required' }
      }
      const result = deps.broker.release(req.params.runId, sessionId)
      if (!result.released) {
        reply.code(409)
        return { reason: 'no-matching-claim' }
      }
      reply.code(204)
      return ''
    },
  )

  // POST /api/runs/:runId/heal-agent/heartbeat
  app.post<{ Params: { runId: string }; Body: HeartbeatBody }>(
    '/api/runs/:runId/heal-agent/heartbeat',
    async (req, reply) => {
      const sessionId = req.body?.sessionId
      const status = req.body?.status
      if (typeof sessionId !== 'string' || !sessionId) {
        reply.code(400)
        return { error: 'sessionId is required' }
      }
      if (!isSessionStatus(status)) {
        reply.code(400)
        return { error: `status must be one of: ${VALID_STATUS.join(', ')}` }
      }
      const result = deps.broker.heartbeat(req.params.runId, sessionId, status)
      if (!result.ok) {
        reply.code(409)
        return { reason: result.reason }
      }
      reply.code(204)
      return ''
    },
  )

  // GET /api/runs/:runId/heal-context — compact agent-first bundle for the
  // external client. Reads from existing on-disk artifacts so the orchestrator
  // doesn't need to know the external client exists.
  app.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/heal-context',
    async (req, reply) => {
      const detail = deps.store.get(req.params.runId)
      if (!detail) {
        reply.code(404)
        return { error: 'run not found' }
      }
      return buildExternalHealContext({ detail, logsDir: deps.store.logsDir })
    },
  )

  // GET /api/runs/:runId/run-snapshot — verbose fallback with the full
  // external-heal snapshot, including raw summary and full count lists.
  app.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/run-snapshot',
    async (req, reply) => {
      const detail = deps.store.get(req.params.runId)
      if (!detail) {
        reply.code(404)
        return { error: 'run not found' }
      }
      return buildExternalRunSnapshot({ detail, logsDir: deps.store.logsDir })
    },
  )

  // POST /api/runs/:runId/signal — write a heal-cycle signal file. The
  // orchestrator's existing poll loop picks it up via the same path it uses
  // for local heal agents. When the run holds an external claim, sessionId
  // must match the claim holder.
  app.post<{ Params: { runId: string }; Body: SignalBody }>(
    '/api/runs/:runId/signal',
    async (req, reply) => {
      const detail = deps.store.get(req.params.runId)
      if (!detail) {
        reply.code(404)
        return { error: 'run not found' }
      }
      if (!isActiveRunStatus(detail.manifest.status)) {
        reply.code(409)
        return { reason: 'run-not-active' }
      }
      const kind = req.body?.kind
      if (!isSignalKind(kind)) {
        reply.code(400)
        return { error: `kind must be one of: ${VALID_SIGNAL_KINDS.join(', ')}` }
      }
      const body = req.body?.body ?? {}
      if (body !== null && typeof body !== 'object') {
        reply.code(400)
        return { error: 'body must be an object' }
      }
      const signalBody = body as Record<string, unknown>
      if ((kind === 'restart' || kind === 'rerun') && !hasJournalSignalFields(signalBody)) {
        reply.code(400)
        return { error: 'restart/rerun signal body requires hypothesis and fixDescription' }
      }
      const sessionId = req.body?.sessionId
      // If a session is claimed, only the claim holder can write signals (or
      // a request without a sessionId, which represents the UI / a server-
      // driven action — current claim policy doesn't gate the UI).
      const ownership = deps.broker.assertOwnership(req.params.runId, sessionId)
      if (!ownership.ok && ownership.reason === 'session-mismatch') {
        reply.code(409)
        return { reason: 'session-mismatch', currentSession: ownership.currentSession }
      }
      let signal: ReturnType<typeof writeHealSignal>
      try {
        signal = writeHealSignal({
          logsDir: deps.store.logsDir,
          runId: req.params.runId,
          kind,
          body: signalBody,
        })
      } catch (err) {
        reply.code(500)
        return { error: (err as Error).message }
      }
      // Best-effort: bump the cycle counter on the external claim so the UI
      // reflects "n cycles this session" without waiting for the next manifest
      // patch the orchestrator writes.
      deps.broker.bumpCycle(req.params.runId)
      deps.onSignalAccepted?.(req.params.runId, kind, signalBody)
      reply.code(202)
      return { accepted: true, kind, path: signal.path }
    },
  )

  // POST /api/runs/:runId/heal-agent/handoff — switch a run from external
  // heal back to a local mode. For `manual`, this clears the external claim
  // and patches `healMode='manual'`; the orchestrator's signal-wait loop
  // (already running) keeps parking on signal files written by hand.
  // For `auto/claude/codex` the run must be in a restartable terminal state
  // (failed/aborted) because the orchestrator cannot accept a new heal-agent
  // mid-flight — for active external runs the caller must abort + restart
  // with a fresh heal-agent choice instead.
  app.post<{ Params: { runId: string }; Body: HandoffBody }>(
    '/api/runs/:runId/heal-agent/handoff',
    async (req, reply) => {
      const detail = deps.store.get(req.params.runId)
      if (!detail) {
        reply.code(404)
        return { error: 'run not found' }
      }
      const to = req.body?.to
      if (!isHandoffTarget(to)) {
        reply.code(400)
        return { error: `to must be one of: ${VALID_HANDOFF_TARGETS.join(', ')}` }
      }
      const sessionId = req.body?.sessionId
      const ownership = deps.broker.assertOwnership(req.params.runId, sessionId)
      if (!ownership.ok && ownership.reason === 'session-mismatch') {
        reply.code(409)
        return { reason: 'session-mismatch', currentSession: ownership.currentSession }
      }
      const status = detail.manifest.status
      if (to === 'manual') {
        const result = deps.broker.transferTo(req.params.runId, 'manual')
        reply.code(202)
        return { accepted: true, to: 'manual', previousSession: result.previousSession }
      }
      // local heal-agent target — currently only restartable terminal runs
      // can be handed off because the running orchestrator was constructed
      // without an autoHeal config.
      if (isActiveRunStatus(status)) {
        reply.code(409)
        return {
          reason: 'active-run-not-handoff-capable',
          message: 'Active external heal runs cannot hot-swap to a local agent. Abort the run and start a new one with the desired heal agent.',
          status,
        }
      }
      if (!isRestartableRunStatus(status)) {
        reply.code(409)
        return { reason: 'run-not-restartable', status }
      }
      if (!deps.restartLocalHeal) {
        reply.code(409)
        return { reason: 'restart-local-heal-unavailable' }
      }
      // Drop the external claim before kicking off the local restart so the
      // new orchestrator constructs cleanly without a stale broker entry.
      const transferred = deps.broker.transferTo(req.params.runId, 'auto')
      const guidance = typeof req.body?.guidance === 'string' && req.body.guidance.trim().length > 0
        ? req.body.guidance.trim()
        : `Handing off heal from external client to ${to}.`
      const restarted = await deps.restartLocalHeal(req.params.runId, guidance)
      if (!restarted.ok) {
        reply.code(restarted.reason === 'spawn-failed' ? 500 : 409)
        return { reason: restarted.reason, previousSession: transferred.previousSession }
      }
      reply.code(202)
      return { accepted: true, to, previousSession: transferred.previousSession }
    },
  )

  // GET /api/runs/:runId/audit — return the JSONL audit trail of external
  // commands recorded for this run. Empty array when no audit log exists.
  app.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/audit',
    async (req, reply) => {
      const detail = deps.store.get(req.params.runId)
      if (!detail) {
        reply.code(404)
        return { error: 'run not found' }
      }
      const runDir = runDirFor(deps.store.logsDir, req.params.runId)
      const auditPath = path.join(runDir, 'external-commands.jsonl')
      if (!fs.existsSync(auditPath)) return { entries: [] }
      const raw = fs.readFileSync(auditPath, 'utf-8')
      const entries: ExternalHealAuditEntry[] = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try { entries.push(JSON.parse(line) as ExternalHealAuditEntry) } catch { /* skip malformed */ }
      }
      return { entries }
    },
  )

  // GET /api/runs/:runId/actions — which actions are valid right now. Lets
  // the external client reason about what to do without re-deriving server
  // logic. Mirrors `deriveRunActionAvailability` for the run's current status.
  app.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/actions',
    async (req, reply) => {
      const detail = deps.store.get(req.params.runId)
      if (!detail) {
        reply.code(404)
        return { error: 'run not found' }
      }
      const availability = deriveRunActionAvailability(detail.manifest.status, null)
      const isActive = isActiveRunStatus(detail.manifest.status)
      const isTerminal = isTerminalRunStatus(detail.manifest.status)
      const externalSession = deps.broker.getSession(req.params.runId)
      return {
        status: detail.manifest.status,
        availability,
        signal: {
          rerun: isActive,
          restart: isActive,
          heal: isActive,
        },
        evaluationExport: { available: isTerminal },
        externalClaim: externalSession,
      }
    },
  )
}

function isClientKind(value: unknown): value is ExternalHealClientKind {
  return typeof value === 'string' && (VALID_CLIENT_KINDS as string[]).includes(value)
}

function isSessionStatus(value: unknown): value is ExternalHealSessionStatus {
  return typeof value === 'string' && (VALID_STATUS as string[]).includes(value)
}

function isSignalKind(value: unknown): value is HealSignalKind {
  return typeof value === 'string' && (VALID_SIGNAL_KINDS as string[]).includes(value)
}

function isHandoffTarget(value: unknown): value is HealHandoffTarget {
  return typeof value === 'string' && (VALID_HANDOFF_TARGETS as readonly string[]).includes(value)
}

function hasJournalSignalFields(body: Record<string, unknown>): boolean {
  return hasText(body.hypothesis) && hasText(body.fixDescription)
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Convenience factory: the production audit-log writer. Used by server.ts
 *  when constructing the broker. Appends one JSONL entry per command into the
 *  run dir. The file is created lazily on first append. */
export function makeExternalHealAuditLogger(logsDir: string) {
  return (runId: string, entry: ExternalHealAuditEntry): void => {
    try {
      const runDir = runDirFor(logsDir, runId)
      fs.mkdirSync(runDir, { recursive: true })
      fs.appendFileSync(
        path.join(runDir, 'external-commands.jsonl'),
        JSON.stringify(entry) + '\n',
      )
    } catch {
      // Best-effort; never let audit failures break the request.
    }
  }
}
