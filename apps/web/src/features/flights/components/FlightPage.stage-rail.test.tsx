// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightManifest, FlightStageKey } from '@/shared/api/client'
import type { EvaluationExportTask } from '@/shared/api/types'
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
  evaluationTasks: vi.fn((): EvaluationExportTask[] => []),
  evaluationLogs: vi.fn((): Record<string, string> => ({})),
  watchEvaluationTask: vi.fn(),
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
  AgentSessionView: ({ source, sessionSources, systemRows }: {
    source?: { kind: string; stage?: string }
    sessionSources?: Array<{ source: { kind: string; stage?: string; live?: boolean } }>
    systemRows?: { pre: string[]; post: string[] }
  }) => {
    const displayed = sessionSources?.find((session) => session.source.live)?.source
      ?? sessionSources?.at(-1)?.source
      ?? source
    return (
      <div data-testid="agent-session-view" data-kind={displayed?.kind} data-stage={displayed?.stage}>
        {systemRows?.pre.map((l, i) => <div key={`pre-${i}`} data-testid="system-pre">{l}</div>)}
        {systemRows?.post.map((l, i) => <div key={`post-${i}`} data-testid="system-post">{l}</div>)}
      </div>
    )
  },
}))

// The export stage reads the download action + task lookups from the export
// context; the provider needs live sockets, so stub the hook.
vi.mock('@/features/evaluation/state/EvaluationExportContext', () => ({
  useEvaluationExportLog: (taskId: string | null) => ({
    log: taskId ? mocks.evaluationLogs()[taskId] ?? '' : '',
    watchTask: mocks.watchEvaluationTask,
  }),
  useEvaluationExportLogs: () => mocks.evaluationLogs(),
  useEvaluationExports: () => ({
    tasks: mocks.evaluationTasks(),
    downloadTask: mocks.downloadTask,
    taskById: mocks.taskById,
    taskForRun: mocks.taskForRun,
    logsByTaskId: {},
    watchTask: mocks.watchEvaluationTask,
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
import { isActivityOpen, toggleActivity } from './__fixtures__/activity-band'

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
  mocks.evaluationTasks.mockReturnValue([])
  mocks.evaluationLogs.mockReturnValue({})
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
  it('R20: a live agent stage shows the timeline; a settled one answers with facts', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      currentStage: 'prd-summary',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'prd-summary' ? ('running' as const) : key === 'similarity' || key === 'scout' || key === 'scaffold' || key === 'env-capture' || key === 'docs' ? ('done' as const) : ('pending' as const),
        ...(key === 'prd-summary' ? {} : {}),
      })),
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="agent-session-view"]')?.getAttribute('data-stage')).toBe('prd-summary')

    // Settled: the timeline moves behind View details.
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'prd-summary' ? { evidence: { requirementCount: 5 } } : {}),
      })),
    }))
    await render('fl_1')
    await act(async () => {
      // R33: prd-summary folds into the Requirements (docs) row.
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-docs"]')?.click()
    })
    expect(container.querySelector('[data-testid="stage-facts"]')?.textContent).toContain('5')
    expect(container.querySelector('[data-testid="agent-session-view"]')).toBeNull()
    await act(async () => { toggleActivity(container) })
    expect(container.querySelector('[data-testid="agent-session-view"]')?.getAttribute('data-stage')).toBe('prd-summary')
  })

  // A stage drill-through (coverage ledger, run detail) REPLACES the flight
  // view, so the way back remounts this page. With the pick local to the detail
  // that remount re-ran the auto-pick and dropped the user on the foreground
  // Report instead of the one they drilled from. App owns
  // the pick now and routes it (?stage=…); this pins both halves.
  it('the stage pick is owned above the page, so a drill-through round trip comes back to it', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const })),
    }))
    const onSelectStage = vi.fn()
    await render('fl_1', { stage: null, onSelectStage })
    // Follow-mode: Report remains the foreground deliverable even though
    // Parallel setup is the final persisted row.
    expect(container.querySelector('[data-testid="stage-rail-evaluation-export"]')?.getAttribute('aria-current')).toBe('true')
    const railIds = [...container.querySelectorAll<HTMLElement>('[data-testid^="stage-rail-"]')]
      .map((row) => row.dataset.testid)
    expect(railIds.indexOf('stage-rail-evaluation-export'))
      .toBeLessThan(railIds.indexOf('stage-rail-portify'))
    const report = container.querySelector('[data-testid="stage-rail-evaluation-export"]')
    const divider = container.querySelector('[data-testid="parallel-setup-divider"]')
    const parallelSetup = container.querySelector('[data-testid="stage-rail-portify"]')
    expect(divider?.textContent).toContain('Independent')
    expect(report?.nextElementSibling).toBe(divider)
    expect(divider?.nextElementSibling).toBe(parallelSetup)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-specs-coverage"]')?.click()
    })
    expect(onSelectStage).toHaveBeenCalledWith('specs-coverage')

    // The way back from the ledger: a fresh mount carrying the routed stage.
    await render('fl_1', { stage: 'specs-coverage', onSelectStage })
    expect(container.querySelector('[data-testid="stage-rail-specs-coverage"]')?.getAttribute('aria-current')).toBe('true')
    expect(container.querySelector('[data-testid="stage-rail-evaluation-export"]')?.getAttribute('aria-current')).toBeNull()
    // The follow-mode reset must fire on a flight CHANGE, never on a mount —
    // clearing here is exactly what threw the pick away.
    expect(onSelectStage).not.toHaveBeenCalledWith(null)
  })

  it('keeps the completed Report in front while final Parallel setup runs in the rail', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      currentStage: 'portify',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'portify' ? ('running' as const) : ('done' as const),
      })),
    }))

    await render('fl_1')

    expect(container.querySelector('[data-testid="stage-rail-evaluation-export"]')?.getAttribute('aria-current')).toBe('true')
    expect(container.querySelector('[data-testid="stage-rail-portify"]')?.textContent).toContain('Parallel setup')
  })

  it('keeps Parallel readiness Activity open after switching to another stage and back', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'portify' ? { evidence: { workflowId: 'portify-demo' } } : {}),
      })),
    }))
    function RoutedFlight() {
      const [stage, setStage] = useState<FlightStageKey | null>(null)
      return <FlightPage flightId="fl_1" onSelectFlight={vi.fn()} onClose={vi.fn()} stage={stage} onSelectStage={setStage} />
    }
    await act(async () => {
      root.render(
        <InvalidationProvider>
          <RoutedFlight />
        </InvalidationProvider>,
      )
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-portify"]')?.click()
    })
    expect(isActivityOpen(container)).toBe(false)
    await act(async () => { toggleActivity(container) })
    expect(isActivityOpen(container)).toBe(true)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-specs-coverage"]')?.click()
    })
    expect(isActivityOpen(container)).toBe(false)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-portify"]')?.click()
    })
    expect(isActivityOpen(container)).toBe(true)
    expect(container.querySelector('[data-testid="agent-session-view"]')).not.toBeNull()
  })

  it('a different flight drops the previous one’s stage pick', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const })),
    }))
    const onSelectStage = vi.fn()
    // One mount, two flight ids — the prop change FlightDetail sees when the
    // derived→real redirect or a picker jump switches flights under it.
    await act(async () => {
      root.render(
        <InvalidationProvider>
          <FlightPage flightId="fl_1" onSelectFlight={vi.fn()} onClose={vi.fn()} stage="specs-coverage" onSelectStage={onSelectStage} />
        </InvalidationProvider>,
      )
    })
    expect(onSelectStage).not.toHaveBeenCalled()
    await act(async () => {
      root.render(
        <InvalidationProvider>
          <FlightPage flightId="fl_2" onSelectFlight={vi.fn()} onClose={vi.fn()} stage="specs-coverage" onSelectStage={onSelectStage} />
        </InvalidationProvider>,
      )
    })
    expect(onSelectStage).toHaveBeenCalledWith(null)
  })

  it('R32: Feature setup absorbs env-capture — merged facts, boot proof, config digest', async () => {
    mocks.getFeatureConfigDoc.mockResolvedValue({
      path: '/ws/features/checkout/feature.config.cjs',
      format: 'cjs',
      content: '',
      parsed: {
        value: {
          repos: [{
            name: 'shop',
            localPath: '/repo/shop',
            branch: 'develop',
            startCommands: [{ name: 'api', command: 'npm run dev', ports: [{ name: 'api', env: 'PORT' }] }],
          }],
        },
        complexFields: [],
        source: '',
      },
    })
    mocks.getPlaywrightConfig.mockResolvedValue({
      path: '/ws/features/checkout/playwright.config.ts',
      format: 'ts',
      content: '',
      parsed: { value: { workers: 2, retries: 1, use: { video: 'on' } }, complexFields: [], source: '' },
    })
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'scaffold' ? { evidence: { featureDir: '/ws/features/checkout' } } : {}),
        ...(key === 'env-capture' ? { evidence: { captured: 2, boot: { services: [{ name: 'api', status: 'healthy' }] } } } : {}),
      })),
    }))
    await render('fl_1', { onOpenConfig: vi.fn() })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-scaffold"]')?.click()
    })
    // Pair-settled state line speaks the whole step.
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent)
      .toBe('Suite "checkout" created — settings copied (2 files), the app started fine.')
    const facts = container.querySelector('[data-testid="stage-facts"]')?.textContent ?? ''
    // The band reports the boot PROOF, not the config it booted with: the suite
    // name, the reuse verb and the env FILE count already read in the state line
    // above, and the worker count / service list are editable inputs on the
    // cards below. A tile restating either measures nothing.
    expect(facts).toContain('Services booted')
    expect(facts).toContain('1/1')
    expect(facts).not.toContain('Location')
    expect(facts).not.toContain('/ws/features/checkout')
    // Boot proof directly under the band it summarizes, BEFORE the config
    // digest: "Services booted 2/2" and these rows are one block, and the
    // editable config in between separated a number from its own evidence.
    const blocks = [...container.querySelectorAll('[data-testid="stage-facts-card"],[data-testid="boot-check-panel"],[data-testid="feature-setup-panel"]')]
      .map((el) => el.getAttribute('data-testid'))
    expect(blocks).toEqual(['stage-facts-card', 'boot-check-panel', 'feature-setup-panel'])
    // The facts sit on the SAME card surface as the panels below them (one
    // stack of like blocks) — not bare above the first card.
    const factsCard = container.querySelector('[data-testid="stage-facts-card"]')
    expect(factsCard?.textContent).toContain('At a glance')
    expect(factsCard?.contains(container.querySelector('[data-testid="stage-facts"]'))).toBe(true)
    // R43: the setup panel — a block per config REPO, mirroring the Advanced
    // setup Service tab (Name ↔ NAME, Branch picker ↔ BRANCH, Start command ↔
    // RUNTIME COMMAND). Read-only until the block's pencil arms it.
    // Port slots do NOT surface here — ports are Parallel readiness' concept.
    const panel = container.querySelector('[data-testid="feature-setup-panel"]')
    expect(panel).toBeTruthy()
    // Scaffold is approved (done) → the Advanced setup header action shows.
    expect(container.querySelector('[data-testid="feature-setup-advanced"]')).toBeTruthy()
    expect(panel?.textContent).toContain('shop')
    expect(panel?.textContent).toContain('/repo/shop')
    expect(panel?.textContent).toContain('develop')
    expect(panel?.textContent).toContain('npm run dev')
    expect(panel?.textContent).not.toContain('api → PORT')
    expect(panel?.querySelector('[data-testid="setup-command-api"]')).toBeNull()
    await act(async () => {
      panel?.querySelector<HTMLButtonElement>('[data-testid="setup-edit-shop"]')?.click()
    })
    const commandInput = panel?.querySelector<HTMLInputElement>('[data-testid="setup-command-api"]')
    expect(commandInput?.value).toBe('npm run dev')
    expect(panel?.querySelector<HTMLInputElement>('[data-testid="setup-service-name-shop"]')?.value).toBe('shop')
    // The branch field is the SAME picker Advanced setup renders — and opening
    // it shows the FULL local+remote list, not just entries matching the
    // current value; typing after focus is what filters.
    const branchInput = panel?.querySelector<HTMLInputElement>('[data-testid="setup-branch-shop"]')
    expect(branchInput?.value).toBe('develop')
    expect(mocks.getRepoGitStatus).toHaveBeenCalledWith('checkout', 'shop')
    await act(async () => {
      branchInput!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    const suggestions = [...container.querySelectorAll('button')].map((b) => b.textContent)
    expect(suggestions).toContain('main')
    expect(suggestions).toContain('origin/main')
    expect(suggestions).toContain('origin/develop')
    expect(panel?.querySelector<HTMLInputElement>('[data-testid="setup-pw-workers"]')?.value).toBe('2')
    expect(panel?.querySelector<HTMLSelectElement>('[data-testid="setup-pw-video"]')?.value).toBe('on')
    // Screenshot renders Playwright's real default when the config omits it.
    expect(panel?.querySelector<HTMLSelectElement>('[data-testid="setup-pw-screenshot"]')?.value).toBe('off')
    // An edit writes through to the SAME on-disk doc Advanced setup edits.
    mocks.putFeatureConfigDoc.mockResolvedValue({})
    await act(async () => {
      // Drive the CONTROLLED input the way React sees it: native setter + input
      // event (React dedupes plain .value writes), then focusout for onBlur.
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setValue.call(commandInput, 'npm run start')
      commandInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      commandInput!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(mocks.putFeatureConfigDoc).toHaveBeenCalledTimes(1)
    const [featureArg, valueArg] = mocks.putFeatureConfigDoc.mock.calls[0] as [string, { repos: Array<{ startCommands: Array<{ command: string }> }> }]
    expect(featureArg).toBe('checkout')
    expect(valueArg.repos[0].startCommands[0].command).toBe('npm run start')
  })

  it('R32: the folded env-capture checkpoint surfaces on the Feature setup row', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'waiting-for-approval',
      currentStage: 'env-capture',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'env-capture'
          ? ('waiting-for-approval' as const)
          : key === 'similarity' || key === 'scout' || key === 'scaffold'
            ? ('done' as const)
            : ('pending' as const),
        ...(key === 'env-capture'
          ? { checkpoint: { kind: 'missing-env' as const, message: 'Provide values', options: ['retry', 'waive'], data: { missing: ['API_KEY'] } } }
          : {}),
      })),
    }))
    await render('fl_1')
    // The merged scaffold row carries the waiting state and the checkpoint UI.
    expect(container.querySelector('[data-testid="stage-rail-env-capture"]')).toBeNull()
    expect(container.querySelector('[data-testid="checkpoint-controls"]')?.textContent).toContain('Provide values')
    expect(container.querySelector('[data-testid="checkpoint-env-values"]')).toBeTruthy()
  })

  it('R31/R33: repo-scan facts list the repos; Requirements facts list the docs', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      repoPaths: ['/repo/shop', '/repo/api'],
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'scout' ? { evidence: { configSource: 'module.exports = {}', envFiles: ['/repo/shop/.env'] } } : {}),
        ...(key === 'docs' ? { evidence: { source: 'repo-docs', docs: ['shop-readme.md', 'api-spec.md'] } } : {}),
        ...(key === 'prd-summary' ? { evidence: { requirementCount: 7 } } : {}),
      })),
    }))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-scout"]')?.click()
    })
    // R72c: the intent card is distinct from the rearranged repo evidence.
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent)
      .toBe('Scanned 2 repos — setup drafted, 1 settings file found.')
    expect(container.querySelector('[data-testid="flight-intent-card"]')?.textContent).toContain('Flight input')
    expect(container.querySelector('[data-testid="flight-intent-card"]')?.textContent).toContain('Intent · what to test')
    expect(container.querySelector('[data-testid="flight-intent"]')?.textContent).toContain('checkout flow')
    expect(container.querySelector('[data-testid="repo-scan-output"]')).toBeNull()
    const intentCard = container.querySelector<HTMLElement>('[data-testid="flight-intent-card"]')
    const repoScanCard = container.querySelector<HTMLElement>('[data-testid="repo-scan-card"]')
    expect(repoScanCard?.textContent).toContain('Repos · 2 scanned')
    expect(repoScanCard?.className).toBe(intentCard?.className)
    // R73: the panel fills the shared STAGE_COLUMN so the repo cards and a
    // failed stage's error card line up as one column (no shrink-wrap
    // asymmetry).
    expect(container.querySelector('[data-testid="repo-scan-panel"]')?.className).toContain('max-w-[92ch]')
    const shopCard = container.querySelector('[data-testid="repo-card-shop"]')?.textContent ?? ''
    expect(shopCard).toContain('/repo/shop')
    expect(shopCard).toContain('.env')
    const apiCard = container.querySelector('[data-testid="repo-card-api"]')?.textContent ?? ''
    expect(apiCard).toContain('/repo/api')
    expect(apiCard).not.toContain('.env')
    // The scan's band counts what it FOUND; the identities behind each count
    // stay on the repo cards above, so neither repeats the other.
    const scoutFacts = container.querySelector('[data-testid="stage-facts"]')?.textContent ?? ''
    expect(scoutFacts).toContain('Repos scanned')
    // No env-file tile: the declared list reads in the state line, and the
    // number that matters (captured against declared) is Suite setup's.
    expect(scoutFacts).not.toContain('Env files')
    expect(scoutFacts).not.toContain('/repo/shop')
    expect(container.querySelector('header')?.textContent).not.toContain('/repo/shop')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-docs"]')?.click()
    })
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent)
      .toBe('7 requirements written from 2 docs (found in the repos).')
    // R59: the folded prd-summary's status chips the Requirements header.
    expect(container.querySelector('[data-testid="docs-summary-chip"]')?.textContent).toContain('Done')
    // Counts, not filenames. The band used to spend one tile per doc printing
    // the same names the Requirement docs card lists below — with their sizes —
    // so it was a worse copy of that card. It now reports the shape of the work.
    const docsFacts = container.querySelector('[data-testid="stage-facts"]')?.textContent ?? ''
    expect(docsFacts).toContain('Requirements inferred')
    expect(docsFacts).toContain('7')
    expect(docsFacts).toContain('Source docs')
    // Input before output: the tiles read in the order the work happened, so
    // "Source docs" sits left of "Requirements inferred".
    expect(docsFacts.indexOf('Source docs')).toBeLessThan(docsFacts.indexOf('Requirements inferred'))
    expect(docsFacts).not.toContain('shop-readme.md')
    expect(docsFacts).not.toContain('api-spec.md')
  })

  it('R29/R66: the export stage rides the SAME rail — its export task as the agent source', async () => {
    const task = {
      taskId: 'task-7',
      runId: 'run-9',
      feature: 'checkout',
      mode: 'localized' as const,
      status: 'running' as const,
      downloadReady: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      sessionRef: { agent: 'claude' as const, sessionId: 'session-7' },
    }
    mocks.evaluationTasks.mockReturnValue([task])
    mocks.taskById.mockImplementation((taskId) => taskId === task.taskId ? task : null)
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      currentStage: 'evaluation-export',
      links: { runId: 'run-9', evaluationTaskId: 'task-7' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'evaluation-export' ? ('running' as const) : ('done' as const),
        ...(key === 'evaluation-export' ? { evidence: { taskId: 'task-7' } } : {}),
      })),
    }))
    await render('fl_1')
    // No bespoke export panel — the export task streams through the shared rail
    // (kind:'evaluation'), identical framing to every other stage.
    expect(container.querySelector('[data-testid="evaluation-task-panel"]')).toBeNull()
    expect(container.querySelector('[data-testid="agent-session-view"]')?.getAttribute('data-kind')).toBe('evaluation')
  })

  it('shows the live export log before a localized rewrite has an agent session', async () => {
    const oldTask = {
      taskId: 'task-old',
      runId: 'run-9',
      feature: 'checkout',
      mode: 'raw' as const,
      status: 'completed' as const,
      downloadReady: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:01:00Z',
    }
    const liveTask = {
      taskId: 'task-live',
      runId: 'run-9',
      feature: 'checkout',
      mode: 'localized' as const,
      status: 'running' as const,
      downloadReady: false,
      createdAt: '2026-01-01T00:02:00Z',
      updatedAt: '2026-01-01T00:02:00Z',
    }
    mocks.evaluationTasks.mockReturnValue([liveTask, oldTask])
    mocks.taskById.mockImplementation((taskId) => (
      taskId === liveTask.taskId ? liveTask : taskId === oldTask.taskId ? oldTask : null
    ))
    mocks.evaluationLogs.mockReturnValue({
      [liveTask.taskId]: '[evaluation] generating localized wording\n[agent:claude] starting localized rewrite (model: haiku)\n',
    })
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      links: { runId: 'run-9', evaluationTaskId: oldTask.taskId },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'evaluation-export' ? { evidence: { taskId: oldTask.taskId } } : {}),
      })),
    }))

    await render('fl_1', { stage: 'evaluation-export', onSelectStage: vi.fn() })
    await act(async () => {})

    const activity = container.querySelector('[data-testid="stage-activity"]')
    expect(activity?.textContent).toContain('[evaluation] generating localized wording')
    expect(activity?.textContent).toContain('[agent:claude] starting localized rewrite (model: haiku)')
    // No sessionRef yet: progress comes from the export log rather than asking
    // the agent-session endpoint for a session that cannot exist yet.
    expect(container.querySelector('[data-testid="agent-session-view"]')?.getAttribute('data-kind')).toBeNull()
    expect(mocks.watchEvaluationTask).toHaveBeenCalledWith(liveTask.taskId)
  })
})

