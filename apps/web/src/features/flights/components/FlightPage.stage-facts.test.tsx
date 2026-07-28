// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightManifest } from '@/shared/api/client'
import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'
import { InvalidationProvider } from '@/shared/state/invalidation'

const mocks = vi.hoisted(() => ({
  listFlights: vi.fn(),
  getFlight: vi.fn(),
  getFlightRemedy: vi.fn(),
  applyFlightRemedy: vi.fn(),
  getRunDetail: vi.fn(),
  listJournal: vi.fn(),
  respondFlightCheckpoint: vi.fn(),
  resumeFlight: vi.fn(),
  setFlightAutopilot: vi.fn(),
  abortFlight: vi.fn(),
  pauseFlight: vi.fn(),
  redoFlight: vi.fn(),
  deleteFlight: vi.fn(),
  listRuns: vi.fn(),
  getEnvsetSlot: vi.fn(),
  getEnvsetsIndex: vi.fn(),
  getPortify: vi.fn(),
  getFeatureCoverage: vi.fn(),
  downloadTask: vi.fn(),
  getFeatureConfigDoc: vi.fn(),
  getPlaywrightConfig: vi.fn(),
  getRepoGitStatus: vi.fn(),
  putFeatureConfigDoc: vi.fn(),
  putPlaywrightConfig: vi.fn(),
  listFeatureDocs: vi.fn(),
  getFlightEntryOptions: vi.fn(),
  importFeatureDoc: vi.fn(),
  deleteFeatureDoc: vi.fn(),
  deleteFeature: vi.fn(),
  linkFeatureDocPath: vi.fn(),
  openEditor: vi.fn(),
  cancelHealRun: vi.fn(),
  stopRun: vi.fn(),
  restartRun: vi.fn(),
  taskById: vi.fn(),
  taskForRun: vi.fn(),
  evaluationTasks: vi.fn(() => []),
}))

vi.mock('@/shared/api/client', () => ({
  listFlights: mocks.listFlights,
  getFlight: mocks.getFlight,
  getFlightRemedy: mocks.getFlightRemedy,
  applyFlightRemedy: mocks.applyFlightRemedy,
  getRunDetail: mocks.getRunDetail,
  listJournal: mocks.listJournal,
  respondFlightCheckpoint: mocks.respondFlightCheckpoint,
  resumeFlight: mocks.resumeFlight,
  setFlightAutopilot: mocks.setFlightAutopilot,
  abortFlight: mocks.abortFlight,
  pauseFlight: mocks.pauseFlight,
  redoFlight: mocks.redoFlight,
  deleteFlight: mocks.deleteFlight,
  listRuns: mocks.listRuns,
  getEnvsetSlot: mocks.getEnvsetSlot,
  getEnvsetsIndex: mocks.getEnvsetsIndex,
  getPortify: mocks.getPortify,
  getFeatureCoverage: mocks.getFeatureCoverage,
  getFeatureConfigDoc: mocks.getFeatureConfigDoc,
  getPlaywrightConfig: mocks.getPlaywrightConfig,
  getRepoGitStatus: mocks.getRepoGitStatus,
  putFeatureConfigDoc: mocks.putFeatureConfigDoc,
  putPlaywrightConfig: mocks.putPlaywrightConfig,
  listFeatureDocs: mocks.listFeatureDocs,
  getFlightEntryOptions: mocks.getFlightEntryOptions,
  importFeatureDoc: mocks.importFeatureDoc,
  deleteFeatureDoc: mocks.deleteFeatureDoc,
  deleteFeature: mocks.deleteFeature,
  linkFeatureDocPath: mocks.linkFeatureDocPath,
  openEditor: mocks.openEditor,
  cancelHealRun: mocks.cancelHealRun,
  stopRun: mocks.stopRun,
  restartRun: mocks.restartRun,
  ApiError: class ApiError extends Error {
    constructor(message: string, public status = 500, public body: unknown = null) { super(message) }
  },
}))

