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
  loadPortify: vi.fn(),
  portifyWorkflow: vi.fn(),
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

// The Parallel-readiness band reads its portify workflow off the live
// `/ws/portify` store; the provider needs a socket, so stub the hooks.
vi.mock('@/features/portify/state/PortifyContext', () => ({
  usePortify: () => ({ loadPortify: mocks.loadPortify }),
  usePortifyWorkflow: (id?: string | null) => mocks.portifyWorkflow(id),
}))

import { FlightPage } from './FlightPage'

;

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement

let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getFeatureCoverage.mockResolvedValue(undefined)
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

// R81 — a feature whose stages were completed OUTSIDE the conductor has flown.
// FlightPage renders that progress from a client-only pseudo-manifest under a
// `feature:<name>` token, so there is no record to GET and no record-scoped
// control (resume / redo / abort / delete / download) may appear.
describe('derived flights (R81)', () => {
  const allDone = () => FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))
  const upToSpecs = () => FLIGHT_STAGE_KEYS.map((key) => ({
    key,
    status: (['similarity', 'scout', 'scaffold', 'env-capture', 'docs', 'prd-summary'].includes(key) ? 'done' : 'pending') as 'done' | 'pending',
  }))

  it('renders a derived token without fetching a flight record', async () => {
    await render('feature:go-smoke', { derivedStages: new Map([['go-smoke', allDone()]]) })
    expect(mocks.getFlight).not.toHaveBeenCalled()
    expect(container.textContent).toContain('go-smoke')
    // Every step done → the same word a recorded flight gets. It flew; it just
    // wasn't conducted.
    expect(container.querySelector('[data-testid="flight-status"]')?.textContent).toBe('Done')
  })

  it('offers exactly one primary and no record-scoped controls', async () => {
    await render('feature:go-smoke', { derivedStages: new Map([['go-smoke', allDone()]]) })
    expect(container.querySelector('[data-testid="derived-conduct"]')).toBeTruthy()
    for (const testId of ['flight-pause', 'flight-primary-download', 'flight-continue']) {
      expect(container.querySelector(`[data-testid="${testId}"]`)).toBeNull()
    }
  })

  // The ⋯ menu's one action deletes the SUITE through the feature-scoped API,
  // and a derived flight only exists because that folder does. It was hidden
  // with the record-scoped controls, which denied a valid action on every suite
  // set up outside the conductor.
  it('keeps the ⋯ menu — deleting the suite needs no flight record', async () => {
    await render('feature:go-smoke', { derivedStages: new Map([['go-smoke', allDone()]]) })
    const menu = container.querySelector<HTMLButtonElement>('[data-testid="flight-menu"]')
    expect(menu).toBeTruthy()
    act(() => { menu!.click() })
    expect(container.querySelector('[data-testid="flight-delete"]')?.textContent).toContain('Delete suite')
  })

  it('never offers the record-removal variant, even with Suite setup still open', async () => {
    // A recorded flight parked before scaffold has only its record to drop; a
    // derived one has no record at all, so it must still target the suite.
    await render('feature:half-built', {
      derivedStages: new Map([['half-built', FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: (key === 'similarity' || key === 'scout' ? 'done' : 'pending') as 'done' | 'pending',
      }))]]),
    })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flight-menu"]')!.click() })
    const label = container.querySelector('[data-testid="flight-delete"]')?.textContent ?? ''
    expect(label).toContain('Delete suite')
    expect(label).not.toContain('Remove flight')
  })

  it('continues from the first stage with no evidence, handing that stage to the launcher', async () => {
    const onStartFlight = vi.fn()
    await render('feature:half-built', {
      derivedStages: new Map([['half-built', upToSpecs()]]),
      onStartFlight,
    })
    const primary = container.querySelector<HTMLButtonElement>('[data-testid="derived-conduct"]')!
    expect(primary.textContent).toContain('Continue from')
    act(() => { primary.click() })
    // specs-coverage is the first stage without an artifact — re-fly intent, so
    // the finished steps are kept rather than redone.
    expect(onStartFlight).toHaveBeenCalledWith('half-built', 'refly', 'specs-coverage')
  })

  it('offers a fresh flight — not a continue — when every stage is already done', async () => {
    const onStartFlight = vi.fn()
    await render('feature:go-smoke', { derivedStages: new Map([['go-smoke', allDone()]]), onStartFlight })
    const primary = container.querySelector<HTMLButtonElement>('[data-testid="derived-conduct"]')!
    expect(primary.textContent).toContain('Fly again')
    act(() => { primary.click() })
    expect(onStartFlight).toHaveBeenCalledWith('go-smoke', 'fresh', null)
  })

  it('hands over to the real record the moment one exists for the feature', async () => {
    const onSelectFlight = vi.fn()
    mocks.getFlightEntryOptions.mockResolvedValue({
      feature: 'go-smoke',
      flight: { flightId: 'fl_real', status: 'running', stages: [] },
      active: true,
      canContinue: false,
      prefill: { repoPaths: ['/repo/shop'], description: '', env: 'local', coverageTarget: 100 },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, allowed: true })),
    })
    await render('feature:go-smoke', { derivedStages: new Map([['go-smoke', allDone()]]), onSelectFlight })
    // The token can never point at a stale derived view.
    expect(onSelectFlight).toHaveBeenCalledWith('fl_real')
  })

  // The download is task-scoped, NOT record-scoped: it fetches the export task,
  // which a derived flight's read-time evidence carries. Gating it on the
  // recorded zip PATH hid a finished, downloadable archive on every derived
  // flight — so the header keeps its one primary while the archive's own card
  // carries the download.
  it('offers the archive download on the export card, with the run it was built from', async () => {
    mocks.taskById.mockReturnValue({
      taskId: 'eval-derived',
      runId: '2026-07-01T0245-o456',
      feature: 'go-smoke',
      mode: 'localized',
      status: 'completed',
      downloadReady: true,
      createdAt: '2026-07-01T02:45:00Z',
      updatedAt: '2026-07-01T02:50:00Z',
    })
    mocks.getFlightEntryOptions.mockResolvedValue({
      feature: 'go-smoke',
      flight: null,
      active: false,
      canContinue: false,
      prefill: { repoPaths: ['/repo/shop'], description: '', env: 'local', coverageTarget: 100 },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, allowed: true })),
      evidence: { 'evaluation-export': { taskId: 'eval-derived', runId: '2026-07-01T0245-o456', mode: 'localized' } },
    })
    await render('feature:go-smoke', { derivedStages: new Map([['go-smoke', allDone()]]) })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-evaluation-export"]')?.click()
    })
    // A derived flight has no record at all, so the deliverable card is built
    // entirely from the probed export TASK — and the download works from it.
    const card = container.querySelector('[data-testid="evaluation-deliverable"]')
    expect(card?.textContent).toContain('2026-07-01T0245-o456')
    expect(card?.textContent).toContain('canary-lab-evaluation-go-smoke-2026-07-01T0245-o456.zip')
    const download = card?.querySelector<HTMLButtonElement>('[data-testid="download-report-eval-derived"]')
    await act(async () => { download?.click() })
    expect(mocks.downloadTask).toHaveBeenCalledWith('eval-derived')
    // Still exactly one header primary — the record-scoped one stays absent.
    expect(container.querySelector('[data-testid="flight-primary-download"]')).toBeNull()
    expect(container.querySelector('[data-testid="derived-conduct"]')).toBeTruthy()
  })
})

// A pseudo-manifest must not answer questions only a real record can answer.
describe('derived flights state no facts they do not have (R81)', () => {
  it('names no conducting agent — nothing conducted it', async () => {
    await render('feature:go-smoke', {
      derivedStages: new Map([['go-smoke', FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))]]),
    })
    const strip = container.querySelector('[data-testid="flight-summary-strip"]')
    expect(strip?.textContent ?? '').not.toContain('Agent')
    // A real record still states it.
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done', currentStage: null }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="flight-summary-strip"]')?.textContent).toContain('Agent')
  })
})
