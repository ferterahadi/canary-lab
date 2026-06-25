import type {
  ExternalHealSession,
  ExternalHealSessionStatus,
  RunManifest,
} from '../runtime/manifest'
import type { RunStoreEvent } from '../run-store'
import { HEARTBEAT_STALE_MS } from '../../../../../../../shared/run-state'
import type { ClientKind } from '../../../../../../../shared/run-mode'
import { isHealClaimAllowed } from './heal-claim-policy'

// `ExternalHealBroker` owns the in-memory state for which external AI client
// (Claude Desktop, Codex CLI, etc.) currently holds heal duty for each run.
// It mirrors what's persisted in `RunManifest.externalHealSession` and
// publishes `external-claim-changed` / `external-heal-task` events through
// `RunStore` so every UI tab + MCP subscriber stays in sync.
//
// Design notes:
//   - One claim per runId. Reclaiming with the same `sessionId` is idempotent
//     (reconnect). A different `sessionId` is rejected with `already-claimed`
//     — v1 does not support force-takeover.
//   - Heartbeats update the in-memory record but intentionally do NOT emit on
//     every tick; only status transitions (e.g. connected → disconnected) do.
//   - The broker is pure: time is injected via `deps.now()` so tests can drive
//     stale-detection deterministically. File I/O (manifest writes, audit
//     log) goes through `deps.patchManifest` and `deps.audit` callbacks.

export interface ExternalHealBrokerDeps {
  now(): number
  emit(event: RunStoreEvent): void
  patchManifest(
    runId: string,
    patch: Partial<Pick<RunManifest, 'externalHealSession' | 'healMode'>>,
  ): void
  audit(runId: string, entry: ExternalHealAuditEntry): void
  // Policy gate: which client kinds may own a heal claim. Injectable for
  // tests; defaults to the env-aware module policy (desktops-only).
  isClaimAllowed?(clientKind: ClientKind): boolean
}

export interface ExternalHealAuditEntry {
  ts: string
  sessionId: string | null
  clientKind: ClientKind | null
  action: string
  args?: Record<string, unknown>
  result?: Record<string, unknown>
}

export interface ClaimInput {
  sessionId: string
  clientKind: ClientKind
  clientVersion?: string
  conversationName?: string
}

export type ClaimResult =
  | { accepted: true; session: ExternalHealSession }
  | { accepted: false; reason: 'already-claimed'; currentSession: ExternalHealSession }
  | { accepted: false; reason: 'client-kind-not-allowed'; clientKind: ClientKind }

export type OwnershipResult =
  | { ok: true }
  | { ok: false; reason: 'no-claim' | 'session-mismatch'; currentSession?: ExternalHealSession }

export type HeartbeatResult =
  | { ok: true; session: ExternalHealSession }
  | { ok: false; reason: 'no-claim' | 'session-mismatch' }

export class ExternalHealBroker {
  private readonly sessions = new Map<string, ExternalHealSession>()

  constructor(private readonly deps: ExternalHealBrokerDeps) {}

  /** Snapshot of the current session for a run, or null if no external claim. */
  getSession(runId: string): ExternalHealSession | null {
    return this.sessions.get(runId) ?? null
  }

