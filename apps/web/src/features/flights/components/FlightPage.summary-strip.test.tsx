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
  AgentSessionView: ({ source, systemRows, empty }: { source?: { kind: string; stage?: string }; systemRows?: { pre: string[]; post: string[] }; empty?: { title: string } }) => (
    <div data-testid="agent-session-view" data-kind={source?.kind} data-stage={source?.stage} data-empty-title={empty?.title}>
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

describe('summary strip (R71/W5)', () => {
  it('strip items jump to their stage; elapsed shows while running', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:02:00Z',
      runVerdict: 'passed',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'evaluation-export' ? ('running' as const) : ('done' as const),
        ...(key === 'docs' ? { evidence: { docs: ['prd.md'] } } : {}),
      })),
    }))
    await render('fl_1')
    // R71/W5 regression: elapsed used to hide exactly while running.
    expect(container.querySelector('[data-testid="strip-elapsed"]')?.textContent).toContain('Elapsed')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="strip-run"]')?.click() })
    expect(container.querySelector('[data-testid="stage-rail-run"]')?.getAttribute('aria-current')).toBe('true')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="strip-docs"]')?.click() })
    expect(container.querySelector('[data-testid="stage-rail-docs"]')?.getAttribute('aria-current')).toBe('true')
  })

  it('R79: the strip shows the conducting agent read-only (claude by default, codex when set)', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'running' }))
    await render('fl_1')
    const strip = () => container.querySelector('[data-testid="flight-summary-strip"]')?.textContent ?? ''
    expect(strip().toLowerCase()).toContain('agent')
    expect(strip()).toContain('Claude')

    mocks.getFlight.mockResolvedValue(manifest({ status: 'running', opts: { env: 'local', coverageTarget: 100, yolo: false, agent: 'codex' } }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="flight-summary-strip"]')?.textContent).toContain('Codex')
  })

  it('the paused status chip explains WHO paused it (pauseReason tooltip)', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', pauseReason: 'user', currentStage: 'docs' }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="flight-status"]')?.getAttribute('title')).toContain('Paused by you')
  })
})

