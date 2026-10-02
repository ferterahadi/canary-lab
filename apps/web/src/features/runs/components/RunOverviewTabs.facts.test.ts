import { describe, expect, it } from 'vitest'
import type { RunManifest } from '@shared/run-manifest'
import { runFacts } from './RunOverviewTabs'

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-1',
    feature: 'checkout',
    env: 'local',
    status: 'healing',
    startedAt: '2026-10-02T10:56:01.163Z',
    healCycles: 0,
    services: [],
    ...overrides,
  } as RunManifest
}

describe('runFacts', () => {
  it('leaves the suite to the run header and splits a timestamp into time over date', () => {
    const facts = runFacts(manifest(), null)

    expect(facts.map((f) => f.label)).toEqual(['Envset', 'Duration', 'Heal', 'Started', 'Ended', 'Models'])
    expect(facts[1]?.value).toBe('in progress')
    expect(facts[3]?.title).toBe('2026-10-02T10:56:01.163Z')
    expect(facts[3]?.value).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(facts[3]?.sub).toBeTruthy()
  })

  it('folds the heal agent and its cycle count into one tile', () => {
    const facts = runFacts(manifest({ healMode: 'external', healCycles: 2, externalHealSession: { clientKind: 'codex' } as RunManifest['externalHealSession'] }), null)

    expect(facts.find((f) => f.label === 'Heal')).toMatchObject({ value: 'Codex', sub: '2 cycles' })
    expect(facts.map((f) => f.label)).not.toContain('Heal cycles')
  })

  it('names the cycles alone when no agent is recorded, and dashes the slot when neither is', () => {
    expect(runFacts(manifest({ healCycles: 1 }), null).find((f) => f.label === 'Heal')).toMatchObject({ value: '1 cycle' })
    expect(runFacts(manifest(), null).find((f) => f.label === 'Heal')).toMatchObject({ value: '—', empty: true })
  })

  it('always returns six slots so the grid folds into whole rows', () => {
    const bare = runFacts(manifest({ env: undefined }), null)
    expect(bare).toHaveLength(6)
    expect(bare.filter((f) => f.empty).map((f) => f.label)).toEqual(['Envset', 'Heal', 'Ended', 'Models'])
  })

  it('adds the end time once the run has one and reads a queued run as not started', () => {
    expect(runFacts(manifest({ endedAt: '2026-10-02T11:00:00.000Z' }), 239_000).find((f) => f.label === 'Ended')?.empty).toBeUndefined()
    const queued = runFacts(manifest({ status: 'queued' }), null)
    expect(queued.find((f) => f.label === 'Duration')?.value).toBe('Not started')
    expect(queued.map((f) => f.label)).toContain('Queued at')
  })
})
