import { describe, it, expect } from 'vitest'
import { portifyWorkflowId, stageStateLine, stageFacts, healEndLine, healEndShort } from './stage-meta'
import type { FlightManifest, FlightStage } from '../../../shared/api/client'
import type { HealEnd } from '../../../shared/api/types'

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

describe('stageFacts — run stage renders as the hero, not stage facts (R80)', () => {
  it('the run stage emits no stage-level facts (the Test Run hero owns them)', () => {
    const stage = { key: 'run', status: 'done', evidence: { runId: 'run-9', status: 'passed', healCycles: 2 } } as unknown as FlightStage
    expect(stageFacts(stage, flight())).toEqual([])
  })
})

describe('healEndLine / healEndShort (R80)', () => {
  const he = (over: Partial<HealEnd>): HealEnd => ({ reason: 'no-signal', cycle: 1, message: '', at: '2026-01-01T00:00:00Z', ...over })

  it('returns null when there is no give-up reason', () => {
    expect(healEndLine(undefined)).toBeNull()
    expect(healEndShort(undefined)).toBeNull()
  })

  it('prefers the server-written message for the full line', () => {
    expect(healEndLine(he({ message: 'Auto-repair stopped after cycle 1 — usage limit.' })))
      .toBe('Auto-repair stopped after cycle 1 — usage limit.')
  })

  it('composes a full line per reason when no message is present', () => {
    expect(healEndLine(he({ reason: 'max-cycles', message: '' }))).toMatch(/repair-cycle limit/i)
    expect(healEndLine(he({ reason: 'no-signal', agentCause: 'usage-limit', message: '' }))).toMatch(/usage limit/i)
  })

  it('short form names the cause for a no-signal give-up', () => {
    expect(healEndShort(he({ reason: 'no-signal', agentCause: 'usage-limit' }))).toBe('stopped — usage limit')
    expect(healEndShort(he({ reason: 'no-signal', agentCause: 'unknown' }))).toBe('stopped — agent went quiet')
    expect(healEndShort(he({ reason: 'max-cycles' }))).toBe('stopped — cycle limit')
    expect(healEndShort(he({ reason: 'cancelled' }))).toBe('stopped by you')
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
    expect(facts.find((f) => f.label === 'Authoring pass')).toMatchObject({ value: '2', big: true, stepper: [2, 5] })
    const cov = facts.find((f) => f.label === 'Requirements covered')
    expect(cov).toMatchObject({ value: '40%', big: true, tone: 'warn' })
    expect(cov?.bar).toBeCloseTo(0.4)
    const gaps = facts.find((f) => f.label === 'Coverage gaps')
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
    expect(facts.find((f) => f.label === 'Requirements covered')).toMatchObject({ value: '100%', big: true, tone: 'good', bar: 1 })
    const gaps = facts.find((f) => f.label === 'Coverage gaps')
    expect(gaps).toMatchObject({ value: '0', big: true, tone: 'good' })
    expect(gaps?.sub).toBeUndefined()
    expect(facts.find((f) => f.label === 'Authoring pass')).toBeUndefined()
    expect(facts.find((f) => f.label === 'Authoring passes')).toMatchObject({ value: '2', big: true })
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

describe('portify live progress (workflow id + phase mirror)', () => {
  const running = (progress?: unknown): FlightStage =>
    ({ key: 'portify', status: 'running', ...(progress !== undefined ? { progress } : {}) }) as FlightStage

  it('portifyWorkflowId: evidence wins once settled; progress pins it live; other stages null', () => {
    expect(portifyWorkflowId({ key: 'portify', evidence: { workflowId: 'wf-done' }, progress: { workflowId: 'wf-live' } })).toBe('wf-done')
    expect(portifyWorkflowId({ key: 'portify', progress: { workflowId: 'wf-live' } })).toBe('wf-live')
    expect(portifyWorkflowId({ key: 'portify' })).toBeNull()
    expect(portifyWorkflowId({ key: 'scout', evidence: { workflowId: 'wf-x' } })).toBeNull()
  })

  it('running facts: attempt stepper + phase verb from the live mirror', () => {
    const facts = stageFacts(running({ workflowId: 'wf1', status: 'editing', attempt: 2, maxAttempts: 3 }), flight())
    const attempt = facts.find((f) => f.label === 'Attempt')
    expect(attempt).toMatchObject({ value: '2', big: true, stepper: [2, 3] })
    expect(facts.find((f) => f.label === 'Phase')?.value).toBe('Agent editing services')
  })

  it('running facts: older flights without the mirror render no half-empty tiles', () => {
    expect(stageFacts(running({ workflowId: 'wf1' }), flight())).toEqual([])
    expect(stageFacts(running(), flight())).toEqual([])
  })

  it('running state line follows the phase; unknown/missing phase falls back to the generic line', () => {
    const line = (progress?: unknown) => stageStateLine(running(progress), flight({ status: 'running', stages: [running(progress)] }))
    expect(line({ workflowId: 'wf1', status: 'editing' })).toBe('Agent is editing the services to read injected ports…')
    expect(line({ workflowId: 'wf1', status: 'verifying' })).toBe('Double-boot verifying the edits (two instances side by side)…')
    expect(line({ workflowId: 'wf1', status: 'weird-new-phase' })).toBe('Verifying the services boot concurrently (port injection)…')
    expect(line()).toBe('Verifying the services boot concurrently (port injection)…')
  })
})