  /** Register an external client as the heal agent for this run. Idempotent
   *  when the same `sessionId` reclaims (reconnect path). A different
   *  `sessionId` is rejected — v1 has no force-takeover. */
  claim(runId: string, input: ClaimInput): ClaimResult {
    const existing = this.sessions.get(runId)
    const nowIso = new Date(this.deps.now()).toISOString()

    // Policy backstop: only allowlisted client kinds (desktops) may own a
    // heal claim. CLI / undetected ('other') clients are rejected here — the
    // single chokepoint for every broker-routed claim path (claim_heal tool,
    // REST /claim, reclaim helper, claimRun reuse).
    const claimAllowed = this.deps.isClaimAllowed ?? isHealClaimAllowed
    if (!claimAllowed(input.clientKind)) {
      this.deps.audit(runId, {
        ts: nowIso,
        sessionId: input.sessionId,
        clientKind: input.clientKind,
        action: 'claim-rejected',
        args: { reason: 'client-kind-not-allowed' },
      })
      return { accepted: false, reason: 'client-kind-not-allowed', clientKind: input.clientKind }
    }

    if (existing && existing.sessionId !== input.sessionId) {
      this.deps.audit(runId, {
        ts: nowIso,
        sessionId: input.sessionId,
        clientKind: input.clientKind,
        action: 'claim-rejected',
        args: { reason: 'already-claimed', currentSessionId: existing.sessionId },
      })
      return { accepted: false, reason: 'already-claimed', currentSession: existing }
    }

    const session: ExternalHealSession = existing
      ? {
          ...existing,
          clientKind: existing.clientKind === 'other' && input.clientKind !== 'other'
            ? input.clientKind
            : existing.clientKind,
          // Reconnect: refresh heartbeat + connection status, preserve cycle count.
          lastHeartbeatAt: nowIso,
          status: 'connected',
          // Allow optional metadata to be updated on reconnect.
          ...(input.conversationName !== undefined
            ? { conversationName: input.conversationName }
            : {}),
          ...(input.clientVersion !== undefined
            ? { clientVersion: input.clientVersion }
            : {}),
        }
      : {
          sessionId: input.sessionId,
          clientKind: input.clientKind,
          ...(input.clientVersion !== undefined ? { clientVersion: input.clientVersion } : {}),
          ...(input.conversationName !== undefined
            ? { conversationName: input.conversationName }
            : {}),
          claimedAt: nowIso,
          lastHeartbeatAt: nowIso,
          status: 'connected',
          cycleCount: 0,
        }

    this.sessions.set(runId, session)
    this.deps.patchManifest(runId, {
      externalHealSession: session,
      healMode: 'external',
    })
    this.deps.emit({ kind: 'external-claim-changed', runId })
    this.deps.audit(runId, {
      ts: nowIso,
      sessionId: input.sessionId,
      clientKind: input.clientKind,
      action: existing ? 'claim-reconnect' : 'claim',
      args: input.conversationName ? { conversationName: input.conversationName } : undefined,
    })
    return { accepted: true, session }
  }

  /** Drop the claim if the sessionId matches the current holder. Returns
   *  `{ released: false }` when there's no claim or the sessionId mismatches. */
  release(runId: string, sessionId: string): { released: boolean } {
    const existing = this.sessions.get(runId)
    if (!existing) return { released: false }
    if (existing.sessionId !== sessionId) return { released: false }

    this.sessions.delete(runId)
    this.deps.patchManifest(runId, { externalHealSession: undefined })
    this.deps.emit({ kind: 'external-claim-changed', runId })
    this.deps.audit(runId, {
      ts: new Date(this.deps.now()).toISOString(),
      sessionId,
      clientKind: existing.clientKind,
      action: 'release',
    })
    return { released: true }
  }

  /** Server-driven release for the handoff endpoint: drop the claim and flip
   *  `healMode` to the new mode in one patch. Unlike `release`, this does not
   *  require a sessionId match — the route layer enforces ownership before
   *  calling this. Audited as `handoff` with the target mode in args. */
  transferTo(runId: string, toMode: 'auto' | 'manual'): { transferred: boolean; previousSession: ExternalHealSession | null } {
    const existing = this.sessions.get(runId) ?? null
    if (existing) this.sessions.delete(runId)
    this.deps.patchManifest(runId, { externalHealSession: undefined, healMode: toMode })
    this.deps.emit({ kind: 'external-claim-changed', runId })
    this.deps.audit(runId, {
      ts: new Date(this.deps.now()).toISOString(),
      sessionId: existing?.sessionId ?? null,
      clientKind: existing?.clientKind ?? null,
      action: 'handoff',
      args: { to: toMode },
    })
    return { transferred: true, previousSession: existing }
  }

  /** Update heartbeat + status on the active session. Does not emit unless the
   *  connection status actually transitions (e.g. disconnected → connected). */
  heartbeat(
    runId: string,
    sessionId: string,
    status: ExternalHealSessionStatus,
  ): HeartbeatResult {
    const existing = this.sessions.get(runId)
    if (!existing) return { ok: false, reason: 'no-claim' }
    if (existing.sessionId !== sessionId) return { ok: false, reason: 'session-mismatch' }

    const wasDisconnected = existing.status === 'disconnected'
    const becameDisconnected = status === 'disconnected'
    const next: ExternalHealSession = {
      ...existing,
      lastHeartbeatAt: new Date(this.deps.now()).toISOString(),
      status,
    }
    this.sessions.set(runId, next)
    this.deps.patchManifest(runId, { externalHealSession: next })

    if (wasDisconnected !== becameDisconnected) {
      this.deps.emit({ kind: 'external-claim-changed', runId })
    }
    return { ok: true, session: next }
  }

