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
  startFlight: vi.fn(),
  deleteFlight: vi.fn(),
  listRuns: vi.fn(),
  getEnvsetSlot: vi.fn(),
  getEnvsetsIndex: vi.fn(),
  startPortify: vi.fn(),
  loadPortify: vi.fn(async () => {}),
  portifyWorkflows: vi.fn((): Array<Record<string, unknown>> => []),
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
  getProjectConfig: vi.fn(),
  putProjectConfig: vi.fn(),
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
  startFlight: mocks.startFlight,
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
  getProjectConfig: mocks.getProjectConfig,
  putProjectConfig: mocks.putProjectConfig,
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
  AgentSessionView: ({ source, systemRows, externalSessions, empty }: {
    source?: { kind: string; stage?: string }
    systemRows?: { pre: string[]; post: string[] }
    externalSessions?: Array<{ message: string; status: string; clientKind: string }>
    empty?: { title: string }
  }) => (
    <div data-testid="agent-session-view" data-kind={source?.kind} data-stage={source?.stage} data-empty-title={empty?.title}>
      {externalSessions?.map((session, index) => (
        <div key={index} data-testid="external-session-activity" data-status={session.status} data-client={session.clientKind}>
          {session.message}
        </div>
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
  usePortify: () => ({
    workflows: mocks.portifyWorkflows(),
    startPortify: mocks.startPortify,
    loadPortify: mocks.loadPortify,
  }),
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
import { activityBar, isActivityOpen, toggleActivity } from './__fixtures__/activity-band'

;

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement

let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  mocks.startPortify.mockReset().mockResolvedValue('wf-direct')
  mocks.loadPortify.mockReset().mockResolvedValue(undefined)
  mocks.portifyWorkflows.mockReset().mockReturnValue([])
  mocks.portifyWorkflow.mockReset().mockReturnValue(undefined)
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
  mocks.getProjectConfig.mockResolvedValue({
    healAgent: 'claude',
    editor: 'auto',
    personalWikiPath: null,
    askModelsOnLaunch: false,
  })
  mocks.startFlight.mockResolvedValue(manifest({
    flightId: 'fl_started',
    feature: 'half-built',
    status: 'running',
    currentStage: 'specs-coverage',
  }))
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
// endpoint may receive that token. The adapted Continue menu starts by feature;
// record-only resume / redo / abort / delete / download calls remain forbidden.
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

  it('renders an external run from the live run stream without navigating', async () => {
    mocks.listRuns.mockResolvedValue([
      { runId: 'run-live', feature: 'go-smoke', status: 'running', startedAt: '2026-01-01T00:03:00Z', executionType: 'run' },
    ])
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-live',
      manifest: { runId: 'run-live', feature: 'go-smoke', status: 'running', healMode: 'external' },
      summary: { total: 2, passed: 1, failed: [] },
    })
    const onSelectFlight = vi.fn()
    const onSelectStage = vi.fn()
    await render('feature:go-smoke', {
      derivedStages: new Map([['go-smoke', allDone()]]),
      activity: new Map([['go-smoke', { kind: 'running' as const, runId: 'run-live', external: true }]]),
      stage: 'run',
      onSelectStage,
      onSelectFlight,
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="flight-status"]')?.textContent).toContain('Running')
    expect(container.querySelector('[data-testid="test-run"]')).not.toBeNull()
    expect(container.querySelector<HTMLButtonElement>('[data-testid="derived-conduct"]')?.disabled).toBe(true)
    const stop = container.querySelector<HTMLButtonElement>('[data-testid="run-stage-stop"]')
    expect(stop?.disabled).toBe(true)
    expect(stop?.title).toContain('from the Claude/Codex session')
    expect(container.querySelector('[data-testid="flight-external-suite-work"]')).toBeNull()
    expect(mocks.getRunDetail).toHaveBeenCalledWith('run-live')
    expect(onSelectFlight).not.toHaveBeenCalled()
    expect(onSelectStage).not.toHaveBeenCalled()
  })

  it('keeps both live run mutations visible but disabled during an external repair', async () => {
    mocks.listRuns.mockResolvedValue([
      { runId: 'run-heal', feature: 'go-smoke', status: 'healing', healMode: 'external', startedAt: '2026-01-01T00:03:00Z', executionType: 'run' },
    ])
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-heal',
      manifest: { runId: 'run-heal', feature: 'go-smoke', status: 'healing', healMode: 'external' },
      summary: { total: 2, passed: 1, failed: [{ name: 'fails' }] },
    })
    await render('feature:go-smoke', {
      derivedStages: new Map([['go-smoke', allDone()]]),
      activity: new Map([['go-smoke', { kind: 'healing' as const, runId: 'run-heal', external: true }]]),
      stage: 'run',
      onSelectStage: vi.fn(),
    })
    await act(async () => {})

    for (const id of ['run-stage-cancel-heal', 'run-stage-stop']) {
      const button = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
      expect(button?.disabled).toBe(true)
      expect(button?.title).toContain('from the Claude/Codex session')
    }
  })

  it('does not replace a stage the user selected when an external run starts', async () => {
    const onSelectFlight = vi.fn()
    const onSelectStage = vi.fn()
    await render('feature:go-smoke', {
      derivedStages: new Map([['go-smoke', allDone()]]),
      activity: new Map([['go-smoke', { kind: 'running' as const, runId: 'run-live', external: true }]]),
      stage: 'docs',
      onSelectStage,
      onSelectFlight,
    })

    expect(container.querySelector('[data-testid="stage-rail-run"]')?.querySelector('.cl-status-dot')).not.toBeNull()
    expect(container.querySelector('[data-testid="test-run"]')).toBeNull()
    expect(container.querySelector('[data-testid="stage-rail-docs"]')?.getAttribute('aria-current')).toBe('true')
    expect(onSelectFlight).not.toHaveBeenCalled()
    expect(onSelectStage).not.toHaveBeenCalled()
  })

  it('keeps every settled external authoring pass in the shared Activity rail', async () => {
    const first = {
      kind: 'authoring' as const,
      stage: 'specs-coverage' as const,
      resourceId: 'draft-1',
      status: 'done' as const,
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:03:00Z',
      itemCount: 1,
    }
    const latest = {
      kind: 'authoring' as const,
      stage: 'specs-coverage' as const,
      resourceId: 'draft-2',
      status: 'done' as const,
      startedAt: '2026-01-01T00:04:00Z',
      updatedAt: '2026-01-01T00:05:00Z',
      clientKind: 'claude',
      itemCount: 3,
    }
    await render('feature:go-smoke', {
      derivedStages: new Map([['go-smoke', allDone()]]),
      externalHistory: new Map([['go-smoke', {
        'specs-coverage': { traces: [first, latest], current: latest },
      }]]),
      stage: 'specs-coverage',
      onSelectStage: vi.fn(),
    })

    expect(activityBar(container)).toBeTruthy()
    act(() => { toggleActivity(container) })
    const external = container.querySelectorAll('[data-testid="external-session-activity"]')
    expect(external).toHaveLength(2)
    expect(external[0]?.textContent).toBe('Completed outside Canary Lab · 1 file applied.')
    expect(external[1]?.getAttribute('data-client')).toBe('claude')
    expect(external[1]?.getAttribute('data-status')).toBe('done')
    expect(external[1]?.textContent).toBe('Completed outside Canary Lab · 3 files applied.')
    expect(container.querySelector('[data-testid="agent-session-view"]')?.getAttribute('data-kind')).toBeNull()
  })

  it('keeps the Activity bar present before the first external coverage pass', async () => {
    await render('feature:go-smoke', {
      derivedStages: new Map([['go-smoke', allDone()]]),
      stage: 'specs-coverage',
      onSelectStage: vi.fn(),
    })

    expect(activityBar(container)).toBeTruthy()
    expect(isActivityOpen(container)).toBe(false)
    act(() => { toggleActivity(container) })
    expect(container.querySelector('[data-testid="agent-session-view"]')?.getAttribute('data-empty-title'))
      .toBe('No activity recorded')
    expect(container.querySelector('[data-testid="external-session-activity"]')).toBeNull()
  })

  it('shows completed external Parallel-readiness evidence without an entry refresh', async () => {
    const trace = {
      kind: 'portifying' as const,
      stage: 'portify' as const,
      resourceId: 'wf-live',
      status: 'done' as const,
      startedAt: '2026-08-25T00:00:00Z',
      updatedAt: '2026-08-25T00:05:00Z',
      clientKind: 'claude',
    }
    mocks.portifyWorkflow.mockReturnValue({
      workflowId: 'wf-live',
      feature: 'go-smoke',
      repos: [{ name: 'workflow-app' }],
      agent: 'claude',
      producer: 'external',
      branch: 'canary/portify',
      status: 'saved',
      attempt: 1,
      maxAttempts: 3,
      startedAt: '2026-08-25T00:00:00Z',
      endedAt: '2026-08-25T00:05:00Z',
      verification: {
        ok: true,
        instances: [
          { ok: true, ports: { web: 4001 } },
          { ok: true, ports: { web: 4002 } },
        ],
      },
      diff: ['# repo: workflow-app', '+++ b/server.ts', '+listen(process.env.PORT)'].join('\n'),
    })
    await render('feature:go-smoke', {
      // Deliberately no workflow evidence on the pseudo-stage: the task-scoped
      // Portify stream is the first completion signal, before the entry probe.
      derivedStages: new Map([['go-smoke', allDone()]]),
      externalHistory: new Map([['go-smoke', {
        portify: { traces: [trace], current: trace },
      }]]),
      stage: 'portify',
      onSelectStage: vi.fn(),
    })

    expect(mocks.portifyWorkflow).toHaveBeenCalledWith('wf-live')
    expect(container.querySelector('[data-testid="double-boot-panel"]')?.textContent).toContain(':4002')
    expect(container.querySelector('[data-testid="overlay-panel"]')?.textContent).toContain('server.ts')
  })

  it('opens a standalone internal Portify review inside the Flight stage', async () => {
    mocks.portifyWorkflow.mockReturnValue({
      workflowId: 'wf-review',
      feature: 'go-smoke',
      repos: [{ name: 'workflow-app', path: '/repo', worktreePath: '/worktree' }],
      agent: 'claude',
      branch: 'canary/portify',
      status: 'ready-to-save',
      attempt: 1,
      maxAttempts: 3,
      startedAt: '2026-08-25T00:00:00Z',
      verification: {
        ok: true,
        instances: [
          { ok: true, ports: { web: 4001 } },
          { ok: true, ports: { web: 4002 } },
        ],
      },
      diff: '+listen(process.env.PORT)',
    })
    await render('feature:go-smoke', {
      derivedStages: new Map([['go-smoke', allDone().map((entry) =>
        entry.key === 'portify' ? { ...entry, status: 'pending' as const } : entry,
      )]]),
      activity: new Map([['go-smoke', { kind: 'portifying', workflowId: 'wf-review' }]]),
      stage: 'portify',
      onSelectStage: vi.fn(),
    })

    expect(mocks.portifyWorkflow).toHaveBeenCalledWith('wf-review')
    expect(container.querySelector('[data-testid="portify-workflow-review"]')).not.toBeNull()
    expect(container.textContent).toContain('Review & save')
  })

  it('retains the latest terminal run in the derived Test run pane', async () => {
    const stages = allDone().map((stage) => stage.key === 'run'
      ? { ...stage, evidence: { runId: 'run-latest', status: 'passed' } }
      : stage)
    mocks.listRuns.mockResolvedValue([
      { runId: 'run-latest', feature: 'go-smoke', status: 'passed', startedAt: '2026-01-01T00:03:00Z', executionType: 'run' },
    ])
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-latest',
      manifest: { runId: 'run-latest', feature: 'go-smoke', status: 'passed' },
      summary: { total: 2, passed: 2, failed: [] },
    })
    await render('feature:go-smoke', {
      derivedStages: new Map([['go-smoke', stages]]),
      stage: 'run',
      onSelectStage: vi.fn(),
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="test-run"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="test-run-hero"]')?.textContent).toContain('2/2')
    expect(mocks.getRunDetail).toHaveBeenCalledWith('run-latest')
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

  it('uses the Continue menu and resumes directly from the first stage with no evidence', async () => {
    const onStartFlight = vi.fn()
    await render('feature:half-built', {
      derivedStages: new Map([['half-built', upToSpecs()]]),
      onStartFlight,
    })
    const primary = container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')!
    act(() => { primary.click() })
    expect(container.querySelector('[data-testid="flight-resume"]')?.textContent)
      .toContain('Resume at Tests & coverage')
    expect(container.querySelector('[data-testid="flight-redo-open"]')).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="flight-resume"]')?.click()
    })

    expect(onStartFlight).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="flight-start-submit"]')).toBeNull()
    expect(mocks.startFlight).toHaveBeenCalledWith({
      feature: 'half-built',
      repoPaths: ['/repo/shop'],
      description: 'checkout flow',
      env: 'local',
      coverageTarget: 100,
      fromStage: 'specs-coverage',
    })
  })

  it('opens the step picker only for From a step and carries its feedback into the direct start', async () => {
    await render('feature:half-built', { derivedStages: new Map([['half-built', upToSpecs()]]) })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-open"]')?.click() })
    expect(container.querySelector('[data-testid="flight-redo-submit"]')).not.toBeNull()
    expect(mocks.startFlight).not.toHaveBeenCalled()

    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-docs"]')?.click() })
    const feedback = container.querySelector<HTMLTextAreaElement>('[data-testid="flight-redo-feedback"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(feedback, 'requirements changed')
      feedback.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-submit"]')?.click()
    })

    expect(mocks.startFlight).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'half-built',
      fromStage: 'docs',
      feedback: 'requirements changed',
    }))
  })

  it('respects Ask before launch before a direct resume', async () => {
    mocks.getProjectConfig.mockResolvedValue({
      healAgent: 'codex',
      editor: 'auto',
      personalWikiPath: null,
      askModelsOnLaunch: true,
      agentModels: { codex: { gen: { model: 'gpt-5.6-sol', effort: 'high' } }, claude: {} },
    })
    await render('feature:half-built', { derivedStages: new Map([['half-built', upToSpecs()]]) })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="flight-resume"]')?.click()
    })

    expect(container.querySelector('[data-testid="model-launch-gate"]')).not.toBeNull()
    expect(mocks.startFlight).not.toHaveBeenCalled()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="gate-confirm"]')?.click()
    })
    expect(mocks.startFlight).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'half-built',
      fromStage: 'specs-coverage',
      agent: 'codex',
    }))
  })

  it('does not launch when it cannot verify Ask before launch', async () => {
    mocks.getProjectConfig.mockRejectedValue(new Error('settings unavailable'))
    await render('feature:half-built', { derivedStages: new Map([['half-built', upToSpecs()]]) })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="flight-resume"]')?.click()
    })

    expect(mocks.startFlight).not.toHaveBeenCalled()
    expect(container.textContent).toContain('settings unavailable')
  })

  it('starts Parallel setup directly, then restores the normal Flight action', async () => {
    mocks.loadPortify.mockImplementation(async (workflowId: string) => {
      mocks.portifyWorkflows.mockReturnValue([{
        workflowId,
        feature: 'half-built',
        status: 'editing',
        startedAt: '2026-08-30T10:00:00Z',
      }])
      mocks.portifyWorkflow.mockReturnValue({
        workflowId,
        feature: 'half-built',
        repos: [{ name: 'shop', path: '/repo/shop', worktreePath: '/worktree/shop' }],
        agent: 'claude',
        branch: 'canary/portify',
        status: 'editing',
        attempt: 1,
        maxAttempts: 3,
        startedAt: '2026-08-30T10:00:00Z',
      })
    })
    await render('feature:half-built', {
      derivedStages: new Map([['half-built', upToSpecs()]]),
      stage: 'portify',
      onSelectStage: vi.fn(),
      onStartFlight: vi.fn(),
    })

    const start = container.querySelector<HTMLButtonElement>('[data-testid="flight-run-parallel-setup"]')
    expect(start?.textContent).toBe('Run Parallel Setup')
    expect(container.querySelector('[data-testid="derived-conduct"]')).toBeNull()

    await act(async () => { start?.click() })

    expect(mocks.startPortify).toHaveBeenCalledWith({ feature: 'half-built' })
    expect(mocks.loadPortify).toHaveBeenCalledWith('wf-direct')
    expect(container.querySelector('[data-testid="flight-run-parallel-setup"]')).toBeNull()
    const continueButton = container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')
    expect(continueButton).not.toBeNull()
    act(() => { continueButton?.click() })
    expect(container.querySelector('[data-testid="flight-resume"]')?.textContent)
      .toContain('Resume at Tests & coverage')
    expect(container.querySelector('[data-testid="stage-rail-portify"]')?.textContent).toContain('Parallel setup')
    expect(container.querySelector('[data-testid="stage-rail-portify"] .cl-status-dot')).not.toBeNull()
    expect(container.querySelector('[data-testid="agent-session-view"]')?.getAttribute('data-kind')).toBe('portify')
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
