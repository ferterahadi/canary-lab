import { describe, it, expect, beforeEach } from 'vitest'
import { ExternalHealBroker, type ExternalHealBrokerDeps } from './external-heal-broker'
import type { ExternalHealSession } from '../../orchestration/logic/runtime/manifest'
import type { RunStoreEvent } from '../../orchestration/logic/run-store'

interface Captured {
  events: RunStoreEvent[]
  manifestPatches: Array<{ runId: string; externalHealSession?: ExternalHealSession; healMode?: string }>
  audit: Array<{ runId: string; entry: Record<string, unknown> }>
}

function makeDeps(now = () => new Date('2026-05-18T10:00:00.000Z').getTime()): {
  deps: ExternalHealBrokerDeps
  captured: Captured
} {
  const captured: Captured = { events: [], manifestPatches: [], audit: [] }
  const deps: ExternalHealBrokerDeps = {
    now,
    emit: (e) => { captured.events.push(e) },
    patchManifest: (runId, patch) => {
      captured.manifestPatches.push({
        runId,
        ...(patch.externalHealSession !== undefined ? { externalHealSession: patch.externalHealSession } : {}),
        ...(patch.healMode !== undefined ? { healMode: patch.healMode } : {}),
      })
    },
    audit: (runId, entry) => { captured.audit.push({ runId, entry }) },
    // Existing tests exercise claim *mechanics* across client kinds; allow all
    // so the desktop-only policy doesn't interfere. Policy enforcement has its
    // own dedicated describe block below.
    isClaimAllowed: () => true,
  }
  return { deps, captured }
}

describe('ExternalHealBroker.claim', () => {
  let now: number

  beforeEach(() => { now = new Date('2026-05-18T10:00:00.000Z').getTime() })

  it('accepts a first claim on a run with no current claim', () => {
    const { deps, captured } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    const res = broker.claim('run-1', {
      sessionId: 'sess-A',
      clientKind: 'claude-desktop',
      conversationName: 'fix checkout',
    })
    expect(res.accepted).toBe(true)
    if (!res.accepted) throw new Error('unreachable')
    expect(res.session.sessionId).toBe('sess-A')
    expect(res.session.clientKind).toBe('claude-desktop')
    expect(res.session.status).toBe('connected')
    expect(res.session.cycleCount).toBe(0)
    expect(res.session.claimedAt).toBe('2026-05-18T10:00:00.000Z')
    expect(res.session.lastHeartbeatAt).toBe('2026-05-18T10:00:00.000Z')
    expect(captured.manifestPatches).toHaveLength(1)
    expect(captured.manifestPatches[0].healMode).toBe('external')
    expect(captured.events.map((e) => e.kind)).toContain('external-claim-changed')
    expect(captured.audit).toHaveLength(1)
    expect(captured.audit[0].entry.action).toBe('claim')
  })

  it('is idempotent when the same sessionId reclaims', () => {
    const { deps, captured } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    captured.events.length = 0
    captured.audit.length = 0
    now = new Date('2026-05-18T10:00:05.000Z').getTime()
    const res = broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    expect(res.accepted).toBe(true)
    if (!res.accepted) throw new Error('unreachable')
    expect(res.session.sessionId).toBe('sess-A')
    expect(res.session.lastHeartbeatAt).toBe('2026-05-18T10:00:05.000Z')
    expect(res.session.status).toBe('connected')
    expect(captured.audit[0]?.entry.action).toBe('claim-reconnect')
  })

  it('updates optional metadata when the same session reconnects', () => {
    const { deps } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })

    const res = broker.claim('run-1', {
      sessionId: 'sess-A',
      clientKind: 'claude-desktop',
      clientVersion: '2.0.0',
      conversationName: 'new tab',
    })

    expect(res.accepted).toBe(true)
    if (!res.accepted) throw new Error('unreachable')
    expect(res.session).toMatchObject({
      sessionId: 'sess-A',
      clientVersion: '2.0.0',
      conversationName: 'new tab',
    })
  })

  it('upgrades an existing generic claim when the same session later identifies the client', () => {
    const { deps } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'other' })

    const res = broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })

    expect(res.accepted).toBe(true)
    if (!res.accepted) throw new Error('unreachable')
    expect(res.session.clientKind).toBe('claude-desktop')
  })

  it('rejects a different sessionId with 409 already-claimed', () => {
    const { deps, captured } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop', conversationName: 'first' })
    const res = broker.claim('run-1', { sessionId: 'sess-B', clientKind: 'codex-cli' })
    expect(res.accepted).toBe(false)
    if (res.accepted) throw new Error('unreachable')
    expect(res.reason).toBe('already-claimed')
    expect(res.currentSession.sessionId).toBe('sess-A')
    expect(captured.audit.some((a) => a.entry.action === 'claim-rejected')).toBe(true)
  })

  it('allows a fresh claim after release', () => {
    const { deps } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    broker.release('run-1', 'sess-A')
    const res = broker.claim('run-1', { sessionId: 'sess-B', clientKind: 'codex-cli' })
    expect(res.accepted).toBe(true)
  })
})