  /** Refresh `lastHeartbeatAt` for any MCP call from the claim holder.
   *  Distinct from `heartbeat()` in that it does not require the caller to
   *  declare a status — it just proves liveness. If the watchdog had already
   *  marked the session disconnected, revive it as `healing` since the agent
   *  obviously isn't gone (it's calling us). */
  touch(runId: string, sessionId: string): HeartbeatResult {
    const existing = this.sessions.get(runId)
    if (!existing) return { ok: false, reason: 'no-claim' }
    if (existing.sessionId !== sessionId) return { ok: false, reason: 'session-mismatch' }

    const wasDisconnected = existing.status === 'disconnected'
    const next: ExternalHealSession = {
      ...existing,
      lastHeartbeatAt: new Date(this.deps.now()).toISOString(),
      ...(wasDisconnected ? { status: 'healing' as const } : {}),
    }
    this.sessions.set(runId, next)
    this.deps.patchManifest(runId, { externalHealSession: next })
    if (wasDisconnected) {
      this.deps.emit({ kind: 'external-claim-changed', runId })
    }
    return { ok: true, session: next }
  }

  /** Increment the cycle counter on the active session. No-op when no claim. */
  bumpCycle(runId: string): void {
    const existing = this.sessions.get(runId)
    if (!existing) return
    const next: ExternalHealSession = { ...existing, cycleCount: existing.cycleCount + 1 }
    this.sessions.set(runId, next)
    this.deps.patchManifest(runId, { externalHealSession: next })
  }

  /** Sweep all claims and mark stale ones as disconnected. Returns the list
   *  of runIds whose status transitioned. Intended to be called by a periodic
   *  watchdog in the orchestrator. */
  markStaleClaims(): string[] {
    const transitioned: string[] = []
    const nowMs = this.deps.now()
    for (const [runId, session] of this.sessions) {
      if (session.status === 'disconnected') continue
      const last = Date.parse(session.lastHeartbeatAt)
      if (!Number.isFinite(last)) continue
      if (nowMs - last <= HEARTBEAT_STALE_MS) continue
      const next: ExternalHealSession = { ...session, status: 'disconnected' }
      this.sessions.set(runId, next)
      this.deps.patchManifest(runId, { externalHealSession: next })
      this.deps.emit({ kind: 'external-claim-changed', runId })
      this.deps.audit(runId, {
        ts: new Date(nowMs).toISOString(),
        sessionId: session.sessionId,
        clientKind: session.clientKind,
        action: 'stale-disconnect',
      })
      transitioned.push(runId)
    }
    return transitioned
  }

  /** Returns ok=true if the caller's sessionId matches the current claim or
   *  the caller is not asserting ownership (no sessionId provided). Routes
   *  that allow either an external claim holder or a server-driven action
   *  (e.g. the UI itself) layer their own checks on top. */
  assertOwnership(runId: string, sessionId: string | undefined): OwnershipResult {
    if (!sessionId) return { ok: true }
    const existing = this.sessions.get(runId)
    if (!existing) return { ok: false, reason: 'no-claim' }
    if (existing.sessionId !== sessionId) {
      return { ok: false, reason: 'session-mismatch', currentSession: existing }
    }
    return { ok: true }
  }

  /** For boot recovery: rehydrate from persisted manifests. Used when the
   *  server restarts and finds runs with an `externalHealSession` already on
   *  disk — the broker reclaims that state so subsequent heartbeats / signals
   *  match. The rehydrated session is immediately a candidate for staleness
   *  on the next sweep. */
  rehydrate(runId: string, session: ExternalHealSession): void {
    this.sessions.set(runId, session)
  }

  /** Test/diagnostic introspection. */
  listClaims(): Array<{ runId: string; session: ExternalHealSession }> {
    return [...this.sessions.entries()].map(([runId, session]) => ({ runId, session }))
  }
}
