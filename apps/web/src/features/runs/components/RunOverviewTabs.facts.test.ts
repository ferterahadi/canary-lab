import { describe, expect, it } from 'vitest'
import type { RunManifest } from '@shared/run-manifest'
import { healAgentOverviewLabel, runFacts } from './RunOverviewTabs'

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

    expect(facts.map((f) => f.label)).toEqual(['Envset', 'Duration', 'Started'])
    expect(facts[1]?.value).toBe('in progress')
    expect(facts[2]?.title).toBe('2026-10-02T10:56:01.163Z')
    expect(facts[2]?.value).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(facts[2]?.sub).toBeTruthy()
  })

  it('folds the heal agent and its cycle count into one row', () => {
    const facts = runFacts(manifest({ healMode: 'external', healCycles: 2, externalHealSession: { clientKind: 'codex' } as RunManifest['externalHealSession'] }), null)

    expect(facts.find((f) => f.label === 'Heal')).toMatchObject({ value: 'Codex', sub: '2 cycles' })
    expect(facts.map((f) => f.label)).not.toContain('Heal cycles')
  })

  it('names the cycles alone when no agent is recorded, and drops the row when neither is', () => {
    expect(runFacts(manifest({ healCycles: 1 }), null).find((f) => f.label === 'Heal')).toMatchObject({ value: '1 cycle' })
    expect(runFacts(manifest(), null).map((f) => f.label)).not.toContain('Heal')
  })

  it('dashes a missing envset but keeps the row', () => {
    const bare = runFacts(manifest({ env: undefined }), null)
    expect(bare.find((f) => f.label === 'Envset')).toMatchObject({ value: '—', empty: true })
    expect(runFacts(manifest(), null).find((f) => f.label === 'Envset')?.empty).toBeUndefined()
  })

  it('adds the end time once the run has one and reads a queued run as not started', () => {
    expect(runFacts(manifest({ endedAt: '2026-10-02T11:00:00.000Z' }), 239_000).map((f) => f.label)).toEqual(['Envset', 'Duration', 'Started', 'Ended'])
    const queued = runFacts(manifest({ status: 'queued' }), null)
    expect(queued.find((f) => f.label === 'Duration')?.value).toBe('Not started')
    expect(queued.map((f) => f.label)).toContain('Queued at')
  })
})


describe('healAgentOverviewLabel', () => {
  it.each([
    ['claude', 'Claude'], ['codex', 'Codex'], ['claude-pty', 'Claude (runner)'],
    ['codex-pty', 'Codex (runner)'], ['other', 'External agent session'],
  ] as const)('prefers an external %s session over the configured agent', (clientKind, label) => {
    const value = manifest({ healMode: 'external', healAgent: 'claude', externalHealSession: { clientKind } as RunManifest['externalHealSession'] })
    expect(healAgentOverviewLabel(value)).toBe(label)
    expect(runFacts(value, null).find((fact) => fact.label === 'Heal')?.value).toBe(label)
  })

  it.each([
    [{ healAgent: 'claude', healMode: 'manual' }, 'Claude'],
    [{ healAgent: 'codex', healMode: 'auto' }, 'Codex'],
    [{ healMode: 'manual' }, 'Manual'],
    [{ healMode: 'external' }, 'External agent session'],
    [{ healMode: 'auto' }, 'Auto'],
    [{}, null],
  ] as const)('retains agent and mode fallbacks for %j', (overrides, label) => {
    expect(healAgentOverviewLabel(manifest(overrides))).toBe(label)
  })
})