describe('ExternalHealBroker.release', () => {
  it('clears the claim when sessionId matches', () => {
    const { deps, captured } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    captured.events.length = 0
    const res = broker.release('run-1', 'sess-A')
    expect(res.released).toBe(true)
    expect(broker.getSession('run-1')).toBeNull()
    expect(captured.events.map((e) => e.kind)).toContain('external-claim-changed')
    // Manifest gets patched to clear externalHealSession.
    const lastPatch = captured.manifestPatches[captured.manifestPatches.length - 1]
    expect(lastPatch.externalHealSession).toBeUndefined()
  })

  it('no-ops when sessionId does not match', () => {
    const { deps, captured } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    captured.events.length = 0
    const res = broker.release('run-1', 'sess-B')
    expect(res.released).toBe(false)
    expect(broker.getSession('run-1')?.sessionId).toBe('sess-A')
    expect(captured.events).toHaveLength(0)
  })

  it('no-ops when there is no current claim', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    const res = broker.release('run-1', 'sess-A')
    expect(res.released).toBe(false)
  })
})

describe('ExternalHealBroker.heartbeat', () => {
  it('updates lastHeartbeatAt and status', () => {
    let now = new Date('2026-05-18T10:00:00.000Z').getTime()
    const { deps, captured } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })

    now = new Date('2026-05-18T10:00:07.000Z').getTime()
    const res = broker.heartbeat('run-1', 'sess-A', 'healing')
    expect(res.ok).toBe(true)
    const session = broker.getSession('run-1')
    expect(session?.lastHeartbeatAt).toBe('2026-05-18T10:00:07.000Z')
    expect(session?.status).toBe('healing')
    // Heartbeats should not flood subscribers: no claim-changed event emitted.
    const heartbeatEvents = captured.events.filter(
      (e) => e.kind === 'external-claim-changed',
    )
    // One from the initial claim is expected, but no extra one for the heartbeat.
    expect(heartbeatEvents).toHaveLength(1)
  })

  it('emits a claim-changed event when status transitions to/from disconnected', () => {
    let now = new Date('2026-05-18T10:00:00.000Z').getTime()
    const { deps, captured } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    captured.events.length = 0

    // Mark stale → status flips to 'disconnected', should emit.
    now = new Date('2026-05-18T10:11:00.000Z').getTime()
    broker.markStaleClaims()
    expect(captured.events.some((e) => e.kind === 'external-claim-changed')).toBe(true)
    captured.events.length = 0

    // Heartbeat brings it back → status flips to 'connected', should emit.
    const res = broker.heartbeat('run-1', 'sess-A', 'connected')
    expect(res.ok).toBe(true)
    expect(captured.events.some((e) => e.kind === 'external-claim-changed')).toBe(true)
  })

  it('rejects heartbeat with wrong sessionId', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    const res = broker.heartbeat('run-1', 'sess-B', 'connected')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('session-mismatch')
  })

  it('rejects heartbeat when no claim exists', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    const res = broker.heartbeat('run-1', 'sess-A', 'connected')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('no-claim')
  })
})

describe('ExternalHealBroker.touch', () => {
  it('refreshes lastHeartbeatAt without changing status when alive', () => {
    let now = new Date('2026-05-18T10:00:00.000Z').getTime()
    const { deps, captured } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    broker.heartbeat('run-1', 'sess-A', 'healing')
    captured.events.length = 0

    now = new Date('2026-05-18T10:00:10.000Z').getTime()
    const res = broker.touch('run-1', 'sess-A')
    expect(res.ok).toBe(true)
    const session = broker.getSession('run-1')
    expect(session?.lastHeartbeatAt).toBe('2026-05-18T10:00:10.000Z')
    expect(session?.status).toBe('healing')
    expect(captured.events).toHaveLength(0)
  })

  it('revives a disconnected session as healing and emits a claim-changed event', () => {
    let now = new Date('2026-05-18T10:00:00.000Z').getTime()
    const { deps, captured } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })

    now = new Date('2026-05-18T10:11:00.000Z').getTime()
    broker.markStaleClaims()
    expect(broker.getSession('run-1')?.status).toBe('disconnected')
    captured.events.length = 0

    now = new Date('2026-05-18T10:11:05.000Z').getTime()
    const res = broker.touch('run-1', 'sess-A')
    expect(res.ok).toBe(true)
    const session = broker.getSession('run-1')
    expect(session?.status).toBe('healing')
    expect(session?.lastHeartbeatAt).toBe('2026-05-18T10:11:05.000Z')
    expect(captured.events.some((e) => e.kind === 'external-claim-changed')).toBe(true)
  })

  it('rejects with session-mismatch when sessionId differs', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    const res = broker.touch('run-1', 'sess-B')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('session-mismatch')
  })

  it('rejects with no-claim when no session exists', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    const res = broker.touch('run-1', 'sess-A')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('no-claim')
  })
})