// The agent timeline is its own tested component with live transports — stub it.
// It now also receives the conductor's system lines (R66) as `systemRows`, split
// pre/post around the agent's slot; expose them so the flight tests can assert
// they ride the same block instead of standalone log panes.
vi.mock('@/shared/ui/AgentSessionView', () => ({
  AgentSessionView: ({ source, systemRows }: { source?: { kind: string; stage?: string }; systemRows?: { pre: string[]; post: string[] } }) => (
    <div data-testid="agent-session-view" data-kind={source?.kind} data-stage={source?.stage}>
      {systemRows?.pre.map((l, i) => <div key={`pre-${i}`} data-testid="system-pre">{l}</div>)}
      {systemRows?.post.map((l, i) => <div key={`post-${i}`} data-testid="system-post">{l}</div>)}
    </div>
  ),
}))

// The export stage reads the download action + task lookups from the export
// context; the provider needs live sockets, so stub the hook.
vi.mock('@/features/evaluation/state/EvaluationExportContext', () => ({
  useEvaluationExports: () => ({
    tasks: mocks.evaluationTasks(),
    downloadTask: mocks.downloadTask,
    taskById: mocks.taskById,
    taskForRun: mocks.taskForRun,
    logsByTaskId: {},
    watchTask: vi.fn(),
  }),
}))

import { FlightPage } from './FlightPage'

;

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement

let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getFeatureCoverage.mockResolvedValue(undefined)
  mocks.getPortify.mockResolvedValue(undefined)
  mocks.getEnvsetsIndex.mockResolvedValue(undefined)
  mocks.getEnvsetSlot.mockResolvedValue(undefined)
  mocks.getRunDetail.mockResolvedValue({ runId: 'run-9', manifest: { status: 'passed' } })
  mocks.getFlightRemedy.mockResolvedValue({ remedy: null })
  mocks.listRuns.mockResolvedValue([])
  mocks.listJournal.mockResolvedValue([])
  mocks.downloadTask.mockResolvedValue(undefined)
  mocks.getFeatureConfigDoc.mockRejectedValue(new Error('no config'))
  mocks.getPlaywrightConfig.mockRejectedValue(new Error('no config'))
  mocks.getRepoGitStatus.mockResolvedValue({
    path: '/repo/shop',
    expectedBranch: 'develop',
    isGitRepo: true,
    currentBranch: 'develop',
    detached: false,
    dirty: false,
    dirtyFiles: [],
    localBranches: ['develop', 'main'],
    remoteBranches: ['origin/develop', 'origin/main'],
  })
  mocks.listFeatureDocs.mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: false, sourceDocCount: 0, docsDrift: false })
  mocks.getFlightEntryOptions.mockResolvedValue({
    feature: 'checkout',
    flight: null,
    active: false,
    canContinue: false,
    prefill: { repoPaths: ['/repo/shop'], description: 'checkout flow', env: 'local', coverageTarget: 100 },
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, allowed: true })),
  })
  mocks.taskById.mockReturnValue(null)
  mocks.taskForRun.mockReturnValue(null)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function manifest(over: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'fl_1',
    feature: 'checkout',
    repoPaths: ['/repo/shop'],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'running',
    currentStage: 'scout',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

// FlightPage reads its refetch keys from the invalidation bus now, not a prop.
// The old tests bumped a `refreshKey` prop to force a re-fetch; here a unique
// remount key per call remounts FlightPage, which re-runs its fetch effect —
// the same observable effect, without a prop lever.
let renderSeq = 0

async function render(flightId: string, extraProps: Record<string, unknown> = {}) {
  renderSeq += 1
  await act(async () => {
    root.render(
      <InvalidationProvider>
        <FlightPage key={renderSeq} flightId={flightId} onSelectFlight={vi.fn()} onClose={vi.fn()} {...extraProps} />
      </InvalidationProvider>,
    )
  })
}

describe('trailer model (R14–R18)', () => {
  it('R27: a running specs-coverage stage speaks the loop — pass line, timeline, authoring agent live', async () => {
    const progress = {
      pass: 2,
      maxPasses: 5,
      phase: 'authoring' as const,
      coveragePct: 40,
      target: 100,
      gapsOpen: 3,
      passes: [{ pass: 1, coveragePct: 40, gapsOpen: 3 }],
    }
    mocks.getFlight.mockResolvedValue(manifest({
      currentStage: 'specs-coverage',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'specs-coverage' ? ('running' as const) : ('pending' as const),
        ...(key === 'specs-coverage' ? { progress } : {}),
      })),
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="stage-rail-specs-coverage"]')?.textContent).toContain('Test authoring & coverage')
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent).toBe('Pass 2 of 5 — agent is authoring specs to close 3 gaps…')
    expect(container.querySelector('[data-testid="stage-facts"]')?.textContent).toContain('2 of 5')
    expect(container.querySelector('[data-testid="specs-pass-1"]')?.textContent).toContain('40% covered · 3 gaps open')
    expect(container.querySelector('[data-testid="specs-pass-live"]')?.textContent).toContain('authoring tests')
    // R77: the passes still ahead show as quiet future rows (3 of 5 → 3, 4, 5).
    expect(container.querySelector('[data-testid="specs-pass-pending-3"]')?.textContent).toContain('Pass 3 — pending')
    expect(container.querySelector('[data-testid="specs-pass-pending-5"]')?.textContent).toContain('Pass 5 — pending')
    expect(container.querySelector('[data-testid="specs-pass-pending-6"]')).toBeNull()
    expect(container.querySelector('[data-testid="agent-session-view"]')?.getAttribute('data-stage')).toBe('specs-coverage')
  })

  it('R27: while the loop maps coverage, the live agent view follows the mapping agent', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      currentStage: 'specs-coverage',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'specs-coverage' ? ('running' as const) : ('pending' as const),
        ...(key === 'specs-coverage'
          ? { progress: { pass: 1, maxPasses: 5, phase: 'mapping', coveragePct: 0, target: 100, gapsOpen: 3, passes: [] } }
          : {}),
      })),
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent).toBe('Pass 1 of 5 — mapping the specs against the requirements…')
    expect(container.querySelector('[data-testid="agent-session-view"]')?.getAttribute('data-stage')).toBe('coverage-map')
  })

  it('R27: a settled loop keeps the pass history and the pass count fact, without a live row', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'specs-coverage'
          ? {
              evidence: { coveragePct: 100, gaps: [] },
              progress: {
                pass: 2, maxPasses: 5, phase: 'mapping', coveragePct: 100, target: 100, gapsOpen: 0,
                passes: [{ pass: 1, note: 'specs failed to compile/list' }, { pass: 2, coveragePct: 100, gapsOpen: 0 }],
              },
            }
          : {}),
      })),
    }))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-specs-coverage"]')?.click()
    })
    expect(container.querySelector('[data-testid="stage-facts"]')?.textContent).toContain('Authoring passes')
    expect(container.querySelector('[data-testid="specs-pass-1"]')?.textContent).toContain('specs failed to compile/list')
    expect(container.querySelector('[data-testid="specs-pass-2"]')?.textContent).toContain('100% covered')
    expect(container.querySelector('[data-testid="specs-pass-live"]')).toBeNull()
    // R77: a settled loop spends no more passes — no future rows even though
    // it stopped at 2 of 5 (target met early).
    expect(container.querySelector('[data-testid="specs-pass-pending-3"]')).toBeNull()
  })

  it('R72: the status chip rides the title line, right of the name', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done', currentStage: null, stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const })) }))
    await render('fl_1')
    const title = container.querySelector('h1')
    expect(title?.textContent).toContain('checkout')
    expect(title?.querySelector('[data-testid="flight-status"]')?.textContent).toBe('done')
  })

  it('R14/R16: a generating stage leads with a live state line', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      currentStage: 'scaffold',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'scaffold' ? ('running' as const) : key === 'similarity' ? ('done' as const) : ('pending' as const),
      })),
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent).toBe('Creating the suite in the workspace…')
    expect(container.querySelector('[data-testid="stage-status-chip"]')?.textContent).toContain('generating')
    // Advanced setup only appears once the config is APPROVED (scaffold done).
    expect(container.querySelector('[data-testid="feature-setup-advanced"]')).toBeNull()
  })

  it('R20/R30: facts fold evidence into plain rows; raw evidence JSON never renders', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'portify' ? { evidence: { workflowId: 'wf-3', edits: false }, log: '[portify] double boot verified\n' } : {}),
      })),
    }))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-portify"]')?.click()
    })
    // The band counts the work instead of restating the verdict three ways: a
    // flight that needed no edits reports zero files, not the sentence "None
    // needed" beside two more sentences saying the same thing.
    const portifyFacts = container.querySelector('[data-testid="stage-facts"]')?.textContent ?? ''
    expect(portifyFacts).toContain('Files edited')
    expect(portifyFacts).toContain('already injectable')
    expect(container.textContent).not.toContain('"workflowId"')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-details-toggle"]')?.click()
    })
    // R30/R66: the disclosure is ONE block — the system line rides the rail
    // (an agentless stage renders it as system rows, no JSON dump).
    expect(container.textContent).not.toContain('"workflowId"')
    const asv = container.querySelector('[data-testid="agent-session-view"]')
    expect(asv).not.toBeNull()
    expect(asv?.textContent).toContain('portify')
    expect(asv?.textContent).toContain('double boot verified')
  })

  it('R30: a stage with no log and no agent has no details disclosure', async () => {
    // Scaffold, not portify: portify grew an agent source (its workflow
    // timeline now tails into the rail, settled included), so the agentless
    // example must be a stage that truly never spawns one.
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const })),
    }))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-scaffold"]')?.click()
    })
    expect(container.querySelector('[data-testid="stage-details-toggle"]')).toBeNull()
  })

  it('R80: the Test Run hero renders the settled run once — verdict + repair cycles, NO agent output', async () => {
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-9',
      manifest: { runId: 'run-9', status: 'passed', healCycles: 1 },
      summary: { complete: true, total: 8, passed: 8, failed: [] },
    })
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      runVerdict: 'passed',
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'run' ? { evidence: { runId: 'run-9', status: 'passed', healCycles: 1 } } : {}),
      })),
    }))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click()
    })
    const hero = container.querySelector('[data-testid="test-run-hero"]')?.textContent ?? ''
    // The run is rendered as ONE object: the verdict chip, the pass count, and
    // the repair cycles — not duplicated across a facts card + a summary card.
    expect(hero).toContain('passed')
    expect(hero).toContain('8/8')
    expect(hero).toContain('Repair cycles')
    // The top "At a glance" facts card no longer double-renders the run.
    expect(container.querySelector('[data-testid="stage-facts"]')).toBeNull()
    expect(container.querySelector('[data-testid="agent-session-view"]')).toBeNull()
  })

  it('R82: while the run is live the hero shows the repair state and the failures found so far — no repair journal', async () => {
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-9',
      manifest: { runId: 'run-9', status: 'healing', healCycles: 1 },
      summary: { complete: false, total: 3, passed: 1, failed: [{ name: 'checkout flow' }] },
    })
    mocks.getFlight.mockResolvedValue(manifest({
      currentStage: 'run',
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'run' ? ('running' as const) : ('pending' as const),
      })),
    }))
    await render('fl_1')
    const hero = container.querySelector('[data-testid="test-run-hero"]')?.textContent ?? ''
    expect(hero).toContain('healing')
    // The score is stated ONCE — by the Tests-passed tile, not also promoted
    // onto the identity row beside the status chip.
    expect(hero).toContain('1/3')
    expect(hero).not.toContain('1/3 passed')
    expect(container.querySelector('[data-testid="run-hero-failing"]')?.textContent).toContain('checkout flow')
    // R82: the repair transcript is run-detail content — the stage no longer
    // carries a journal disclosure (nor polls for it).
    expect(container.querySelector('[data-testid="repair-journal"]')).toBeNull()
    expect(container.querySelector('[data-testid="run-activity"]')).toBeNull()
    expect(mocks.listJournal).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="agent-session-view"]')).toBeNull()
  })

  it('R82: a failed run asks through the SAME generic checkpoint card every other kind uses', async () => {
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-9',
      manifest: {
        runId: 'run-9',
        status: 'failed',
        healCycles: 1,
        healEnd: {
          reason: 'no-signal',
          agentCause: 'usage-limit',
          cycle: 1,
          message: 'Auto-repair stopped after cycle 1. Its last output suggests the agent hit a usage limit.',
          at: '2026-01-01T00:00:00Z',
        },
      },
      summary: { complete: true, total: 23, passed: 2, failed: [{ name: 'otp guard', location: 'e2e/otp.spec.ts:9' }] },
    })
    mocks.respondFlightCheckpoint.mockResolvedValue(manifest())
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'waiting-for-approval',
      currentStage: 'run',
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'run' ? ('waiting-for-approval' as const) : ('done' as const),
        ...(key === 'run'
          ? {
              // A PARKED run stage has NO evidence — the adapter hands its
              // evidence over as the checkpoint's `data` instead (verified
              // against a live run-failed record). Putting counts in `evidence`
              // here would pass while the real screen fell back to the verdict.
              checkpoint: {
                kind: 'run-failed',
                message: 'Run run-9 ended failed after 1 heal cycle(s).',
                options: ['rerun', 'export-as-is'],
                data: { runId: 'run-9', status: 'failed', healCycles: 1, counts: { passed: 2, total: 23, failed: 4 } },
              },
            }
          : {}),
      })),
    }))
    await render('fl_1')
    // R82: the bespoke amber slab inside the hero is gone; the fork renders as
    // CheckpointControls, below the run, exactly like config-approval does.
    expect(container.querySelector('[data-testid="run-decision-footer"]')).toBeNull()
    const card = container.querySelector('[data-testid="checkpoint-controls"]')
    expect(card).toBeTruthy()
    expect(container.querySelector('[data-testid="checkpoint-title"]')?.textContent).toContain('The test run did not pass')
    // The stage sentence spends itself on the OUTCOME (counts off the run
    // summary, carried in the stage's evidence) instead of pointing at the card
    // below, which already asks the question.
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent)
      .toBe('4 of 23 tests failed after 1 repair cycle.')
    // And no `Restart run` beside the checkpoint's own "Start a new run".
    expect(container.querySelector('[data-testid="run-stage-restart"]')).toBeNull()
    const rerun = container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-choice-rerun"]')
    expect(rerun?.textContent).toContain('Start a new run')
    await act(async () => { rerun?.click() })
    expect(mocks.respondFlightCheckpoint).toHaveBeenCalledWith('fl_1', { choice: 'rerun' })
  })

  const exportFlight = (evidence: Record<string, unknown>): FlightManifest => manifest({
    status: 'done',
    currentStage: null,
    links: { runId: 'run-9', evaluationTaskId: 'task-7', evaluationZip: '/logs/evaluation-exports/task-7/export.zip' },
    stages: FLIGHT_STAGE_KEYS.map((key) => ({
      key,
      status: 'done' as const,
      ...(key === 'evaluation-export' ? { evidence } : {}),
    })),
  })

  const openExportStage = async (evidence: Record<string, unknown>): Promise<void> => {
    mocks.getFlight.mockResolvedValue(exportFlight(evidence))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-evaluation-export"]')?.click()
    })
  }

  const readyTask = {
    taskId: 'task-7',
    runId: '2026-07-23T1603-z6kc',
    feature: 'merchant-pass-fnb',
    mode: 'localized',
    status: 'completed',
    downloadReady: true,
    createdAt: '2026-07-23T16:03:00Z',
    updatedAt: '2026-07-23T16:10:00Z',
  }

  it('the download sits on the deliverable card, beside the archive name it fetches', async () => {
    mocks.taskById.mockReturnValue(readyTask)
    await openExportStage({ taskId: 'task-7', evaluationZip: '/logs/evaluation-exports/task-7/export.zip' })
    // Neither in the stage header nor on the band's kicker line: the band
    // measures what the report says, the card hands the file over. Three buttons
    // for one file is the duplication R82 removed for Restart.
    const header = container.querySelector('[data-testid="stage-state-line"]')?.previousElementSibling
    expect(header?.querySelector('[data-testid^="download-report-"]')).toBeNull()
    expect(container.querySelector('[data-testid="stage-facts-card"] [data-testid^="download-report-"]')).toBeNull()
    const card = container.querySelector('[data-testid="evaluation-deliverable"]')
    const download = card?.querySelector<HTMLButtonElement>('[data-testid="download-report-task-7"]')
    expect(download?.getAttribute('title')).toBe('Download canary-lab-evaluation-merchant-pass-fnb-2026-07-23T1603-z6kc.zip')
    await act(async () => { download?.click() })
    expect(mocks.downloadTask).toHaveBeenCalledWith('task-7')
    // The card names the run and the real archive — never the internal
    // export.zip inside the logs dir, a file nobody is ever handed.
    const deliverable = card?.textContent ?? ''
    expect(deliverable).toContain('2026-07-23T1603-z6kc')
    expect(deliverable).toContain('canary-lab-evaluation-merchant-pass-fnb-2026-07-23T1603-z6kc.zip')
    expect(deliverable).not.toContain('export.zip')
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent).toBe('Evaluation ready.')
  })

  it('a read-time-probed export (a derived flight has no zip path) still offers the download', async () => {
    mocks.taskById.mockReturnValue(readyTask)
    await openExportStage({ taskId: 'task-7', runId: '2026-07-23T1603-z6kc', mode: 'localized' })
    expect(container.querySelector('[data-testid="evaluation-deliverable"] [data-testid="download-report-task-7"]')).toBeTruthy()
  })

  it('an export the client no longer holds shows no download rather than a dead button', async () => {
    mocks.taskById.mockReturnValue(null)
    await openExportStage({ taskId: 'task-7', archiveBase: 'canary-lab-evaluation-merchant-pass-fnb-2026-07-23T1603-z6kc' })
    expect(container.querySelector('[data-testid^="download-report-"]')).toBeNull()
    // The recorded name still reads in the band — the flight's own record of
    // what it built, even with the task gone.
    expect(container.querySelector('[data-testid="stage-facts"]')?.textContent)
      .toContain('canary-lab-evaluation-merchant-pass-fnb-2026-07-23T1603-z6kc.zip')
  })

  it('surfaces a failed download on the control instead of failing silently', async () => {
    mocks.taskById.mockReturnValue(readyTask)
    mocks.downloadTask.mockRejectedValue(new Error('nope'))
    await openExportStage({ taskId: 'task-7' })
    const download = container.querySelector<HTMLButtonElement>('[data-testid="download-report-task-7"]')
    await act(async () => { download?.click() })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="download-report-task-7"]')?.getAttribute('title'))
      .toBe('Download failed — click to retry')
  })

  it('lists every report for the suite, marks this flight\'s, and downloads any row', async () => {
    // Both tasks belong to THIS flight's feature — the list is suite-scoped, so
    // an export for another feature must not appear here.
    const mine = { ...readyTask, feature: 'checkout' }
    const older = { ...mine, taskId: 'task-3', runId: '2026-07-20T0900-m4tq', mode: 'raw' as const }
    const otherFeature = { ...readyTask, taskId: 'task-5', feature: 'billing' }
    // Newest-first, exactly as the export store hands them over.
    mocks.evaluationTasks.mockReturnValue([mine, older, otherFeature])
    mocks.taskById.mockReturnValue(mine)
    await openExportStage({ taskId: 'task-7' })
    const list = container.querySelector('[data-testid="all-reports-panel"]')
    expect(list?.textContent).toContain('2026-07-23T1603-z6kc')
    expect(list?.textContent).toContain('2026-07-20T0900-m4tq')
    // The stage's own report is badged; the others are just history.
    expect(list?.querySelector('[data-testid="report-row-task-7"]')?.textContent).toContain('this flight')
    expect(list?.querySelector('[data-testid="report-row-task-3"]')?.textContent).not.toContain('this flight')
    expect(list?.querySelector('[data-testid="report-row-task-5"]')).toBeNull()
    await act(async () => {
      list?.querySelector<HTMLButtonElement>('[data-testid="download-report-task-3"]')?.click()
    })
    expect(mocks.downloadTask).toHaveBeenCalledWith('task-3')
  })

  it('a failed export shows its reason, not a download that cannot work', async () => {
    mocks.evaluationTasks.mockReturnValue([
      { ...readyTask, feature: 'checkout', taskId: 'task-9', status: 'failed', downloadReady: false, error: 'rewrite agent exited' },
    ])
    mocks.taskById.mockReturnValue(null)
    await openExportStage({ taskId: 'task-9' })
    const row = container.querySelector('[data-testid="report-row-task-9"]')
    expect(row?.textContent).toContain('rewrite agent exited')
    expect(row?.textContent).toContain('no archive')
    expect(row?.querySelector('[data-testid="download-report-task-9"]')).toBeNull()
  })
})