describe('detail redesign (R53–R68)', () => {
  const doneStages = () => FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))

  it('R76: Delete suite… opens the shared type-name confirm; deleting removes suite + history and returns to the list', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done', currentStage: null, stages: doneStages() }))
    const onSelectFlight = vi.fn()
    await render('fl_1', { onSelectFlight })
    expect(container.querySelector('[aria-label="All flights"]')).toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-menu"]')?.click() })
    const del = container.querySelector<HTMLButtonElement>('[data-testid="flight-delete"]')
    expect(del?.textContent).toContain('Delete suite')
    await act(async () => { del!.click() })
    // The modal is open; nothing fires until the typed name matches.
    expect(mocks.deleteFeature).not.toHaveBeenCalled()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="delete-suite-confirm-name"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(nameInput, 'checkout')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    mocks.deleteFeature.mockResolvedValue(undefined)
    const confirm = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Delete suite')!
    await act(async () => { confirm.click() })
    expect(mocks.deleteFeature).toHaveBeenCalledWith('checkout', 'checkout')
    expect(onSelectFlight).toHaveBeenCalledWith(null)
    // Journal-only delete is API-only now — the GUI never calls it.
    expect(mocks.deleteFlight).not.toHaveBeenCalled()
  })

  it('removes a pre-scaffold flight record instead of trying to delete a suite that does not exist', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'aborted',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'similarity' ? 'done' as const : key === 'scout' ? 'running' as const : 'pending' as const,
      })),
    }))
    const onSelectFlight = vi.fn()
    await render('fl_1', { onSelectFlight })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-menu"]')?.click() })
    const remove = container.querySelector<HTMLButtonElement>('[data-testid="flight-delete"]')
    expect(remove?.textContent).toContain('Remove flight')
    await act(async () => { remove!.click() })
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="delete-suite-confirm-name"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(nameInput, 'checkout')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    mocks.deleteFlight.mockResolvedValue({ deleted: true })
    const confirm = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove flight')!
    await act(async () => { confirm.click() })
    expect(mocks.deleteFlight).toHaveBeenCalledWith('fl_1')
    expect(mocks.deleteFeature).not.toHaveBeenCalled()
    expect(onSelectFlight).toHaveBeenCalledWith(null)
  })

  it('R82: a live run flips the settled run row to running; the hero shows the run and lists the previous runs', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'run' ? { evidence: { runId: 'run-9', status: 'passed', healCycles: 0 } } : {}),
      })),
    }))
    mocks.listRuns.mockResolvedValue([
      { runId: 'run-live', feature: 'checkout', status: 'running', startedAt: '2026-01-01T00:03:00Z', executionType: 'run' },
      { runId: 'run-9', feature: 'checkout', status: 'passed', startedAt: '2026-01-01T00:00:00Z', executionType: 'run' },
      { runId: 'boot-1', feature: 'checkout', status: 'running', startedAt: '2026-01-01T00:01:00Z', executionType: 'boot' },
    ])
    mocks.getRunDetail.mockResolvedValue({ runId: 'run-9', manifest: { runId: 'run-9', status: 'passed' }, summary: { total: 8, passed: 8, failed: [] } })
    const activity = new Map([['checkout', { kind: 'running' as const, runId: 'run-live' }]])
    const onOpenRun = vi.fn()
    await render('fl_1', { activity, onOpenRun })
    const runRail = container.querySelector('[data-testid="stage-rail-run"]')
    expect(runRail?.textContent).toContain('▸')
    expect(runRail?.textContent).not.toContain('✓')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click()
    })
    // The flight's run is the hero (run-9, 8/8 — stated once, by the tile).
    expect(container.querySelector('[data-testid="test-run-hero"]')?.textContent).toContain('8/8')
    // The feature's other real runs list below — boot sessions stay hidden. Each
    // row is labelled by its run REF and ordinal, not by the feature name every
    // row shares (R82).
    const previous = container.querySelector('[data-testid="previous-runs"]')
    expect(previous).toBeTruthy()
    expect(previous?.textContent).toContain('Previous runs')
    expect(previous?.textContent).toContain('run 2 of 2')
    expect(previous?.textContent).not.toContain('checkout')
    const previousButtons = previous!.querySelectorAll('button')
    expect(previousButtons.length).toBe(1)
    await act(async () => { previousButtons[0]?.click() })
    expect(onOpenRun).toHaveBeenCalledWith('checkout', 'run-live')
  })

  it('R61: the summary strip shows elapsed, coverage, run verdict, docs and report readiness', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      createdAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:02:14Z',
      runVerdict: 'passed',
      links: { runId: 'run-9', evaluationZip: '/tmp/eval.zip' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'specs-coverage' ? { progress: { pass: 2, phase: 'mapping', passes: [{ pass: 1, coveragePct: 62, gapsOpen: 3 }, { pass: 2, coveragePct: 94, gapsOpen: 1 }] } } : {}),
        ...(key === 'docs' ? { evidence: { docs: ['a.md', 'b.md', 'c.md'] } } : {}),
      })),
    }))
    await render('fl_1')
    const strip = container.querySelector('[data-testid="flight-summary-strip"]')?.textContent ?? ''
    expect(strip).toContain('2m 14s')
    expect(strip).toContain('94%')
    expect(strip).toContain('Passed')
    expect(strip).toContain('3')
    expect(strip).toContain('ready')
  })

  // Coverage used to come only from the authoring LOOP's pass records, which
  // only a flight that conducted specs-coverage itself has. A derived flight —
  // or any flight resumed past that step — carries the stage done with no
  // passes, so the strip printed no coverage while the stage one click away
  // reported it off the ledger.
  it('reads coverage off settled stage evidence when no authoring loop ran', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'specs-coverage' ? { evidence: { coveragePct: 100, covered: 12, total: 12 } } : {}),
      })),
    }))
    await render('fl_1')
    const item = container.querySelector('[data-testid="strip-specs-coverage"]')
    expect(item?.textContent).toContain('100%')
  })

  it('keeps the live loop as the source when it HAS passes — its gap count is the finer signal', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'specs-coverage'
          ? {
              progress: { pass: 1, phase: 'mapping', passes: [{ pass: 1, coveragePct: 94, gapsOpen: 1 }] },
              evidence: { coveragePct: 62 },
            }
          : {}),
      })),
    }))
    await render('fl_1')
    const item = container.querySelector('[data-testid="strip-specs-coverage"]')
    expect(item?.textContent).toContain('94%')
    expect(item?.textContent).not.toContain('62%')
  })

  it('R66: a settled agent stage folds its activity behind one toggle — system lines ride the agent timeline, split around its slot', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'scout' ? { log: '[scout] inspecting repos\n[scout] spawning agent…\nraw agent chatter\n[scout] config drafted\n' } : {}),
      })),
    }))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-scout"]')?.click()
    })
    // Settled → collapsed by default, one disclosure.
    expect(container.querySelector('[data-testid="agent-session-view"]')).toBeNull()
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="stage-details-toggle"]')
    expect(toggle?.textContent).toContain('Show')
    await act(async () => { toggle!.click() })
    // Settled → no live pulse on the band; the dot is a running-only cue.
    expect(toggle!.querySelector('.cl-status-dot')).toBeNull()
    const activitySection = container.querySelector('[data-testid="stage-activity"]')!
    // R66 (consolidated): ONE block — no standalone tagged-log panes.
    expect(activitySection.querySelectorAll('[data-testid="stage-log"]').length).toBe(0)
    const asv = activitySection.querySelector('[data-testid="agent-session-view"]')
    expect(asv?.getAttribute('data-stage')).toBe('scout')
    // System lines ride the same block, split around the agent's slot.
    const pre = [...activitySection.querySelectorAll('[data-testid="system-pre"]')].map((e) => e.textContent).join('\n')
    const post = [...activitySection.querySelectorAll('[data-testid="system-post"]')].map((e) => e.textContent).join('\n')
    expect(pre).toContain('spawning agent…')
    expect(pre).not.toContain('config drafted')
    expect(post).toContain('config drafted')
    // The untagged agent chatter never renders as a system row — the timeline owns it.
    expect(activitySection.textContent).not.toContain('raw agent chatter')
  })

  // Parallel readiness keeps its proof in the workflow record and its transcript
  // wherever the agent CLI wrote it — routinely nowhere this workspace can read
  // (an external-producer workflow, a cleaned history). The generic "nothing ran
  // here" would then contradict the double-boot and port-changes panels sitting
  // directly above the rail.
  it('the portify rail explains a missing transcript instead of claiming nothing ran', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'portify' ? { evidence: { workflowId: 'portify-demo' } } : {}),
      })),
    }))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-portify"]')?.click()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-details-toggle"]')?.click()
    })
    const asv = container.querySelector('[data-testid="stage-activity"] [data-testid="agent-session-view"]')
    expect(asv?.getAttribute('data-kind')).toBe('portify')
    expect(asv?.getAttribute('data-empty-title')).toBe('Nothing to replay here')
  })

  it('R66: a live agent stage renders the activity expanded, collapsible via the always-present toggle', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      currentStage: 'scout',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'scout' ? ('running' as const) : ('pending' as const),
        ...(key === 'scout' ? { log: '[scout] spawning agent…\n' } : {}),
      })),
    }))
    await render('fl_1')
    // The toggle is always present now (collapsible in any state) and open by
    // default while live.
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="stage-details-toggle"]')
    expect(toggle).not.toBeNull()
    expect(toggle!.getAttribute('aria-expanded')).toBe('true')
    // The band echoes the stage's `generating` pulse: a live status dot rides
    // the Activity label so a collapsed rail still advertises work is running.
    expect(toggle!.querySelector('.cl-status-dot')).not.toBeNull()
    const activitySection = container.querySelector('[data-testid="stage-activity"]')!
    // One block: the system line rides the agent timeline, no standalone log pane.
    expect(activitySection.querySelector('[data-testid="stage-log"]')).toBeNull()
    const pre = [...activitySection.querySelectorAll('[data-testid="system-pre"]')].map((e) => e.textContent).join('\n')
    expect(pre).toContain('spawning agent…')
    const asv = activitySection.querySelector('[data-testid="agent-session-view"]')
    expect(asv?.getAttribute('data-stage')).toBe('scout')
    // Collapsing hides the timeline while live.
    await act(async () => { toggle!.click() })
    expect(toggle!.getAttribute('aria-expanded')).toBe('false')
    expect(activitySection.querySelector('[data-testid="agent-session-view"]')).toBeNull()
  })

  it('R66: an agentless stage uses the SAME block — its system lines as rows, no agent timeline', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'scaffold' ? { log: '[scaffold] reused the existing feature setup\n' } : {}),
      })),
    }))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-scaffold"]')?.click()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-details-toggle"]')?.click()
    })
    const activitySection = container.querySelector('[data-testid="stage-activity"]')!
    // Same component as agent stages — but no agent session (no data-stage).
    const asv = activitySection.querySelector('[data-testid="agent-session-view"]')
    expect(asv).not.toBeNull()
    expect(asv?.getAttribute('data-stage')).toBeNull()
    // No standalone tagged-log pane — the system line is a row on the rail.
    expect(activitySection.querySelector('[data-testid="stage-log"]')).toBeNull()
    const pre = [...activitySection.querySelectorAll('[data-testid="system-pre"]')].map((e) => e.textContent).join('\n')
    expect(pre).toContain('reused the existing feature setup')
  })

  it('R60: rail rows carry stage durations once settled', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'run' ? { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:30Z' } : {}),
        ...(key === 'heal' ? { startedAt: '2026-01-01T00:00:30Z', endedAt: '2026-01-01T00:01:10Z' } : {}),
      })),
    }))
    await render('fl_1')
    // The merged run row spans run start → heal end (70s).
    expect(container.querySelector('[data-testid="stage-rail-run"]')?.textContent).toContain('1m 10s')
  })

  it('rail durations read the banked work clock, not the wall-clock span across a checkpoint wait', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        // Nine wall-clock hours (parked overnight on a checkpoint), 108s of work.
        ...(key === 'docs' ? { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T09:00:00Z', activeMs: 90_000 } : {}),
        ...(key === 'prd-summary' ? { startedAt: '2026-01-01T09:00:00Z', endedAt: '2026-01-01T09:00:18Z', activeMs: 18_000 } : {}),
      })),
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="stage-rail-docs"]')?.textContent).toContain('1m 48s')
    expect(container.querySelector('[data-testid="stage-rail-docs"]')?.textContent).not.toContain('9h')
  })

  it('ELAPSED starts at flight.startedAt when present — a queued or redone flight, not its record age', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      // Created at enqueue, started 45 minutes later when the queue drained.
      createdAt: '2026-01-01T00:00:00Z',
      startedAt: '2026-01-01T00:45:00Z',
      endedAt: '2026-01-01T00:55:00Z',
    }))
    await render('fl_1')
    const elapsed = container.querySelector('[data-testid="strip-elapsed"]')?.textContent
    expect(elapsed).toContain('10m 00s')
  })
})