describe('ExternalHealBroker.markStaleClaims', () => {
  it('flips status to disconnected when heartbeat is older than HEARTBEAT_STALE_MS', () => {
    let now = new Date('2026-05-18T10:00:00.000Z').getTime()
    const { deps } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })

    now = new Date('2026-05-18T10:09:59.000Z').getTime() // just under 10min, still fresh
    const fresh = broker.markStaleClaims()
    expect(fresh).toEqual([])
    expect(broker.getSession('run-1')?.status).toBe('connected')

    now = new Date('2026-05-18T10:10:01.000Z').getTime() // just over 10min, stale
    const stale = broker.markStaleClaims()
    expect(stale).toEqual(['run-1'])
    expect(broker.getSession('run-1')?.status).toBe('disconnected')
  })

  it('does not re-emit when already disconnected', () => {
    let now = new Date('2026-05-18T10:00:00.000Z').getTime()
    const { deps, captured } = makeDeps(() => now)
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })

    now = new Date('2026-05-18T10:11:00.000Z').getTime()
    broker.markStaleClaims()
    captured.events.length = 0
    captured.manifestPatches.length = 0

    // Second sweep — already disconnected, should be a no-op.
    now = new Date('2026-05-18T10:12:00.000Z').getTime()
    const stale = broker.markStaleClaims()
    expect(stale).toEqual([])
    expect(captured.events).toHaveLength(0)
    expect(captured.manifestPatches).toHaveLength(0)
  })

  it('ignores sessions with unreadable heartbeat timestamps', () => {
    const { deps, captured } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    broker.rehydrate('run-1', {
      sessionId: 'sess-A',
      clientKind: 'codex-cli',
      claimedAt: '2026-05-18T10:00:00.000Z',
      lastHeartbeatAt: 'not-a-date',
      status: 'connected',
      cycleCount: 0,
    })

    const stale = broker.markStaleClaims()

    expect(stale).toEqual([])
    expect(broker.getSession('run-1')?.status).toBe('connected')
    expect(captured.events).toHaveLength(0)
    expect(captured.manifestPatches).toHaveLength(0)
  })
})

describe('ExternalHealBroker.bumpCycle', () => {
  it('increments the cycleCount on the active session', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    expect(broker.getSession('run-1')?.cycleCount).toBe(0)
    broker.bumpCycle('run-1')
    expect(broker.getSession('run-1')?.cycleCount).toBe(1)
    broker.bumpCycle('run-1')
    expect(broker.getSession('run-1')?.cycleCount).toBe(2)
  })

  it('is a no-op when no claim exists', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    expect(() => broker.bumpCycle('run-1')).not.toThrow()
  })
})

describe('ExternalHealBroker.assertOwnership', () => {
  it('passes when the sessionId matches the current claim', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    expect(broker.assertOwnership('run-1', 'sess-A').ok).toBe(true)
  })

  it('fails with session-mismatch when sessionId differs', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    const res = broker.assertOwnership('run-1', 'sess-B')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('session-mismatch')
  })

  it('fails with no-claim when nothing claimed', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    const res = broker.assertOwnership('run-1', 'sess-A')
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('no-claim')
  })

  it('passes a no-claim ownership check when sessionId is absent (server-driven action)', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    // An action with no sessionId is treated as "not asserting ownership" —
    // e.g. the UI hitting the same endpoint without belonging to an external
    // session. Routes are free to layer their own checks on top.
    expect(broker.assertOwnership('run-1', undefined).ok).toBe(true)
  })
})

