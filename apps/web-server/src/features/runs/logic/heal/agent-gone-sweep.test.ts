import { describe, expect, it, vi } from 'vitest'
import { EXTERNAL_AGENT_GONE_MS } from '../../../../../../../shared/run-state'
import { sweepGoneHealAgents, type SweepRunner } from './agent-gone-sweep'

const NOW = Date.parse('2026-11-14T07:13:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

function setup(lastHeartbeatAt: string, orch: Partial<SweepRunner> | undefined) {
  const broker = { listClaims: () => [{ runId: 'run-1', session: { sessionId: 's', clientKind: 'claude' as const, status: 'disconnected' as const, lastHeartbeatAt, claimedAt: ago(0), cycleCount: 1 } }] }
  const registry = { get: vi.fn(() => orch as SweepRunner | undefined) }
  return { broker, registry }
}

describe('sweepGoneHealAgents', () => {
  // Evidence: run 0523-2ukz went stale at 05:35 and sat in "Waiting for heal
  // signal" until a human stopped it at 07:13 — nothing ever ended it.
  it('ends the heal of a run whose claimed agent has been silent past the gone window', async () => {
    const orch = { isWaitingForHealSignal: () => true, cancelHeal: vi.fn(async () => ({ ok: true as const })) }
    const lastHeartbeatAt = ago(EXTERNAL_AGENT_GONE_MS + 1)
    const { broker, registry } = setup(lastHeartbeatAt, orch)

    expect(await sweepGoneHealAgents(broker, registry, NOW)).toEqual(['run-1'])
    expect(orch.cancelHeal).toHaveBeenCalledWith({ kind: 'agent-disconnected', client: 'Claude', lastHeartbeatAt })
  })

  it('leaves a run alone inside the reconnect grace', async () => {
    const orch = { isWaitingForHealSignal: () => true, cancelHeal: vi.fn() }
    const { broker, registry } = setup(ago(EXTERNAL_AGENT_GONE_MS - 1), orch)

    expect(await sweepGoneHealAgents(broker, registry, NOW)).toEqual([])
    expect(orch.cancelHeal).not.toHaveBeenCalled()
  })

  it('never ends a run that is not parked on the agent signal, or has no live runner', async () => {
    const rerunning = { isWaitingForHealSignal: () => false, cancelHeal: vi.fn() }
    const old = ago(EXTERNAL_AGENT_GONE_MS * 2)
    expect(await sweepGoneHealAgents(setup(old, rerunning).broker, setup(old, rerunning).registry, NOW)).toEqual([])
    expect(rerunning.cancelHeal).not.toHaveBeenCalled()
    expect(await sweepGoneHealAgents(setup(old, undefined).broker, setup(old, undefined).registry, NOW)).toEqual([])
  })

  it('does not report a run whose heal had already left the loop', async () => {
    const orch = { isWaitingForHealSignal: () => true, cancelHeal: vi.fn(async () => ({ ok: false as const, reason: 'not-healing' as const })) }
    const { broker, registry } = setup(ago(EXTERNAL_AGENT_GONE_MS + 1), orch)
    expect(await sweepGoneHealAgents(broker, registry, NOW)).toEqual([])
  })

  it('skips a claim whose heartbeat stamp cannot be read', async () => {
    const orch = { isWaitingForHealSignal: () => true, cancelHeal: vi.fn() }
    const { broker, registry } = setup('not-a-date', orch)
    expect(await sweepGoneHealAgents(broker, registry, NOW)).toEqual([])
    expect(registry.get).not.toHaveBeenCalled()
  })
})
