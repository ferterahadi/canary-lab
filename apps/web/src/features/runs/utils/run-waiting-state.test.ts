import { describe, expect, it } from 'vitest'
import type { RunDetail, RunManifest } from '@/shared/api/types'
import fixture from './__fixtures__/cns-wa-snapshot.json'
import { runWaitingState } from './run-waiting-state'
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
    expect(runWaitingState({ runId: 'r', feature: 'f', status: 'healing', startedAt: '', pendingSpecEdits: 1 })?.shortLabel).toBe('to review')
    expect(runWaitingState({ runId: 'r', feature: 'f', status: 'healing', startedAt: '' })).toBeUndefined()
    for (const status of ['passed', 'failed', 'running', 'aborted'] as const) expect(runWaitingState(detail({ status }))).toBeUndefined()
    expect(runWaitingState(null)).toBeUndefined()
  })
  it('labels a queued run before hydration without claiming tests are executing', () => {
    const run = { runId: 'q', feature: 'f', status: 'queued' as const, startedAt: '' }
    expect(runWaitingState(run)).toMatchObject({ kind: 'queued', label: 'Queued' })
    expect(runWaitingState(detail({ status: 'queued' }))?.label).toBe('Queued')
  })
  it('distinguishes an active repair from a waiting/disconnected external session', () => {
    const session = recorded.manifest.externalHealSession!
    expect(runWaitingState(detail({ externalHealSession: { ...session, status: 'healing' } }))).toBeUndefined()
    expect(runWaitingState(detail({ externalHealSession: undefined, lifecycle: { phase: 'agent-healing', headline: 'Repairing', updatedAt: '' } }))).toBeUndefined()
    for (const status of ['waiting', 'disconnected'] as const) {
      expect(runWaitingState(detail({ specEdits: undefined, externalHealSession: { ...session, status } }))?.label).toBe('Waiting for agent')
    }
    expect(runWaitingState(detail({ specEdits: undefined, externalHealSession: undefined }))).toBeUndefined()
  })
})
