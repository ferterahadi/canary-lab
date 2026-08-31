// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightManifest, FlightStageKey } from '@/shared/api/client'
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
  requestFlightTakeover: vi.fn(),
  forceFlightTakeover: vi.fn(),
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
  requestFlightTakeover: mocks.requestFlightTakeover,
  forceFlightTakeover: mocks.forceFlightTakeover,
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
  AgentSessionView: ({ source, systemRows, externalSessions }: {
    source?: { kind: string; stage?: string }
    systemRows?: { pre: string[]; post: string[] }
    externalSessions?: Array<{ message: string; status: string }>
  }) => (
    <div data-testid="agent-session-view" data-kind={source?.kind} data-stage={source?.stage}>
      {externalSessions?.map((session, index) => (
        <div key={index} data-testid="external-session-activity" data-status={session.status}>{session.message}</div>
      ))}
      {systemRows?.pre.map((l, i) => <div key={`pre-${i}`} data-testid="system-pre">{l}</div>)}
      {systemRows?.post.map((l, i) => <div key={`post-${i}`} data-testid="system-post">{l}</div>)}
    </div>
  ),
}))

// The export stage reads the download action + task lookups from the export
// context; the provider needs live sockets, so stub the hook.
vi.mock('@/features/evaluation/state/EvaluationExportContext', () => ({
  useEvaluationExportLog: () => ({ log: '', watchTask: () => {} }),
  useEvaluationExportLogs: () => ({}),
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

// TestRunPanel reads the run detail + the run index off the shared runs store
// (useRun/useRuns); the real provider needs live sockets, so stub the two hooks
// over the SAME api mocks the panel-local fetches used to consume — fixtures
// keep working unchanged.
vi.mock('@/features/runs/state/RunsContext', async () => {
  const React = await import('react')
  return {
    useRun: (runId?: string | null) => {
      const [detail, setDetail] = React.useState<unknown>(undefined)
      React.useEffect(() => {
        let alive = true
        if (runId) mocks.getRunDetail(runId).then((d: unknown) => { if (alive) setDetail(d) }).catch(() => {})
        return () => { alive = false }
      }, [runId])
      return { detail, status: undefined, transient: null, displayStatus: undefined, error: null }
    },
    useRuns: () => {
      const [runs, setRuns] = React.useState<unknown[]>([])
      React.useEffect(() => {
        let alive = true
        mocks.listRuns({}).then((r: unknown[]) => { if (alive) setRuns(r) }).catch(() => {})
        return () => { alive = false }
      }, [])
      return {
        runs,
        connection: 'live',
        transients: {},
        errors: {},
        refresh: vi.fn(),
        startRun: vi.fn(),
        startVerification: vi.fn(),
        abort: vi.fn(),
        delete: vi.fn(),
        pauseHeal: vi.fn(),
        cancelHeal: vi.fn(),
        clearError: vi.fn(),
      }
    },
  }
})

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

  it('names Test run as the next resumed step before pending Parallel setup', async () => {
    const done = new Set<FlightStageKey>([
      'similarity', 'scout', 'scaffold', 'env-capture', 'docs', 'prd-summary', 'specs-coverage',
    ])
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'paused',
      pauseReason: 'user',
      currentStage: 'specs-coverage',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: done.has(key) ? ('done' as const) : ('pending' as const),
      })),
    }))
    await render('fl_1')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })
    expect(container.querySelector('[data-testid="flight-resume"]')?.textContent).toContain('Resume at Test run')
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

  it('an external-work hand-off reads as running work with takeover replacing Respond and Pause', async () => {
    // The step is being done inside the client that started the flight — there
    // is nothing here for this reader to answer, and nothing this side can stop.
    // A hand-off only ever parks on an EXTERNAL flight, so the fixture carries
    // the producer too: setting the checkpoint kind alone builds a state that
    // cannot occur, and it was hiding which of the two the page keys off.
    mocks.getFlight.mockResolvedValue(manifest({
      opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' },
      status: 'waiting-for-approval',
      currentStage: 'scout',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'scout' ? ('waiting-for-approval' as const) : ('pending' as const),
        ...(key === 'scout' ? { checkpoint: { kind: 'external-work', message: 'Run this scout step in your own client.', options: ['submit', 'run-internally'] } } : {}),
      })),
    }))
    const onStartFlight = vi.fn()
    await render('fl_1', { onStartFlight })
    const chip = container.querySelector<HTMLElement>('[data-testid="flight-status"]')
    expect(chip?.textContent).toContain('Running in your agent')
    expect(chip?.getAttribute('title')).toBe('Your agent is working on this step. Canary will continue when it finishes.')
    expect(container.querySelector('[data-testid="flight-primary-respond"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-pause"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-request-takeover"]')).toBeTruthy()
    const changeInputs = container.querySelector<HTMLButtonElement>('[data-testid="flight-inputs-change"]')
    const autopilot = container.querySelector<HTMLButtonElement>('[data-testid="flight-autopilot-toggle"]')
    expect(changeInputs?.disabled).toBe(true)
    expect(changeInputs?.title).toContain('from the Claude/Codex session')
    expect(autopilot?.disabled).toBe(true)
    expect(autopilot?.title).toContain('from the Claude/Codex session')
    expect(container.querySelector('[data-testid="external-session-activity"]')?.textContent)
      .toBe('Work is continuing in your external agent session.')
    expect(container.querySelector('[data-testid="agent-session-view"]')?.getAttribute('data-kind')).toBeNull()
    await act(async () => { changeInputs?.click() })
    expect(onStartFlight).not.toHaveBeenCalled()
  })

  it('a real checkpoint on the same status keeps Respond and a live Pause', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'waiting-for-approval',
      currentStage: 'env-capture',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'env-capture' ? ('waiting-for-approval' as const) : ('pending' as const),
        ...(key === 'env-capture' ? { checkpoint: { kind: 'missing-env', message: 'Keys?', options: ['retry', 'waive'] } } : {}),
      })),
    }))
    await render('fl_1')
    expect(container.querySelector<HTMLElement>('[data-testid="flight-status"]')?.textContent).toContain('Needs approval')
    expect(container.querySelector('[data-testid="flight-primary-respond"]')).toBeTruthy()
    expect(container.querySelector<HTMLButtonElement>('[data-testid="flight-pause"]')?.disabled).toBe(false)
  })

  // Read-only under external drive: the whole page, not just the parked step.
  // The narrower hand-off rule left every real question — and every pause —
  // still offering the human controls that belong to the agent.
  describe('externally driven', () => {
    const external = (over: Record<string, unknown> = {}) => manifest({
      opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' },
      ...over,
    })

    it('keeps Respond → on a real question but disables it with the mutation destination', async () => {
      mocks.getFlight.mockResolvedValue(external({
        status: 'waiting-for-approval',
        currentStage: 'env-capture',
        stages: FLIGHT_STAGE_KEYS.map((key) => ({
          key,
          status: key === 'env-capture' ? ('waiting-for-approval' as const) : ('pending' as const),
          ...(key === 'env-capture' ? { checkpoint: { kind: 'missing-env', message: 'Keys?', options: ['retry', 'waive'] } } : {}),
        })),
      }))
      await render('fl_1')
      const respond = container.querySelector<HTMLButtonElement>('[data-testid="flight-primary-respond"]')
      expect(respond?.disabled).toBe(true)
      expect(respond?.title).toContain('from the Claude/Codex session')
      expect(container.querySelector('[data-testid="flight-externally-driven"]')).toBeNull()
      // The chip stops calling active work a demand.
      expect(container.querySelector('[data-testid="flight-status"]')?.textContent).not.toContain('Needs approval')
    })

    it('leaves Pause and the checkpoint answers inert, each saying where they moved', async () => {
      mocks.getFlight.mockResolvedValue(external({
        status: 'waiting-for-approval',
        currentStage: 'env-capture',
        stages: FLIGHT_STAGE_KEYS.map((key) => ({
          key,
          status: key === 'env-capture' ? ('waiting-for-approval' as const) : ('pending' as const),
          ...(key === 'env-capture' ? { checkpoint: { kind: 'missing-env', message: 'Keys?', options: ['retry', 'waive'] } } : {}),
        })),
      }))
      await render('fl_1')
      const pause = container.querySelector<HTMLButtonElement>('[data-testid="flight-pause"]')
      expect(pause?.disabled).toBe(true)
      expect(pause?.title).toBe('Your agent is driving this flight — pause this work from the Claude/Codex session doing the work.')
      await act(async () => {
        pause?.parentElement?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      })
      expect(document.body.querySelector('[role="tooltip"]')?.textContent)
        .toBe('Your agent is driving this flight — pause this work from the Claude/Codex session doing the work.')
      await act(async () => { pause?.click() })
      expect(mocks.pauseFlight).not.toHaveBeenCalled()
      // Same answer surface as an internal flight, now inert.
      const retry = container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-choice-retry"]')
      const values = container.querySelector<HTMLTextAreaElement>('[data-testid="checkpoint-env-values"]')
      const submit = container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-submit-values"]')
      expect(retry?.disabled).toBe(true)
      expect(values?.disabled).toBe(true)
      expect(submit?.disabled).toBe(true)
      expect(retry?.title).toContain('from the Claude/Codex session')
      expect(container.querySelector('[data-testid="checkpoint-read-only"]')).toBeNull()
    })

    it('disables Continue and Delete on a paused flight without adding an external-only action', async () => {
      mocks.getFlight.mockResolvedValue(external({ status: 'paused', pauseReason: 'stage-failed' }))
      await render('fl_1')
      const cont = container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')
      expect(cont?.disabled).toBe(true)
      expect(cont?.title).toBe('Your agent is driving this flight — continue or repeat this flight from the Claude/Codex session doing the work.')
      await openMenu()
      expect(container.querySelector('[data-testid="flight-abort"]')).toBeNull()
      const deleteButton = container.querySelector<HTMLButtonElement>('[data-testid="flight-delete"]')
      expect(deleteButton?.disabled).toBe(true)
      expect(deleteButton?.title).toContain('from the Claude/Codex session')
    })

    it('hands the page back once the flight settles — the agent is gone', async () => {
      mocks.getFlight.mockResolvedValue(external({ status: 'done' }))
      await render('fl_1')
      expect(container.querySelector('[data-testid="flight-externally-driven"]')).toBeNull()
      expect(container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.disabled).toBe(false)
    })
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
    expect(title).toContain('Reads your repo')
    expect(title).not.toBe('scout')
  })
})
