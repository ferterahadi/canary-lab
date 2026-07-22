import { describe, it, expect } from 'vitest'
import { stageStateLine, stageFacts } from './stage-meta'
import type { FlightManifest, FlightStage } from '../../../shared/api/client'

function flight(over: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'fl_1',
    feature: 'checkout',
    repoPaths: ['/repo/a'],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'paused',
    currentStage: 'specs-coverage',
    stages: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as FlightManifest
}

describe('stageStateLine — pending copy (R78 pause mid-step)', () => {
  it('a NEVER-STARTED pending stage with an earlier stage still ahead waits for it', () => {
    const stage = { key: 'specs-coverage', status: 'pending' } as FlightStage
    const stages = [
      { key: 'scout', status: 'running' },
      stage,
    ] as FlightStage[]
    expect(stageStateLine(stage, flight({ stages }))).toBe('Waiting for earlier stages.')
  })

  it('an INTERRUPTED pending stage (startedAt set) says the step was interrupted, not waiting', () => {
    const stage = { key: 'specs-coverage', status: 'pending', startedAt: '2026-01-01T00:05:00Z' } as FlightStage
    const line = stageStateLine(stage, flight({ stages: [stage] }))
    expect(line).not.toBe('Waiting for earlier stages.')
    expect(line).toMatch(/[Ii]nterrupted/)
    expect(line).toMatch(/resume/i)
  })

  it('a first-to-run pending stage on a PAUSED flight was stopped before it started, not waiting for earlier stages', () => {
    // The reported repro: a flight user-paused before start — scout pending,
    // no startedAt, nothing earlier. "Waiting for earlier stages" is incoherent.
    const stage = { key: 'scout', status: 'pending' } as FlightStage
    const line = stageStateLine(stage, flight({ status: 'paused', stages: [stage] }))
    expect(line).not.toBe('Waiting for earlier stages.')
    expect(line).toMatch(/before it started/i)
    expect(line).toMatch(/Continue/)
  })

  it('a first-to-run pending stage counts every earlier stage being done/skipped as "nothing to wait on"', () => {
    const stage = { key: 'scout', status: 'pending' } as FlightStage
    const stages = [
      { key: 'similarity', status: 'skipped' },
      stage,
    ] as FlightStage[]
    const line = stageStateLine(stage, flight({ status: 'paused', stages }))
    expect(line).not.toBe('Waiting for earlier stages.')
    expect(line).toMatch(/before it started/i)
  })

  it('a first-to-run pending stage on a non-paused flight reads as not started yet', () => {
    const stage = { key: 'scout', status: 'pending' } as FlightStage
    const line = stageStateLine(stage, flight({ status: 'running', stages: [stage] }))
    expect(line).toBe('Not started yet.')
  })
})

describe('stageFacts — specs-coverage metric tiles (R77)', () => {
  it('a running loop emits Pass as a big value with a stepper, coverage with a bar, gaps with a breakdown sub', () => {
    const stage = {
      key: 'specs-coverage',
      status: 'running',
      progress: { pass: 2, maxPasses: 5, phase: 'authoring', coveragePct: 40, target: 100, gapsOpen: 3, passes: [] },
      evidence: { gaps: [{ gap: 'untested' }, { gap: 'untested' }, { gap: 'path-incomplete' }] },
    } as unknown as FlightStage
    const facts = stageFacts(stage, flight())
    expect(facts.find((f) => f.label === 'Pass')).toMatchObject({ value: '2', big: true, stepper: [2, 5] })
    const cov = facts.find((f) => f.label === 'Coverage')
    expect(cov).toMatchObject({ value: '40%', big: true, tone: 'warn' })
    expect(cov?.bar).toBeCloseTo(0.4)
    const gaps = facts.find((f) => f.label === 'Open gaps')
    expect(gaps).toMatchObject({ value: '3', big: true, tone: 'warn', sub: '2 untested · 1 path-incomplete' })
  })

  it('full coverage with no gaps reads good — bar full, gaps 0 with no sub, Pass fact dropped once settled', () => {
    const stage = {
      key: 'specs-coverage',
      status: 'done',
      progress: { pass: 2, maxPasses: 5, phase: 'mapping', coveragePct: 100, target: 100, gapsOpen: 0, passes: [{ pass: 1 }, { pass: 2 }] },
      evidence: { coveragePct: 100, gaps: [] },
    } as unknown as FlightStage
    const facts = stageFacts(stage, flight())
    expect(facts.find((f) => f.label === 'Coverage')).toMatchObject({ value: '100%', big: true, tone: 'good', bar: 1 })
    const gaps = facts.find((f) => f.label === 'Open gaps')
    expect(gaps).toMatchObject({ value: '0', big: true, tone: 'good' })
    expect(gaps?.sub).toBeUndefined()
    expect(facts.find((f) => f.label === 'Pass')).toBeUndefined()
    expect(facts.find((f) => f.label === 'Passes')).toMatchObject({ value: '2' })
  })
})

describe('stageStateLine — skipped copy', () => {
  it('renders the stage-entry pre-skip as a sentence, not the raw marker', () => {
    const stage = { key: 'scout', status: 'skipped', skipReason: 'stage-entry' } as FlightStage
    const line = stageStateLine(stage, flight({ stages: [stage] }))
    expect(line).not.toMatch(/stage-entry/)
    expect(line).toBe('Skipped — this flight started at a later step.')
  })

  it('wraps an evidence-based prose reason in a sentence', () => {
    const stage = { key: 'scout', status: 'skipped', skipReason: 'rerun of existing feature checkout' } as FlightStage
    expect(stageStateLine(stage, flight({ stages: [stage] }))).toBe('Skipped — rerun of existing feature checkout.')
  })

  it('falls back when no reason was recorded', () => {
    const stage = { key: 'scout', status: 'skipped' } as FlightStage
    expect(stageStateLine(stage, flight({ stages: [stage] }))).toBe('Skipped.')
  })
})
