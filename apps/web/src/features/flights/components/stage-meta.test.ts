import { describe, it, expect } from 'vitest'
import { evaluationTaskId, portifyWorkflowId, stageStateLine, stageFacts, healEndLine, healEndShort } from './stage-meta'
import type { EvaluationExportTask, FlightManifest, FlightStage } from '@/shared/api/client'
import type { HealEnd } from '@/shared/api/types'

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
  it('a pending stage waits on a step it DEPENDS on, named as the rail names it', () => {
    const stage = { key: 'specs-coverage', status: 'pending' } as FlightStage
    const stages = [
      { key: 'scaffold', status: 'done' },
      { key: 'env-capture', status: 'done' },
      { key: 'prd-summary', status: 'pending' },
      stage,
    ] as FlightStage[]
    // "Requirements" is the merged rail row for docs+prd-summary — the raw
    // `prd-summary` key is a row the rail never shows.
    expect(stageStateLine(stage, flight({ stages }))).toBe('Waiting for Requirements.')
  })

  it('a pending stage does NOT wait on an unfinished step it never reads', () => {
    // Parallel readiness double-boots services; it never opens the PRD summary.
    // The old positional rule told it otherwise just because Requirements sits
    // above it in the rail.
    const stage = { key: 'portify', status: 'pending' } as FlightStage
    const stages = [
      { key: 'scaffold', status: 'done' },
      { key: 'env-capture', status: 'done' },
      { key: 'prd-summary', status: 'pending' },
      stage,
    ] as FlightStage[]
    expect(stageStateLine(stage, flight({ stages, status: 'running' }))).toBe('Not started yet.')
  })

  it('the export waits only on the run — not on requirements or specs', () => {
    const stage = { key: 'evaluation-export', status: 'pending' } as FlightStage
    const withRun = [
      { key: 'prd-summary', status: 'pending' },
      { key: 'specs-coverage', status: 'pending' },
      { key: 'run', status: 'done' },
      stage,
    ] as FlightStage[]
    expect(stageStateLine(stage, flight({ stages: withRun, status: 'running' }))).toBe('Not started yet.')
    const noRun = withRun.map((s) => (s.key === 'run' ? { ...s, status: 'pending' as const } : s))
    expect(stageStateLine(stage, flight({ stages: noRun }))).toBe('Waiting for Test Run.')
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

describe('stageStateLine — read-time (workspace-probed) evidence never asserts a gate', () => {
  it('scout drops the env-file clause when the scan never recorded one, instead of reporting zero', () => {
    const stage = { key: 'scout', status: 'done' } as FlightStage
    const line = stageStateLine(stage, flight({ stages: [stage] }))
    expect(line).toBe('Scanned 1 repo — suite configuration drafted.')
    expect(line).not.toMatch(/0 environment files/)
  })

  it('scout still reports what a real scan measured', () => {
    const stage = { key: 'scout', status: 'done', evidence: { envFiles: ['.env', '.env.local'] } } as FlightStage
    expect(stageStateLine(stage, flight({ stages: [stage] })))
      .toBe('Scanned 1 repo — suite configuration drafted, 2 environment files detected.')
  })

  it('probed coverage reports the ledger instead of claiming the target was met', () => {
    const stage = {
      key: 'specs-coverage',
      status: 'done',
      evidence: { coveragePct: 36, covered: 5, total: 14 },
      evidenceSource: 'workspace',
    } as FlightStage
    const line = stageStateLine(stage, flight({ stages: [stage] }))
    expect(line).toBe('Specs authored, coverage at 36% — 5 of 14 requirements covered.')
    expect(line).not.toMatch(/target met/)
  })

  it('a conducted coverage stage keeps its target-met sentence', () => {
    const stage = { key: 'specs-coverage', status: 'done', evidence: { coveragePct: 100 } } as FlightStage
    expect(stageStateLine(stage, flight({ stages: [stage] }))).toBe('Coverage target met — 100%.')
  })

  it('a probed suite-setup pair states the captured envset without claiming a dry-run boot', () => {
    const scaffold = { key: 'scaffold', status: 'done' } as FlightStage
    const envCapture = {
      key: 'env-capture',
      status: 'done',
      evidence: { captured: 1 },
      evidenceSource: 'workspace',
    } as FlightStage
    const line = stageStateLine(scaffold, flight({ stages: [scaffold, envCapture] }), envCapture)
    expect(line).toBe('Suite "checkout" created — env captured (1 file).')
    expect(line).not.toMatch(/dry-run boot/)
  })

  it('a conducted suite-setup pair keeps the dry-run boot proof', () => {
    const scaffold = { key: 'scaffold', status: 'done' } as FlightStage
    const envCapture = { key: 'env-capture', status: 'done', evidence: { captured: 2 } } as FlightStage
    expect(stageStateLine(scaffold, flight({ stages: [scaffold, envCapture] }), envCapture))
      .toBe('Suite "checkout" created — env captured (2 files), dry-run boot passed.')
  })
})

describe('stageFacts — evaluation report reads the export task, not the flight record', () => {
  const task = {
    taskId: 'eval-x',
    runId: '2026-07-01T0245-o456',
    feature: 'cns_better_auth',
    mode: 'localized',
    status: 'completed',
    downloadReady: true,
    createdAt: '2026-07-01T02:45:00Z',
    updatedAt: '2026-07-01T02:50:00Z',
  } as EvaluationExportTask
  const archive = { label: 'Archive', value: 'canary-lab-evaluation-cns_better_auth-2026-07-01T0245-o456.zip', mono: true, title: 'canary-lab-evaluation-cns_better_auth-2026-07-01T0245-o456.zip' }

  it('a conducted export and a probed one produce the SAME card', () => {
    // The two halves that used to differ: conducted evidence carries the archive
    // path, a read-time probe carries the task fields. Same task → same card.
    const conducted = {
      key: 'evaluation-export',
      status: 'done',
      evidence: { taskId: 'eval-x', evaluationZip: '/logs/e/eval-x/export.zip', archiveBase: 'canary-lab-evaluation-cns_better_auth-2026-07-01T0245-o456', mode: 'localized' },
    } as FlightStage
    const probed = {
      key: 'evaluation-export',
      status: 'done',
      evidence: { taskId: 'eval-x', runId: '2026-07-01T0245-o456', mode: 'localized' },
      evidenceSource: 'workspace',
    } as FlightStage
    const expected = [
      { label: 'From run', value: '2026-07-01T0245-o456', mono: true },
      { label: 'Report', value: 'agent-rewritten' },
      archive,
    ]
    expect(stageFacts(conducted, flight(), undefined, task)).toEqual(expected)
    expect(stageFacts(probed, flight(), undefined, task)).toEqual(expected)
  })

  it('never shows export.zip — the internal filename nobody is handed', () => {
    const stage = {
      key: 'evaluation-export',
      status: 'done',
      evidence: { taskId: 'eval-x', evaluationZip: '/logs/e/eval-x/export.zip' },
    } as FlightStage
    const values = stageFacts(stage, flight(), undefined, task).map((f) => f.value)
    expect(values).toContain(archive.value)
    expect(values).not.toContain('export.zip')
  })

  it('falls back to the recorded archive name when the export task is gone', () => {
    const stage = {
      key: 'evaluation-export',
      status: 'done',
      evidence: { taskId: 'eval-x', archiveBase: 'canary-lab-evaluation-checkout-2026-07-01T0245-o456', mode: 'raw' },
    } as FlightStage
    expect(stageFacts(stage, flight(), undefined, null)).toEqual([
      { label: 'Report', value: 'built from evidence' },
      {
        label: 'Archive',
        value: 'canary-lab-evaluation-checkout-2026-07-01T0245-o456.zip',
        mono: true,
        title: 'canary-lab-evaluation-checkout-2026-07-01T0245-o456.zip',
      },
    ])
  })

  it('no task and no recorded name means no facts', () => {
    const none = { key: 'evaluation-export', status: 'done', evidence: {} } as FlightStage
    expect(stageFacts(none, flight())).toEqual([])
  })
})

describe('evaluationTaskId — the export task behind the stage', () => {
  it('prefers the stage evidence, falls back to the record for the resume path', () => {
    const withEvidence = { key: 'evaluation-export', status: 'done', evidence: { taskId: 'eval-from-evidence' } } as FlightStage
    const reused = { key: 'evaluation-export', status: 'done', evidence: { evaluationZip: '/logs/e/eval-x/export.zip', reused: true } } as FlightStage
    const linked = flight({ links: { evaluationTaskId: 'eval-from-links' } })
    expect(evaluationTaskId(withEvidence, linked)).toBe('eval-from-evidence')
    expect(evaluationTaskId(reused, linked)).toBe('eval-from-links')
    expect(evaluationTaskId(reused, flight())).toBeUndefined()
    expect(evaluationTaskId({ key: 'run', status: 'done' } as FlightStage, linked)).toBeUndefined()
  })
})

describe('probed coverage with no requirements is undefined, not zero', () => {
  const noReqs = {
    key: 'specs-coverage',
    status: 'done',
    evidence: { coveragePct: 0, requirementCount: 0, covered: 0, total: 0 },
    evidenceSource: 'workspace',
  } as FlightStage

  it('says there is nothing to map against instead of reporting 0%', () => {
    const line = stageStateLine(noReqs, flight({ stages: [noReqs] }))
    expect(line).toBe('Specs authored — no requirements to map them against yet.')
    expect(line).not.toMatch(/0%/)
    expect(line).not.toMatch(/0 of 0/)
  })

  it('shows no percentage tile — an amber 0% would read as a failing suite', () => {
    expect(stageFacts(noReqs, flight())).toEqual([{ label: 'Requirements', value: 'None mapped yet' }])
  })

  it('a probed suite WITH requirements still reports its real coverage', () => {
    const withReqs = {
      key: 'specs-coverage',
      status: 'done',
      evidence: { coveragePct: 35.7, covered: 5, total: 14 },
      evidenceSource: 'workspace',
    } as FlightStage
    expect(stageStateLine(withReqs, flight({ stages: [withReqs] })))
      .toBe('Specs authored, coverage at 35.7% — 5 of 14 requirements covered.')
    expect(stageFacts(withReqs, flight())[0]).toMatchObject({ label: 'Requirements covered', value: '35.7%' })
  })
})

describe('a dependency is satisfied by its ARTIFACT, not by its step being ticked', () => {
  // The rail must not claim a step is blocked while the server's entry validator
  // — which checks artifacts on disk — allows entering it. A part-done coverage
  // step (specs authored, no requirements to map them onto) has still produced
  // the specs the run stage reads.
  const partDoneCoverage = {
    key: 'specs-coverage',
    status: 'pending',
    evidence: { coveragePct: 0, total: 0 },
    evidenceSource: 'workspace',
  } as FlightStage

  it('the run stage is not blocked by a part-done coverage step whose specs exist', () => {
    const stage = { key: 'run', status: 'pending' } as FlightStage
    const stages = [
      { key: 'scaffold', status: 'done' },
      { key: 'env-capture', status: 'done' },
      partDoneCoverage,
      stage,
    ] as FlightStage[]
    expect(stageStateLine(stage, flight({ stages, status: 'running' }))).toBe('Not started yet.')
  })

  it('but a dependency with NO artifact at all still blocks, and is named', () => {
    const stage = { key: 'run', status: 'pending' } as FlightStage
    const stages = [
      { key: 'scaffold', status: 'done' },
      { key: 'env-capture', status: 'done' },
      { key: 'specs-coverage', status: 'pending' },
      stage,
    ] as FlightStage[]
    expect(stageStateLine(stage, flight({ stages, status: 'running' })))
      .toBe('Waiting for Test authoring & coverage.')
  })
})
