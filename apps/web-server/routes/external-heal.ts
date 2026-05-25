import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import type { RunStore } from '../lib/run-store'
import {
  ExternalHealBroker,
  type ClaimInput,
  type ExternalHealAuditEntry,
} from '../lib/external-heal-broker'
import type {
  ExternalHealClientKind,
  ExternalHealSessionStatus,
} from '../lib/runtime/manifest'
import { buildExternalHealContext, writeHealSignal } from '../lib/external-heal-surface'
import { runDirFor } from '../lib/runtime/run-paths'
import {
  isActiveRunStatus,
  isTerminalRunStatus,
  deriveRunActionAvailability,
  type HealSignalKind,
} from '../../../shared/run-state'

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

export interface ExternalHealRouteDeps {
  store: RunStore
  broker: ExternalHealBroker
  /** Optional hook so MCP / WS layers can react synchronously when a signal is
   *  accepted. The orchestrator picks signals up by polling the file system,
   *  but other consumers may want to broadcast immediately. */
  onSignalAccepted?(runId: string, kind: HealSignalKind, body: Record<string, unknown>): void
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

  // GET /api/runs/:runId/heal-context — one-shot bundle for the external client
  // to feed its agent. Reads from existing on-disk artifacts so the orchestrator
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
