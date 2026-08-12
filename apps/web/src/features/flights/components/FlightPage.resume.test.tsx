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
  loadPortify: vi.fn(async () => {}),
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

describe('FlightPage', () => {
  it('R74: Continue on a settled flight opens the centered re-run dialog; invalid steps are disabled with the reason', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done' }))
    mocks.redoFlight.mockResolvedValue(manifest({ status: 'running' }))
    mocks.getFlightEntryOptions.mockResolvedValue({
      feature: 'checkout',
      flight: null,
      active: false,
      canContinue: false,
      prefill: { repoPaths: ['/repo/shop'], description: 'checkout flow', env: 'local', coverageTarget: 100 },
      stages: FLIGHT_STAGE_KEYS.map((key) => (
        key === 'run' ? { key, allowed: false, reason: 'no specs authored yet' } : { key, allowed: true }
      )),
    })
    await render('fl_1')
    // done → no small menu; the button goes straight to the dialog.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })
    expect(container.querySelector('[data-testid="flight-resume"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-redo-scout"]')?.textContent).toContain('Repo scan')
    // Server-invalid step: disabled, with the validator's reason on the row.
    const runRow = container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-run"]')!
    expect(runRow.disabled).toBe(true)
    expect(runRow.textContent).toContain('no specs authored yet')
    // Nothing selected yet → the primary is disabled.
    expect(container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-submit"]')?.disabled).toBe(true)
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-docs"]')?.click() })
    const note = container.querySelector<HTMLTextAreaElement>('[data-testid="flight-redo-feedback"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(note, 'collected the wrong docs — focus on OAuth')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-submit"]')?.click() })
    expect(mocks.redoFlight).toHaveBeenCalledWith('fl_1', {
      fromStage: 'docs',
      feedback: 'collected the wrong docs — focus on OAuth',
    })

    // running → no Continue anywhere.
    mocks.getFlight.mockResolvedValue(manifest({ status: 'running' }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="flight-continue"]')).toBeNull()
  })

  it('R76: the re-run dialog LEADS with Start fresh (it re-enters before step 1) and hands off in fresh intent', async () => {
    const onStartFlight = vi.fn()
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done' }))
    mocks.getFlightEntryOptions.mockResolvedValue({
      feature: 'checkout',
      flight: null,
      active: false,
      canContinue: false,
      prefill: { repoPaths: ['/repo/shop'], description: 'checkout flow', env: 'local', coverageTarget: 100 },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, allowed: true })),
    })
    await render('fl_1', { onStartFlight })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })

    const fresh = container.querySelector('[data-testid="flight-redo-start-fresh"]')!
    const firstStage = container.querySelector('[data-testid="flight-redo-scout"]')!
    // Document order: fresh sits ABOVE Repo scan, the first pipeline step.
    expect(fresh.compareDocumentPosition(firstStage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Not a radio — it navigates to the launcher, it doesn't pick a step.
    expect(fresh.getAttribute('role')).toBeNull()
    expect(fresh.textContent).toContain('Start fresh — from the beginning')

    await act(async () => { (fresh as HTMLButtonElement).click() })
    expect(onStartFlight).toHaveBeenCalledWith('checkout', 'fresh')
  })

  it('paused resume card: an interrupted step points up to the header Continue, no button of its own', async () => {
    // The screenshot case — paused mid specs-coverage. The stage kept its
    // startedAt, so the state line reads "Stopped part way" and the card
    // fills the void the sentence alone used to leave behind.
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'paused',
      pauseReason: 'user',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: ['similarity', 'scout', 'scaffold', 'env-capture', 'docs', 'prd-summary'].includes(key)
          ? ('done' as const)
          : ('pending' as const),
        ...(key === 'specs-coverage' ? { startedAt: '2026-01-01T00:05:00Z' } : {}),
      })),
    }))
    await render('fl_1')
    const card = container.querySelector('[data-testid="stage-paused"]')!
    expect(card).toBeTruthy()
    expect(card.textContent).toContain('Paused part way')
    expect(card.textContent).toContain('↑Continue')
    // Recovery stays the header's one Continue — the card carries no button.
    expect(card.querySelector('button')).toBeNull()
    // The card agrees with the always-present state sentence, never contradicts it.
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent)
      .toBe('Stopped part way — Continue picks it up here.')
  })

  it('paused resume card: the entry step of a paused flight reads "before this step"', async () => {
    // Paused before specs-coverage ever started: earlier steps done, no
    // startedAt on this one → the not-started branch.
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'paused',
      pauseReason: 'user',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: ['similarity', 'scout', 'scaffold', 'env-capture', 'docs', 'prd-summary'].includes(key)
          ? ('done' as const)
          : ('pending' as const),
      })),
    }))
    await render('fl_1')
    const card = container.querySelector('[data-testid="stage-paused"]')!
    expect(card?.textContent).toContain('Paused before this step')
  })

  it('R82: pausing on the Test Run step KEEPS the run on screen — the pane never goes blank', async () => {
    // The "I lost my progress" report. Pausing flips the open row back to
    // `pending` (keeping its startedAt) but deliberately does NOT abort the run,
    // so the run and its evidence are still there — the old gate
    // (`row.status !== 'pending'`) unmounted the whole hero anyway and left the
    // resume card alone on an empty pane.
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-9',
      manifest: { runId: 'run-9', status: 'running', healCycles: 1 },
      summary: { complete: false, total: 23, passed: 2, failed: [{ name: 'otp guard', location: 'e2e/otp.spec.ts:9' }] },
    })
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'paused',
      pauseReason: 'user',
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'run' || key === 'heal' || key === 'evaluation-export'
          ? ('pending' as const)
          : ('done' as const),
        ...(key === 'run' ? { startedAt: '2026-01-01T00:05:00Z', evidence: { runId: 'run-9', healCycles: 1 } } : {}),
      })),
    }))
    await render('fl_1')
    const hero = container.querySelector('[data-testid="test-run-hero"]')
    expect(hero).toBeTruthy()
    expect(hero?.textContent).toContain('Run run-9')
    expect(hero?.textContent).toContain('2/23')
    expect(container.querySelector('[data-testid="run-hero-failing"]')?.textContent).toContain('otp guard')
    // The resume note is still there, but as ONE line above real evidence —
    // not a card filling a void, so it carries no PanelCard slab.
    const paused = container.querySelector('[data-testid="stage-paused"]')!
    expect(paused.textContent).toContain('Paused part way')
    expect(paused.textContent).toContain('↑Continue')
    expect(paused.querySelector('button')).toBeNull()
  })

  it('paused resume card: never on a running flight', async () => {
    // A running flight has an obvious in-progress narrative — no resume card,
    // even though the step carries a startedAt.
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'specs-coverage' ? ('running' as const) : ('pending' as const),
        ...(key === 'specs-coverage' ? { startedAt: '2026-01-01T00:05:00Z' } : {}),
      })),
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="stage-paused"]')).toBeNull()
  })

  it('mounts the agent timeline for agent-backed stages', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'scout' ? ('running' as const) : ('pending' as const),
      })),
    }))
    await render('fl_1')
    const asv = container.querySelector('[data-testid="agent-session-view"]')
    expect(asv?.getAttribute('data-stage')).toBe('scout')
  })

  it('locks Advanced setup while the flight is running, unlocks it when idle', async () => {
    const onOpenConfig = vi.fn()
    // Running: scaffold is approved (done) but the flight is still in the air —
    // the config is owned by the later stages, so setup is locked.
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'run' ? ('running' as const) : ('done' as const),
      })),
    }))
    await render('fl_1', { onOpenConfig })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-scaffold"]')?.click() })
    const running = container.querySelector<HTMLButtonElement>('[data-testid="feature-setup-advanced"]')
    expect(running?.disabled).toBe(true)
    await act(async () => { running?.click() })
    expect(onOpenConfig).not.toHaveBeenCalled()

    // Idle (done): the button re-enables and opens the config editor.
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const })),
    }))
    await render('fl_1', { onOpenConfig })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-scaffold"]')?.click() })
    const idle = container.querySelector<HTMLButtonElement>('[data-testid="feature-setup-advanced"]')
    expect(idle?.disabled).toBe(false)
    await act(async () => { idle?.click() })
    expect(onOpenConfig).toHaveBeenCalledWith('checkout')
  })

  it('a SKIPPED scaffold still reaches Advanced setup — the header action is the ONE route in', async () => {
    const onOpenConfig = vi.fn()
    mocks.getFeatureConfigDoc.mockResolvedValue({
      path: '/ws/features/checkout/feature.config.cjs',
      format: 'cjs',
      content: '',
      parsed: {
        value: { repos: [{ name: 'shop', localPath: '/repo/shop', branch: 'develop', startCommands: [{ name: 'api', command: 'npm run dev' }] }] },
        complexFields: [],
        source: '',
      },
    })
    // Scaffold skipped = the config already existed on disk. The setup panel
    // renders it, so the route into the full editor must be live.
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'scaffold' ? ('skipped' as const) : ('done' as const),
      })),
    }))
    await render('fl_1', { onOpenConfig })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-scaffold"]')?.click() })
    const header = container.querySelector<HTMLButtonElement>('[data-testid="feature-setup-advanced"]')
    expect(header?.disabled).toBe(false)
    await act(async () => { header?.click() })
    expect(onOpenConfig).toHaveBeenCalledWith('checkout')

    // The panel's own "Synced live with Advanced setup" footnote is gone: it
    // re-announced the header button a few pixels above it. The header action
    // stays the only way in, so a second one must not come back.
    expect(container.querySelector('[data-testid="setup-open-advanced"]')).toBeNull()
    expect(container.querySelector('[data-testid="feature-setup-panel"]')?.textContent).not.toContain('Synced live')
    expect(onOpenConfig).toHaveBeenCalledTimes(1)
  })
})
