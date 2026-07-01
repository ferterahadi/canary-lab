import { describe, expect, it } from 'vitest'
import { classifyWaitForHealTask, type CanaryLabMcpDeps } from './tools'
import type { RunStore, RunDetail } from '../src/features/runs/logic/run-store'
import type { ExternalHealBroker } from '../src/features/runs/logic/heal/external-heal-broker'
import type { DirtySpecStore, DirtySpecRecord } from '../src/features/runs/logic/dirty-specs/store'

// The dirtyTests warning is wired into the wait_for_heal_task result so the
// agent (Surface 2) relays it. These tests assert the field rides along with a
// terminal verdict when the integrity store reports dirty, and is omitted when
// clean or when no store is wired (awareness, never enforcement).

function passedRun(feature: string): RunDetail {
  return {
    manifest: { status: 'passed', feature, executionType: 'run' },
    summary: null,
  } as unknown as RunDetail
}

function dirtyRecord(feature: string): DirtySpecRecord {
  return {
    id: feature,
    featureId: feature,
    createdAt: 't0',
    status: 'dirty',
    dirtySpecs: [{ file: 'e2e/voucher.spec.ts', affectedTests: ['applies voucher'] }],
    lastGreenHashes: {},
    runStartHashes: {},
    approvedHashes: {},
    message: '⚠️ Tests have been modified, please review.',
    since: 't0',
  }
}

function makeDeps(run: RunDetail, dirty?: DirtySpecRecord): CanaryLabMcpDeps {
  return {
    store: { get: () => run } as unknown as RunStore,
    broker: {} as ExternalHealBroker,
    featuresDir: '/tmp/features',
    projectRoot: '/tmp',
    startRun: async () => ({ runId: 'r' }),
    dirtySpecStore: dirty
      ? ({ get: () => dirty } as unknown as DirtySpecStore)
      : ({ get: () => null } as unknown as DirtySpecStore),
  }
}

describe('classifyWaitForHealTask — dirtyTests', () => {
  it('attaches the warning to a passed run when specs are dirty', () => {
    const res = classifyWaitForHealTask(makeDeps(passedRun('checkout'), dirtyRecord('checkout')), 'r', 's')
    expect(res?.ok).toBe(true)
    const value = (res as { ok: true; value: { type: string; dirtyTests?: { message: string; specs: string[] } } }).value
    expect(value.type).toBe('passed')
    expect(value.dirtyTests?.message).toContain('Tests have been modified')
    expect(value.dirtyTests?.specs).toEqual(['e2e/voucher.spec.ts'])
  })

  it('omits dirtyTests when the feature is clean', () => {
    const res = classifyWaitForHealTask(makeDeps(passedRun('checkout')), 'r', 's')
    const value = (res as { ok: true; value: { type: string; dirtyTests?: unknown } }).value
    expect(value.type).toBe('passed')
    expect(value.dirtyTests).toBeUndefined()
  })

  it('omits dirtyTests when no integrity store is wired', () => {
    const deps = makeDeps(passedRun('checkout'))
    delete (deps as { dirtySpecStore?: unknown }).dirtySpecStore
    const res = classifyWaitForHealTask(deps, 'r', 's')
    const value = (res as { ok: true; value: { dirtyTests?: unknown } }).value
    expect(value.dirtyTests).toBeUndefined()
  })
})
