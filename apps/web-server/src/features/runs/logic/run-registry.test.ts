import { describe, it, expect, beforeEach, expectTypeOf } from 'vitest'
import path from 'path'
import type { PauseResult, CancelHealResult, InterjectResult, AdoptSpecEditsResult, RestoreSpecEditsResult } from './run-control-results'
import type { OrchestratorLike } from './run-registry'
import { createRegistry } from './run-registry'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-rs-')

let tmpDir: string

beforeEach(() => {
  tmpDir = tempDir()
})

describe('createRegistry', () => {
  it('round-trips orchestrator-like values', () => {
    const reg = createRegistry()
    const stub = {
      runId: 'r1',
      stop: async () => {},
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    }
    reg.set('r1', stub)
    expect(reg.get('r1')).toBe(stub)
    expect(reg.list()).toEqual([stub])
    expect(reg.delete('r1')).toBe(true)
    expect(reg.get('r1')).toBeUndefined()
    expect(reg.delete('r1')).toBe(false)
  })
})


// The registry is the route-facing contract; optional controls and sync restore
// must not change when runtime implementations share the same result types.
expectTypeOf<ReturnType<OrchestratorLike['pauseAndHeal']>>().toEqualTypeOf<Promise<PauseResult>>()
expectTypeOf<ReturnType<OrchestratorLike['cancelHeal']>>().toEqualTypeOf<Promise<CancelHealResult>>()
expectTypeOf<OrchestratorLike['interjectHealAgent']>().toEqualTypeOf<((text: string) => Promise<InterjectResult>) | undefined>()
expectTypeOf<ReturnType<NonNullable<OrchestratorLike['adoptSpecEdits']>>>().toEqualTypeOf<Promise<AdoptSpecEditsResult>>()
expectTypeOf<ReturnType<NonNullable<OrchestratorLike['restoreSpecEdits']>>>().toEqualTypeOf<RestoreSpecEditsResult>()
expectTypeOf<Extract<PauseResult, { ok: false }>['reason']>().toEqualTypeOf<'already-healing' | 'no-playwright-running' | 'no-failures-yet'>()
expectTypeOf<Extract<CancelHealResult, { ok: false }>['reason']>().toEqualTypeOf<'not-healing' | 'no-agent-running'>()
expectTypeOf<Extract<InterjectResult, { ok: false }>['reason']>().toEqualTypeOf<'no-agent-running'>()
expectTypeOf<Extract<AdoptSpecEditsResult, { ok: true }>['rerun']>().toEqualTypeOf<'signalled' | 'not-waiting-for-signal' | 'signal-already-pending'>()