describe('ExternalHealBroker.transferTo', () => {
  it('releases the active claim and patches healMode in one go', () => {
    const { deps, captured } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude-desktop' })
    captured.manifestPatches.length = 0
    captured.events.length = 0
    captured.audit.length = 0

    const res = broker.transferTo('run-1', 'manual')

    expect(res.transferred).toBe(true)
    expect(res.previousSession?.sessionId).toBe('sess-A')
    expect(broker.getSession('run-1')).toBeNull()
    expect(captured.manifestPatches).toEqual([
      { runId: 'run-1', externalHealSession: undefined, healMode: 'manual' },
    ])
    expect(captured.events.map((e) => e.kind)).toEqual(['external-claim-changed'])
    expect(captured.audit).toHaveLength(1)
    expect(captured.audit[0].entry).toMatchObject({
      action: 'handoff',
      args: { to: 'manual' },
      sessionId: 'sess-A',
      clientKind: 'claude-desktop',
    })
  })

  it('still patches healMode when there is no active claim', () => {
    const { deps, captured } = makeDeps()
    const broker = new ExternalHealBroker(deps)

    const res = broker.transferTo('run-1', 'auto')

    expect(res.transferred).toBe(true)
    expect(res.previousSession).toBeNull()
    expect(captured.manifestPatches).toEqual([
      { runId: 'run-1', externalHealSession: undefined, healMode: 'auto' },
    ])
    expect(captured.audit[0].entry).toMatchObject({
      action: 'handoff',
      args: { to: 'auto' },
      sessionId: null,
      clientKind: null,
    })
  })
})

describe('ExternalHealBroker.rehydrate and listClaims', () => {
  it('rehydrates persisted sessions and exposes the current claim list', () => {
    const { deps } = makeDeps()
    const broker = new ExternalHealBroker(deps)
    const session: ExternalHealSession = {
      sessionId: 'sess-A',
      clientKind: 'codex-desktop',
      clientVersion: '1.0.0',
      conversationName: 'resume checkout',
      claimedAt: '2026-05-18T09:00:00.000Z',
      lastHeartbeatAt: '2026-05-18T09:00:10.000Z',
      status: 'waiting',
      cycleCount: 2,
    }

    broker.rehydrate('run-1', session)

    expect(broker.getSession('run-1')).toEqual(session)
    expect(broker.listClaims()).toEqual([{ runId: 'run-1', session }])
  })
})

describe('ExternalHealBroker.claim — client-kind policy', () => {
  // Build deps that defer to the real (default) desktop-only policy by NOT
  // overriding isClaimAllowed.
  function makePolicyDeps() {
    const captured: Captured = { events: [], manifestPatches: [], audit: [] }
    const deps: ExternalHealBrokerDeps = {
      now: () => new Date('2026-05-18T10:00:00.000Z').getTime(),
      emit: (e) => { captured.events.push(e) },
      patchManifest: (runId, patch) => { captured.manifestPatches.push({ runId, ...patch }) },
      audit: (runId, entry) => { captured.audit.push({ runId, entry }) },
      isClaimAllowed: (kind) => kind === 'claude-desktop' || kind === 'codex-desktop',
    }
    return { deps, captured }
  }

  it.each(['claude-cli', 'codex-cli', 'other'] as const)(
    'rejects a claim from %s with client-kind-not-allowed and writes no session',
    (kind) => {
      const { deps, captured } = makePolicyDeps()
      const broker = new ExternalHealBroker(deps)
      const res = broker.claim('run-1', { sessionId: 'sess-A', clientKind: kind })
      expect(res.accepted).toBe(false)
      if (res.accepted) throw new Error('unreachable')
      expect(res.reason).toBe('client-kind-not-allowed')
      // No session stored, no manifest patch, no claim-changed event — only an
      // audit of the rejection.
      expect(broker.getSession('run-1')).toBeNull()
      expect(captured.manifestPatches).toHaveLength(0)
      expect(captured.events).toHaveLength(0)
      expect(captured.audit).toHaveLength(1)
      expect(captured.audit[0].entry.action).toBe('claim-rejected')
      expect((captured.audit[0].entry.args as { reason: string }).reason).toBe('client-kind-not-allowed')
    },
  )

  it.each(['claude-desktop', 'codex-desktop'] as const)(
    'accepts a claim from desktop client %s',
    (kind) => {
      const { deps } = makePolicyDeps()
      const broker = new ExternalHealBroker(deps)
      const res = broker.claim('run-1', { sessionId: 'sess-A', clientKind: kind })
      expect(res.accepted).toBe(true)
      expect(broker.getSession('run-1')?.clientKind).toBe(kind)
    },
  )
})