// A flight resumed mid-pipeline marks every earlier stage `skipped`. The shipped
// demo showed five ✓ steps until the user pressed Continue from Test Run, and
// the moment they made progress those five decayed to ↷ — the evidence had not
// changed, only who was credited for it.
describe('a skipped stage that HAS evidence keeps its settled mark', () => {
  it('renders the resumed flight\'s earlier steps as done, not skipped', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      currentStage: 'run',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'run' ? ('running' as const)
          : key === 'heal' || key === 'evaluation-export' ? ('pending' as const)
          : ('skipped' as const),
        // What the read-time probe fills in for a stage completed outside this
        // flight. `scout`/`similarity` carry none — nothing on disk records a scan.
        ...(key === 'scaffold' || key === 'env-capture' || key === 'docs'
          || key === 'prd-summary' || key === 'specs-coverage' || key === 'portify'
          ? { evidence: { captured: 1 }, evidenceSource: 'workspace' as const }
          : {}),
      })),
    }))
    await render('fl_1')
    const row = (key: string) =>
      container.querySelector(`[data-testid="stage-rail-${key}"]`)?.textContent ?? ''
    for (const key of ['scaffold', 'docs', 'specs-coverage', 'portify']) {
      expect(row(key)).toContain('✓')
      expect(row(key)).not.toContain('↷')
    }
    // A skip with nothing to show still reads as one.
    expect(row('scout')).toContain('↷')
  })
})
