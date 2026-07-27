import { describe, it, expect, beforeEach } from 'vitest'
import { ExternalHealBroker, type ExternalHealBrokerDeps, type ExternalHealAuditEntry } from './external-heal-broker'
import type { ExternalHealSession } from '../runtime/manifest'
import type { RunStoreEvent } from '../run-store'

interface Captured {
  events: RunStoreEvent[]
  manifestPatches: Array<{ runId: string; externalHealSession?: ExternalHealSession; healMode?: string }>
  audit: Array<{ runId: string; entry: ExternalHealAuditEntry }>
}

describe('ExternalHealBroker.claim — client-kind policy', () => {
  // Build deps that defer to the real (default) denylist policy by NOT
  // overriding isClaimAllowed.
  function makePolicyDeps() {
    const captured: Captured = { events: [], manifestPatches: [], audit: [] }
    const deps: ExternalHealBrokerDeps = {
      now: () => new Date('2026-05-18T10:00:00.000Z').getTime(),
      emit: (e) => { captured.events.push(e) },
      patchManifest: (runId, patch) => { captured.manifestPatches.push({ runId, ...patch }) },
      audit: (runId, entry) => { captured.audit.push({ runId, entry }) },
      isClaimAllowed: (kind) => kind !== 'claude-pty' && kind !== 'codex-pty',
    }
    return { deps, captured }
  }

  it.each(['claude-pty', 'codex-pty'] as const)(
    'rejects a claim from runner PTY agent %s with client-kind-not-allowed and writes no session',
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

  it.each(['claude', 'codex', 'other'] as const)(
    'accepts a claim from interactive client %s',
    (kind) => {
      const { deps } = makePolicyDeps()
      const broker = new ExternalHealBroker(deps)
      const res = broker.claim('run-1', { sessionId: 'sess-A', clientKind: kind })
      expect(res.accepted).toBe(true)
      expect(broker.getSession('run-1')?.clientKind).toBe(kind)
    },
  )
})
