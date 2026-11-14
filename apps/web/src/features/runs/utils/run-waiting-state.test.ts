import { describe, expect, it } from 'vitest'
import type { RunDetail } from '@shared/run-detail'
import type { RunManifest } from '@shared/run-manifest'
import fixture from './__fixtures__/run-snapshot-review.json'
import { runAgentTurn, runWaitingState } from './run-waiting-state'
import { shortTime } from '@/shared/lib/format'
import { EXTERNAL_AGENT_GONE_MS } from '@shared/run-state'
import { deriveRunViewModel } from './run-view-model'

const recorded: RunDetail = { runId: fixture.manifest.runId, manifest: fixture.manifest as RunManifest, summary: fixture.summary }
const detail = (patch: Partial<RunManifest>): RunDetail => ({ ...recorded, manifest: { ...recorded.manifest, ...patch } })

describe('runWaitingState', () => {
  it('reports the recorded heal wait as awaiting review while keeping actions and verdicts intact', () => {
    const vm = deriveRunViewModel(recorded)
    expect(vm.waiting?.label).toBe('Awaiting test review')
    expect(vm.headline).toBe('Awaiting test review')
    expect(vm.subtext).toContain('adopt or restore')
    expect(vm.actions.cancelHeal.enabled).toBe(true)
    expect(vm.displayStatus).toBe('healing')
    expect(recorded.summary?.passed).toBe(77)
    expect(deriveRunViewModel(recorded, 'cancelling-heal').waiting).toBeUndefined()
  })
  it('has an index fallback before detail hydration, and does not relabel terminal/running runs', () => {
    expect(runWaitingState({ runId: 'r', feature: 'f', status: 'healing', startedAt: '', pendingSpecEdits: 1 })?.label).toBe('Awaiting test review')
    expect(runWaitingState({ runId: 'r', feature: 'f', status: 'healing', startedAt: '' })).toBeUndefined()
    for (const status of ['passed', 'failed', 'running', 'aborted'] as const) expect(runWaitingState(detail({ status }))).toBeUndefined()
    expect(runWaitingState(null)).toBeUndefined()
  })
  it('labels a queued run before hydration without claiming tests are executing', () => {
    const run = { runId: 'q', feature: 'f', status: 'queued' as const, startedAt: '' }
    expect(runWaitingState(run)).toMatchObject({ kind: 'queued', label: 'Queued' })
    expect(runWaitingState(detail({ status: 'queued' }))?.label).toBe('Queued')
  })
  it('distinguishes an active repair from a disconnected or missing external agent', () => {
    const session = recorded.manifest.externalHealSession!
    expect(runWaitingState(detail({ externalHealSession: { ...session, status: 'healing' } }))).toBeUndefined()
    // `waiting` = the agent is connected and blocked on the runner: its turn, not the human's.
    expect(runWaitingState(detail({ specEdits: undefined, externalHealSession: { ...session, status: 'waiting' } }))).toBeUndefined()
    expect(runWaitingState(detail({ externalHealSession: undefined, lifecycle: { phase: 'agent-healing', headline: 'Repairing', updatedAt: '' } }))).toBeUndefined()
    expect(runWaitingState(detail({ specEdits: undefined, externalHealSession: { ...session, status: 'disconnected' } }))?.label).toBe('Agent disconnected')
    expect(runWaitingState(detail({ specEdits: undefined, externalHealSession: undefined }))).toBeUndefined()
    expect(runWaitingState(detail({ specEdits: undefined, healMode: 'external', externalHealSession: undefined, lifecycle: {
      phase: 'waiting-for-signal', headline: 'Waiting for heal signal', updatedAt: '',
    } }))?.label).toBe('Awaiting Agent')
  })

  // The owner read "AWAITING AGENT" + "STOP HEAL" as stuck: nothing said the
  // tests had finished, what failed, or that a connected agent had the turn.
  it('says the tests finished, what failed, and that a connected agent has the repair', () => {
    const session = recorded.manifest.externalHealSession!
    const lifecycle = recorded.manifest.lifecycle!
    for (const status of ['healing', 'waiting'] as const) {
      const vm = deriveRunViewModel(detail({ specEdits: undefined, externalHealSession: { ...session, status } }))
      expect(vm.waiting).toBeUndefined()
      expect(vm.headline).toBe('Agent repairing')
      expect(vm.subtext).toBe(`Tests finished: 77/98 passed, 12 failed, 9 skipped, 0 not run. Codex has the repair since ${shortTime(lifecycle.updatedAt)}; last heartbeat ${shortTime(session.lastHeartbeatAt)}.`)
      expect(vm.actions.cancelHeal.enabled).toBe(true)
    }
    expect(runAgentTurn(detail({ specEdits: undefined, externalHealSession: { ...session, status: 'healing' } }))?.label).toBe('Agent repairing')
    // Pending test edits are the human's turn, not the agent's.
    expect(runAgentTurn(detail({ externalHealSession: { ...session, status: 'healing' } }))).toBeUndefined()
    expect(runAgentTurn(detail({ status: 'failed' }))).toBeUndefined()
  })

  it('says when a disconnected agent ends the heal, and how to end it now', () => {
    const session = recorded.manifest.externalHealSession!
    const vm = deriveRunViewModel(detail({ specEdits: undefined, externalHealSession: { ...session, status: 'disconnected' } }))
    const endsAt = shortTime(new Date(Date.parse(session.lastHeartbeatAt) + EXTERNAL_AGENT_GONE_MS).toISOString())
    expect(vm.headline).toBe('Agent disconnected')
    expect(vm.subtext).toBe(`Tests finished: 77/98 passed, 12 failed, 9 skipped, 0 not run. Codex stopped responding (last heartbeat ${shortTime(session.lastHeartbeatAt)}). The heal ends at ${endsAt} unless it reconnects; Stop heal ends it now.`)

    expect(runWaitingState(detail({ specEdits: undefined, externalHealSession: { ...session, status: 'disconnected', lastHeartbeatAt: 'unknown' } }))?.detail)
      .toBe('Tests finished: 77/98 passed, 12 failed, 9 skipped, 0 not run. Codex stopped responding. The heal ends unless it reconnects; Stop heal ends it now.')
  })

  it('shows why a heal ended on the failed run: the agent conclusion or the agent going away', () => {
    const agentEnded = deriveRunViewModel(detail({ status: 'failed', healEnd: { reason: 'agent-ended', cycle: 1, message: 'Claude ended the heal without a fix: real latency.', at: '' } }))
    expect(agentEnded.primaryAlert).toEqual({ tone: 'error', message: 'Claude ended the heal without a fix: real latency.' })
    const gone = deriveRunViewModel(detail({ status: 'failed', healEnd: { reason: 'no-signal', agentWait: 'agent-disconnected', cycle: 1, message: 'Claude stopped responding.', at: '' } }))
    expect(gone.primaryAlert?.message).toBe('Claude stopped responding.')
    expect(deriveRunViewModel(detail({ status: 'failed' })).primaryAlert?.message).toBe('Run finished with failing tests.')
  })
})
