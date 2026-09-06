import { describe, expect, it } from 'vitest'
import { classifyWaitForHealTask, type CanaryLabMcpDeps } from './tools'
import type { RunStore, RunDetail } from '../features/runs/logic/run-store'
import type { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import type { DirtySpecStore, DirtySpecRecord } from '../features/runs/logic/dirty-specs/store'

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
    lastGreenTestHashes: {},
    runStartTestHashes: {},
    approvedTestHashes: {},
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
    startRun: async () => ({ kind: 'started', runId: 'r' }),
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

// specEdits is the run-level sibling of dirtyTests: dirtyTests reads the
// feature's live dirty record, specEdits reads what this run recorded against
// its own run-start suite copy. Both ride the terminal verdicts, both are
// awareness only.
function runWithSpecEdits(status: 'passed' | 'failed', pending: number): RunDetail {
  return {
    manifest: {
      status,
      feature: 'checkout',
      executionType: 'run',
      specEdits: {
        checkedAt: 't1',
        pending: Array.from({ length: pending }, (_, i) => ({
          file: `e2e/spec-${i}.spec.ts`,
          change: 'modified',
          affectedTests: [`test ${i}`],
        })),
        adopted: [],
      },
      integrity: {
        hints: pending > 0
          ? [{ kind: 'weaker', file: 'e2e/spec-0.spec.ts', test: 'test 0', was: ['expect(a).toBe(1)'], now: [] }]
          : [],
        disclosure: 'Advisory only — this hint never changes a verdict. Its detection was checked by AI: one AI labelled, a second AI checked blind, no human.',
      },
    },
    summary: null,
  } as unknown as RunDetail
}

type SpecEditsValue = {
  type: string
  status?: string
  specEdits?: { pending: Array<{ file: string }>; hints: Array<{ kind: string }>; disclosure: string; nextSteps: string[] }
  dirtyTests?: unknown
}

describe('classifyWaitForHealTask — specEdits', () => {
  it('attaches the pending edits and hints to a passed run', () => {
    const res = classifyWaitForHealTask(makeDeps(runWithSpecEdits('passed', 2)), 'r', 's')
    const value = (res as { ok: true; value: SpecEditsValue }).value
    expect(value.type).toBe('passed')
    expect(value.specEdits?.pending.map((p) => p.file)).toEqual(['e2e/spec-0.spec.ts', 'e2e/spec-1.spec.ts'])
    expect(value.specEdits?.hints).toEqual([expect.objectContaining({ kind: 'weaker' })])
    expect(value.specEdits?.disclosure).toContain('no human')
    expect(value.specEdits?.nextSteps.join(' ')).toContain('ask the human to adopt')
  })

  it('attaches them to a failed run too — the edits were untested either way', () => {
    const res = classifyWaitForHealTask(makeDeps(runWithSpecEdits('failed', 1)), 'r', 's')
    const value = (res as { ok: true; value: SpecEditsValue }).value
    expect(value.type).toBe('failed')
    expect(value.specEdits?.pending).toHaveLength(1)
  })

  it('omits specEdits when the run recorded none pending', () => {
    const res = classifyWaitForHealTask(makeDeps(runWithSpecEdits('passed', 0)), 'r', 's')
    const value = (res as { ok: true; value: SpecEditsValue }).value
    expect(value.specEdits).toBeUndefined()
  })

  it('keeps dirtyTests and specEdits independent: a dirty feature with a clean run carries only dirtyTests', () => {
    const res = classifyWaitForHealTask(makeDeps(runWithSpecEdits('passed', 0), dirtyRecord('checkout')), 'r', 's')
    const value = (res as { ok: true; value: SpecEditsValue }).value
    expect(value.dirtyTests).toBeDefined()
    expect(value.specEdits).toBeUndefined()
  })
})
