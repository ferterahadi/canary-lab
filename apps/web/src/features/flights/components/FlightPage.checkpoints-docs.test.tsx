// @vitest-environment happy-dom

import { act } from 'react'

import { createRoot, type Root } from 'react-dom/client'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'

import { InvalidationProvider } from '@/shared/state/invalidation'

// The Parallel-readiness band reads its portify workflow off the live
// `/ws/portify` store; the provider needs a socket, so stub the hooks.
vi.mock('@/features/portify/state/PortifyContext', () => ({
  usePortify: () => ({ loadPortify: mocks.loadPortify }),
  usePortifyWorkflow: (id?: string | null) => mocks.portifyWorkflow(id),
}))

import { FlightPage } from './FlightPage'

;

import { manifest } from './__fixtures__/flight-page-part7-fixtures'

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

;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

describe('checkpoint display language (R71/W3)', () => {
  const parkedOn = (key: string, checkpoint: Record<string, unknown>) => manifest({
    status: 'waiting-for-approval',
    stages: FLIGHT_STAGE_KEYS.map((k) => ({
      key: k,
      status: k === key ? ('waiting-for-approval' as const) : ('done' as const),
      ...(k === key ? { checkpoint } : {}),
    })),
  })

  it('R74: pressing "Gather with agent" flashes a one-line confirmation that re-triggers on a repeat press', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('docs', {
      kind: 'prd-source', message: 'No requirement docs yet.', options: ['collect-repo-docs', 'infer-from-diff'],
    }))
    mocks.respondFlightCheckpoint.mockResolvedValue(manifest())
    await render('fl_1')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-path-agent"]')?.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-hint-collect-repo-docs"]')?.click() })
    expect(container.querySelector('[data-testid="fork-start-agent"]')?.textContent).toBe('Gather with agent')
    expect(container.querySelector('[data-testid="fork-start-agent-flash"]')).toBeNull()

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-start-agent"]')?.click() })
    const flash = container.querySelector('[data-testid="fork-start-agent-flash"]')
    expect(flash?.textContent).toBe('Agent started — output streams in the activity band below')
    // ONE confirmation only: the old persistent "Starting the agent…" line is gone.
    expect(container.textContent).not.toContain('Starting the agent')

    // Simulate the fade-out finishing: the flash unmounts itself.
    await act(async () => { flash?.dispatchEvent(new Event('animationend', { bubbles: true })) })
    expect(container.querySelector('[data-testid="fork-start-agent-flash"]')).toBeNull()

    // A repeat press re-triggers the flash rather than leaving it gone.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-start-agent"]')?.click() })
    expect(container.querySelector('[data-testid="fork-start-agent-flash"]')?.textContent).toBe('Agent started — output streams in the activity band below')
  })

  it('R74: the start button itself shows the working state while the respond is in flight', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('docs', {
      kind: 'prd-source', message: 'No docs yet.', options: ['collect-repo-docs', 'infer-from-diff'],
    }))
    let resolveRespond: ((v: unknown) => void) | null = null
    mocks.respondFlightCheckpoint.mockReturnValue(new Promise((res) => { resolveRespond = res }))
    await render('fl_1')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-path-agent"]')?.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-hint-collect-repo-docs"]')?.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-start-agent"]')?.click() })

    // While the respond round-trip is pending: the button IS the running cue.
    const button = container.querySelector<HTMLButtonElement>('[data-testid="fork-start-agent"]')
    expect(button?.textContent).toBe('Starting…')
    expect(button?.disabled).toBe(true)

    await act(async () => { resolveRespond?.(manifest()) })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="fork-start-agent"]')?.textContent).toBe('Gather with agent')
  })

  it('R74: manual path with docs present releases via continue', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('docs', {
      kind: 'prd-source', message: '1 doc ready.', options: ['continue', 'collect-repo-docs', 'infer-from-diff'],
    }))
    mocks.listFeatureDocs.mockResolvedValue({
      feature: 'checkout',
      docs: [{ relPath: 'prd.md', absPath: '/ws/features/checkout/docs/prd.md', sizeBytes: 100, generated: false }],
      hasPrdSummary: false,
      sourceDocCount: 1,
      docsDrift: false,
    })
    mocks.respondFlightCheckpoint.mockResolvedValue(manifest())
    await render('fl_1')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-path-manual"]')?.click() })
    expect(container.querySelector('[data-testid="doc-pill-prd.md"]')).toBeTruthy()
    const useDocs = container.querySelector<HTMLButtonElement>('[data-testid="fork-use-docs"]')
    expect(useDocs?.disabled).toBe(false)
    await act(async () => { useDocs?.click() })
    expect(mocks.respondFlightCheckpoint).toHaveBeenCalledWith('fl_1', { choice: 'continue' })
  })

  it('R74: once approved the docs panel is locked — no add/remove, the lock chip + hint instead', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      currentStage: 'specs-coverage',
      stages: FLIGHT_STAGE_KEYS.map((k) => ({
        key: k,
        status: k === 'specs-coverage' ? ('running' as const) : k === 'portify' || k === 'run' || k === 'heal' || k === 'evaluation-export' ? ('pending' as const) : ('done' as const),
      })),
    }))
    mocks.listFeatureDocs.mockResolvedValue({
      feature: 'checkout',
      docs: [{ relPath: 'checkout-prd.md', absPath: '/ws/features/checkout/docs/checkout-prd.md', sizeBytes: 100, generated: false }],
      hasPrdSummary: true,
      sourceDocCount: 1,
      docsDrift: false,
    })
    await render('fl_1')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-docs"]')?.click() })
    expect(container.querySelector('[data-testid="docs-locked-chip"]')?.textContent).toContain('Locked')
    expect(container.querySelector('[data-testid="flight-docs-panel"]')?.textContent).toContain('Continue → from a step')
    expect(container.querySelector('[data-testid="doc-pill-checkout-prd.md"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="remove-doc-checkout-prd.md"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-doc-add-files"]')).toBeNull()
    expect(container.querySelector('[data-testid="empty-dropzone"]')).toBeNull()
  })

  it('the distilled summary gets its own card — artifact pill, count, and a ledger drill', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      currentStage: 'specs-coverage',
      stages: FLIGHT_STAGE_KEYS.map((k) => ({
        key: k,
        status: k === 'specs-coverage' ? ('running' as const) : k === 'portify' || k === 'run' || k === 'heal' || k === 'evaluation-export' ? ('pending' as const) : ('done' as const),
        ...(k === 'prd-summary' ? { evidence: { requirementCount: 6 } } : {}),
      })),
    }))
    mocks.listFeatureDocs.mockResolvedValue({
      feature: 'checkout',
      docs: [
        { relPath: 'okr.md', absPath: '/ws/features/checkout/docs/okr.md', sizeBytes: 5100, generated: false },
        { relPath: '_prd-summary.md', absPath: '/ws/features/checkout/docs/_prd-summary.md', sizeBytes: 4200, generated: true },
      ],
      hasPrdSummary: true,
      sourceDocCount: 1,
      docsDrift: false,
    })
    const onOpenCoverage = vi.fn()
    await render('fl_1', { onOpenCoverage })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-docs"]')?.click() })

    // The stage's OUTPUT is visible and openable, not just a status chip.
    const distilled = container.querySelector('[data-testid="flight-distilled-panel"]')
    expect(distilled?.textContent).toContain('Distilled requirements · 6')
    expect(distilled?.querySelector('[data-testid="doc-pill-_prd-summary.md"]')).toBeTruthy()
    // The generated artifact stays OUT of the source-docs card — one card per half.
    const sourceCard = container.querySelector('[data-testid="flight-docs-panel"] > div')
    expect(sourceCard?.textContent).toContain('okr.md')
    expect(sourceCard?.textContent).not.toContain('_prd-summary.md')
    // The summary chip rides the card it describes, not the inputs card.
    expect(distilled?.querySelector('[data-testid="docs-summary-chip"]')).toBeTruthy()
    expect(sourceCard?.querySelector('[data-testid="docs-summary-chip"]')).toBeNull()
    // Never dead-end: the stage drills to where the requirements are browsable,
    // from the SAME header slot every other stage's drill-through uses.
    expect(distilled?.querySelector('[data-testid="stage-drill-docs"]')).toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-drill-docs"]')?.click() })
    expect(onOpenCoverage).toHaveBeenCalledWith('checkout')
  })

  it('while distilling, the output card holds the space instead of leaving a blank gap', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      currentStage: 'prd-summary',
      stages: FLIGHT_STAGE_KEYS.map((k) => ({
        key: k,
        status: k === 'prd-summary' ? ('running' as const) : k === 'scout' || k === 'scaffold' || k === 'env-capture' || k === 'similarity' || k === 'docs' ? ('done' as const) : ('pending' as const),
      })),
    }))
    mocks.listFeatureDocs.mockResolvedValue({
      feature: 'checkout',
      docs: [{ relPath: 'okr.md', absPath: '/ws/features/checkout/docs/okr.md', sizeBytes: 5100, generated: false }],
      hasPrdSummary: false,
      sourceDocCount: 1,
      docsDrift: false,
    })
    // Drill wired, so the gate below is what's under test — not a missing prop.
    await render('fl_1', { onOpenCoverage: vi.fn() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-docs"]')?.click() })
    const distilled = container.querySelector('[data-testid="flight-distilled-panel"]')
    expect(distilled?.textContent).toContain('Distilling the source docs')
    // No count yet, and no drill to a ledger that has nothing in it — the docs
    // row is already `done` here, so only the folded summary can gate it.
    expect(distilled?.textContent).not.toContain('·')
    expect(container.querySelector('[data-testid="stage-drill-docs"]')).toBeNull()
  })

  it('once the agent is writing, the output card reports it and shows the words arriving', async () => {
    // The state the user shut their machine down in: the agent was two-thirds
    // through a 27k-character answer and the card said only "progress in
    // Activity below" — pointing at a panel that gains no row until the whole
    // block completes.
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      currentStage: 'prd-summary',
      stages: FLIGHT_STAGE_KEYS.map((k) => ({
        key: k,
        status: k === 'prd-summary' ? ('running' as const) : k === 'scout' || k === 'scaffold' || k === 'env-capture' || k === 'similarity' || k === 'docs' ? ('done' as const) : ('pending' as const),
        ...(k === 'prd-summary'
          ? { agentActivity: { phase: 'writing' as const, thinkingTokens: 3900, chars: 27627, tail: '"description": "Cassandra shows FAILED rows"' } }
          : {}),
      })),
    }))
    mocks.listFeatureDocs.mockResolvedValue({
      feature: 'checkout',
      docs: [{ relPath: 'okr.md', absPath: '/ws/features/checkout/docs/okr.md', sizeBytes: 5100, generated: false }],
      hasPrdSummary: false,
      sourceDocCount: 1,
      docsDrift: false,
    })
    await render('fl_1', { onOpenCoverage: vi.fn() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-docs"]')?.click() })
    const distilled = container.querySelector('[data-testid="flight-distilled-panel"]')
    expect(distilled?.textContent).toContain('Writing the answer — 27,627 characters so far')
    // The old copy promised progress somewhere it wasn't; it must not survive.
    expect(distilled?.textContent).not.toContain('progress in Activity below')
    // The climbing count IS the sign of life. The raw answer tail is NOT shown
    // here: a slice of half-written JSON cut mid-token is unreadable as content
    // and reads as a defect rather than as progress. AgentSessionView below
    // still owns the full output.
    expect(distilled?.querySelector('[data-testid="docs-summary-tail"]')).toBeNull()
    expect(distilled?.textContent).not.toContain('Cassandra shows FAILED rows')
  })

  it('an unmapped kind/option degrades to its raw key, never blank', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('scout', {
      kind: 'future-kind', message: 'New question.', options: ['yes-do-it'],
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="checkpoint-title"]')?.textContent).toBe('future-kind')
    expect(container.querySelector('[data-testid="checkpoint-choice-yes-do-it"]')?.textContent).toContain('yes-do-it')
  })
})
