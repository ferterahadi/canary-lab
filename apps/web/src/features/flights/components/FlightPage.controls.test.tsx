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

describe('flight controls (R48/R71)', () => {
  const openMenu = async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-menu"]')?.click() })
  }

  it('R74: Pause is the one labeled header control while active; posts and refetches', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'running' }))
    await render('fl_1')
    const pause = container.querySelector<HTMLButtonElement>('[data-testid="flight-pause"]')
    expect(pause).toBeTruthy()
    // No Stop anywhere, no ⋯ menu while active (Delete is settled-only).
    expect(container.querySelector('[data-testid="flight-abort"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-menu"]')).toBeNull()
    mocks.pauseFlight.mockResolvedValue(manifest({ status: 'paused', pauseReason: 'user' }))
    await act(async () => { pause?.click() })
    expect(mocks.pauseFlight).toHaveBeenCalledWith('fl_1')
  })

  it('R74: the settled ⋯ menu is Delete-only — no Stop, no Start over, no Repeat a step', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', pauseReason: 'user' }))
    await render('fl_1')
    await openMenu()
    expect(container.querySelector('[data-testid="flight-abort"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-start-over"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-refly"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-delete"]')).toBeTruthy()
  })

  it('R74: a paused flight offers From here AND From a step… (→ dialog); no feedback → omitted', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', pauseReason: 'user', currentStage: 'docs' }))
    mocks.redoFlight.mockResolvedValue(manifest({ status: 'running' }))
    await render('fl_1')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })
    expect(container.querySelector('[data-testid="flight-resume"]')).toBeTruthy()
    // "From a step…" opens the centered dialog, then a pick + submit re-runs.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-open"]')?.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-scout"]')?.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-submit"]')?.click() })
    expect(mocks.redoFlight).toHaveBeenCalledWith('fl_1', { fromStage: 'scout', feedback: undefined })
  })

  it('R71/W1: the breadcrumb goes back to the picker; Escape closes to the workspace', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'running' }))
    const onSelectFlight = vi.fn()
    const onClose = vi.fn()
    await render('fl_1', { onSelectFlight, onClose })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-breadcrumb"]')?.click() })
    expect(onSelectFlight).toHaveBeenCalledWith(null)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalled()
  })

  it('R71/W1: Escape closes an open dialog first — the page only exits once nothing else is open', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done' }))
    const onClose = vi.fn()
    await render('fl_1', { onClose })
    // Open the centered re-run dialog over the flight page.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })
    expect(container.querySelector('[data-testid="flight-redo-scout"]')).toBeTruthy()
    // First Escape dismisses the dialog, NOT the page.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[data-testid="flight-redo-scout"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // Second Escape now exits the page.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalled()
  })

  it('R74/W1: Escape closes the open Continue menu first, not the page', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', pauseReason: 'user' }))
    const onClose = vi.fn()
    await render('fl_1', { onClose })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })
    expect(container.querySelector('[data-testid="flight-redo-open"]')).toBeTruthy()
    // First Escape closes the dropdown, not the page.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[data-testid="flight-redo-open"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // Second Escape exits the page.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalled()
  })

  it('R71/W1: a parked flight leads with Respond → (primary); clicking returns selection to the parked stage', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'waiting-for-approval',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'docs' ? ('waiting-for-approval' as const) : key === 'similarity' ? ('done' as const) : ('pending' as const),
        ...(key === 'docs' ? { checkpoint: { kind: 'prd-source', message: 'Docs?', options: ['continue', 'retry'] } } : {}),
      })),
    }))
    await render('fl_1')
    // Park the selection elsewhere first, then Respond → returns to the ask
    // (the prd-source ask renders as the RequirementsFork, R74).
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click() })
    expect(container.querySelector('[data-testid="requirements-fork"]')).toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-primary-respond"]')?.click() })
    expect(container.querySelector('[data-testid="requirements-fork"]')).toBeTruthy()
  })

  it('R71/W1: a rejected control action surfaces on the inline error line, not silently', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', pauseReason: 'user' }))
    mocks.resumeFlight.mockRejectedValue(new Error('server unreachable'))
    await render('fl_1')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-resume"]')?.click() })
    expect(container.querySelector('[data-testid="flight-action-error"]')?.textContent).toContain('server unreachable')
  })
})

describe('rail follow mode (R71/W2)', () => {
  const runningStages = () => FLIGHT_STAGE_KEYS.map((key) => ({
    key,
    status: key === 'scout' ? ('running' as const) : ('pending' as const),
  }))

  it('a manual rail pick parks follow-mode and shows Resume following; the chip restores auto-select', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ stages: runningStages() }))
    await render('fl_1')
    // Following by default: the auto-picked stage is the running scout.
    expect(container.querySelector('[data-testid="rail-following"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="stage-rail-scout"]')?.getAttribute('aria-current')).toBe('true')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click() })
    expect(container.querySelector('[data-testid="rail-following"]')).toBeNull()
    expect(container.querySelector('[data-testid="stage-rail-run"]')?.getAttribute('aria-current')).toBe('true')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="rail-resume-follow"]')?.click() })
    expect(container.querySelector('[data-testid="rail-following"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="stage-rail-scout"]')?.getAttribute('aria-current')).toBe('true')
  })

  it('switching flights resets a parked selection back to follow-mode', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ stages: runningStages() }))
    // Fixed key: the component must survive the flightId change WITHOUT a
    // remount — the reset effect is what's under test.
    await act(async () => {
      root.render(
        <InvalidationProvider>
          <FlightPage key="fixed" flightId="fl_1" onSelectFlight={vi.fn()} onClose={vi.fn()} />
        </InvalidationProvider>,
      )
    })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click() })
    expect(container.querySelector('[data-testid="rail-resume-follow"]')).toBeTruthy()
    mocks.getFlight.mockResolvedValue(manifest({ flightId: 'fl_2', stages: runningStages() }))
    await act(async () => {
      root.render(
        <InvalidationProvider>
          <FlightPage key="fixed" flightId="fl_2" onSelectFlight={vi.fn()} onClose={vi.fn()} />
        </InvalidationProvider>,
      )
    })
    expect(container.querySelector('[data-testid="rail-following"]')).toBeTruthy()
  })

  it('rail and stage-header tooltips speak the STAGE_BLURB, not internal keys', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ stages: runningStages() }))
    await render('fl_1')
    const title = container.querySelector('[data-testid="stage-rail-scout"]')?.getAttribute('title')
    expect(title).toContain('Scans your repo')
    expect(title).not.toBe('scout')
  })
})
