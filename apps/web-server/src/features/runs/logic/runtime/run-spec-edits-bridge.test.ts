import { describe, it, expect } from 'vitest'
import { bridgeDirtySpecsToActiveRuns } from './run-spec-edits-bridge'
import type { DirtySpecStoreEvent } from '../dirty-specs/store'
import type { OrchestratorLike } from '../run-registry'

function harness(orchs: OrchestratorLike[]) {
  const listeners: Array<(e: DirtySpecStoreEvent) => void> = []
  bridgeDirtySpecsToActiveRuns({ onEvent: (fn) => { listeners.push(fn) } }, { list: () => orchs })
  return { fire: (e: DirtySpecStoreEvent) => listeners.forEach((fn) => fn(e)) }
}

const base = { stop: async () => {}, pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }), cancelHeal: async () => ({ ok: true as const }) }

describe('bridgeDirtySpecsToActiveRuns', () => {
  it('asks every live orchestrator to re-measure for the changed feature — each decides if it is its own', () => {
    const seen: string[] = []
    const a: OrchestratorLike = { ...base, runId: 'a', refreshSpecEdits: (f) => { seen.push(`a:${f}`) } }
    const b: OrchestratorLike = { ...base, runId: 'b', refreshSpecEdits: (f) => { seen.push(`b:${f}`) } }
    const { fire } = harness([a, b])
    fire({ kind: 'changed', featureId: 'shop' })
    expect(seen).toEqual(['a:shop', 'b:shop'])
  })

  it('tolerates an orchestrator without the lever, and ignores a removed record that names no feature', () => {
    const seen: string[] = []
    const legacy: OrchestratorLike = { ...base, runId: 'legacy' }
    const live: OrchestratorLike = { ...base, runId: 'live', refreshSpecEdits: (f) => { seen.push(f) } }
    const { fire } = harness([legacy, live])
    fire({ kind: 'removed' })
    expect(seen).toEqual([])
    fire({ kind: 'changed', featureId: 'shop' })
    expect(seen).toEqual(['shop'])
  })
})
