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

describe('stage summary + drill-through (R6)', () => {
  async function renderWithDrill(m: FlightManifest, drill: { onOpenRun?: ReturnType<typeof vi.fn>; onOpenCoverage?: ReturnType<typeof vi.fn>; onOpenConfig?: ReturnType<typeof vi.fn> }) {
    mocks.getFlight.mockResolvedValue(m)
    await render('fl_1', { ...drill })
  }

  it('run stage shows the harness state line and drills through to the run detail', async () => {
    const onOpenRun = vi.fn()
    await renderWithDrill(manifest({
      status: 'done',
      currentStage: null,
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'run' ? { evidence: { runId: 'run-9', status: 'passed', healCycles: 2 } } : {}),
      })),
    }), { onOpenRun })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click()
    })
    // No counts in this stage's evidence (older flight) → falls back to naming
    // the verdict rather than inventing a score.
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent).toBe('Run run-9 — passed.')
    const drill = container.querySelector<HTMLButtonElement>('[data-testid="stage-drill-run"]')
    // R82: the drill names WHICH run it opens, now that previous runs list below.
    expect(drill?.textContent).toContain('Latest run')
    await act(async () => { drill?.click() })
    expect(onOpenRun).toHaveBeenCalledWith('checkout', 'run-9')
  })

  it('R82: clicking a failing test drills to the run detail carrying that test as the focus', async () => {
    const onOpenRun = vi.fn()
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-9',
      manifest: { runId: 'run-9', status: 'failed', healCycles: 1 },
      summary: {
        complete: true,
        total: 23,
        passed: 2,
        failed: [
          { id: 'f1', name: 'test-case-req-r4-path-sad-otp-guard', location: '/ws/e2e/otp.spec.ts:199' },
          { id: 'f2', name: 'test-case-req-r5-path-happy-clean-number', location: '/ws/e2e/blocklist.spec.ts:176' },
        ],
      },
    })
    await renderWithDrill(manifest({
      status: 'done',
      currentStage: null,
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'run' ? { evidence: { runId: 'run-9', status: 'failed', healCycles: 1 } } : {}),
      })),
    }), { onOpenRun })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click()
    })
    // The SECOND failure, to prove the clicked row's identity travels — not just
    // "some test" or the first one.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="failing-open-test-case-req-r5-path-happy-clean-number"]')?.click()
    })
    expect(onOpenRun).toHaveBeenCalledWith('checkout', 'run-9', { test: 'test-case-req-r5-path-happy-clean-number' })
  })

  it('reports the repair fixes as one link into that run’s Changes tab', async () => {
    // The stage used to render a whole second card here (a RepairedRepoCard per
    // repo, each with Open-in-editor + Propose-PR). Those actions live on the run
    // detail's Changes tab, which owns them along with the per-repo branch and PR
    // state — so the stage reports the fact and hands over.
    const onOpenRun = vi.fn()
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-9',
      manifest: {
        runId: 'run-9',
        status: 'passed',
        healCycles: 7,
        fixCapture: {
          capturedAt: '2026-01-01T00:00:00Z',
          repos: [
            { repoName: 'catalog-service', patchPath: '/p/catalog.patch', patchFile: 'catalog.patch', repoRoot: '/repos/catalog', files: 1 },
            { repoName: 'checkout-service', patchPath: '/p/checkout.patch', patchFile: 'checkout.patch', repoRoot: '/repos/checkout', files: 2 },
          ],
        },
      },
      summary: { complete: true, total: 7, passed: 7, failed: [] },
    })
    await renderWithDrill(manifest({
      status: 'done',
      currentStage: null,
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'run' ? { evidence: { runId: 'run-9', status: 'passed', healCycles: 7 } } : {}),
      })),
    }), { onOpenRun })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click()
    })
    // No card, no per-repo buttons — one segment on the run's stats line.
    expect(container.querySelector('[data-testid="fixes-captured"]')).toBeNull()
    const link = container.querySelector<HTMLButtonElement>('[data-testid="run-hero-fixes"]')
    expect(link?.textContent).toContain('2 repos')
    // Which repo and how much of it survives as the segment's tooltip.
    expect(link?.closest('[title]')?.getAttribute('title')).toBe('catalog-service · 1 file\ncheckout-service · 2 files')
    await act(async () => { link?.click() })
    expect(onOpenRun).toHaveBeenCalledWith('checkout', 'run-9', { tab: 'changes' })
  })

  it('omits the fixes link when the run captured no repair', async () => {
    const onOpenRun = vi.fn()
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-9',
      manifest: { runId: 'run-9', status: 'passed', healCycles: 0 },
      summary: { complete: true, total: 7, passed: 7, failed: [] },
    })
    await renderWithDrill(manifest({
      status: 'done',
      currentStage: null,
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const })),
    }), { onOpenRun })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click()
    })
    expect(container.querySelector('[data-testid="run-hero-fixes"]')).toBeNull()
  })

  it('the hero does not restate the repair as a sentence — the numbers and the drill-through carry it', async () => {
    // An external repair used to append "Repaired by Claude Desktop — healing ·
    // repair cycle 2. The full record is on the run page." under the stats line:
    // the cycle count duplicated `Repair cycles`, the pointer duplicated the
    // clickable row, and the client is named on the run detail. R82 says this
    // stage is the run's SUMMARY, so the prose goes and the counts stay.
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-9',
      manifest: {
        runId: 'run-9',
        status: 'healing',
        healMode: 'external',
        healCycles: 2,
        externalHealSession: { sessionId: 'sess-abc', clientKind: 'claude', status: 'healing', cycleCount: 2 },
      },
    })
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'running',
      currentStage: 'run',
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'run' ? ('running' as const) : ('done' as const),
      })),
    }))
    await render('fl_1')
    const hero = container.querySelector('[data-testid="test-run-hero"]')?.textContent ?? ''
    expect(hero).toContain('Repair cycles')
    expect(hero).not.toContain('Repaired by')
    expect(hero).not.toContain('on the run page')
  })

  it('specs-coverage drills through to the coverage ledger; portify to the feature\'s Ports tab', async () => {
    const onOpenCoverage = vi.fn()
    const onOpenConfig = vi.fn()
    await renderWithDrill(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'portify' ? { evidence: { workflowId: 'wf-3', edits: false } } : {}),
      })),
    }), { onOpenCoverage, onOpenConfig })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-specs-coverage"]')?.click()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-drill-specs-coverage"]')?.click()
    })
    expect(onOpenCoverage).toHaveBeenCalledWith('checkout')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-portify"]')?.click()
    })
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent).toContain('already swappable')
    expect(container.querySelector('[data-testid="stage-drill-portify"]')?.textContent).toBe('Open port settings →')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-drill-portify"]')?.click()
    })
    // The Ports tab is supporting config; Portify workflow ownership stays here.
    expect(onOpenConfig).toHaveBeenCalledWith('checkout', 'ports')
  })

  it('portify drill is HIDDEN while running (the embedded rail is the live view) and unlocks when parked mid-step', async () => {
    const onOpenConfig = vi.fn()
    const before = FLIGHT_STAGE_KEYS.indexOf('portify')
    const stagesWith = (portifyStatus: 'running' | 'pending') =>
      FLIGHT_STAGE_KEYS.map((key, i) => ({
        key,
        status: i < before ? ('done' as const) : i === before ? portifyStatus : ('pending' as const),
        // The long agent-editing phase: no evidence yet, only the live pin.
        ...(key === 'portify'
          ? { progress: { workflowId: 'wf-live' }, log: '[portify] workflow wf-live started\n', startedAt: '2026-01-01T00:05:00Z' }
          : {}),
      }))
    await renderWithDrill(manifest({ status: 'running', currentStage: 'portify', stages: stagesWith('running') }), { onOpenConfig })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-portify"]')?.click()
    })
    expect(container.querySelector('[data-testid="stage-drill-portify"]')).toBeNull()

    // Paused mid-step (interrupted → pending, but startedAt survives): the tab
    // still opens — that's where an unfinished workflow is picked back up.
    await renderWithDrill(manifest({ status: 'paused', currentStage: 'portify', stages: stagesWith('pending') }), { onOpenConfig })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-portify"]')?.click()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-drill-portify"]')?.click()
    })
    expect(onOpenConfig).toHaveBeenCalledWith('checkout', 'ports')
  })

  it('portify drill stays hidden on a stage that never ran (no startedAt)', async () => {
    const onOpenConfig = vi.fn()
    const before = FLIGHT_STAGE_KEYS.indexOf('portify')
    await renderWithDrill(manifest({
      status: 'paused',
      currentStage: 'portify',
      stages: FLIGHT_STAGE_KEYS.map((key, i) => ({
        key,
        status: i < before ? ('done' as const) : ('pending' as const),
      })),
    }), { onOpenConfig })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-portify"]')?.click()
    })
    expect(container.querySelector('[data-testid="stage-drill-portify"]')).toBeNull()
  })

  it('running portify tails its workflow agent session in the activity rail', async () => {
    const before = FLIGHT_STAGE_KEYS.indexOf('portify')
    await renderWithDrill(manifest({
      status: 'running',
      currentStage: 'portify',
      stages: FLIGHT_STAGE_KEYS.map((key, i) => ({
        key,
        status: i < before ? ('done' as const) : i === before ? ('running' as const) : ('pending' as const),
        // Mid-editing: only the live progress pin exists — the rail must tail
        // the portify workflow session, not fall back to system rows alone.
        ...(key === 'portify'
          ? { progress: { workflowId: 'wf-live', status: 'editing', attempt: 1, maxAttempts: 3 }, log: '[portify] workflow wf-live started\n' }
          : {}),
      })),
    }), {})
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-portify"]')?.click()
    })
    const asv = container.querySelector('[data-testid="agent-session-view"]')
    expect(asv?.getAttribute('data-kind')).toBe('portify')
    // The live phase mirror surfaces on the state line and the embedded timeline
    // — NOT as band tiles. The band is the stage's settled tile set in every
    // state, so a transient attempt/phase pair never displaces a placeholder.
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent).toContain('Editing the services')
    const facts = container.querySelector('[data-testid="stage-facts"]')?.textContent ?? ''
    expect(facts).toContain('Services injectable')
    expect(facts).not.toContain('Attempt')
  })

  it('renders no drill-through when no handler is wired (lens is optional)', async () => {
    await renderWithDrill(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const })),
    }), {})
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click()
    })
    expect(container.querySelector('[data-testid="stage-drill-run"]')).toBeNull()
  })
})

describe('trailer model (R14–R18)', () => {
  it('R18/R21/R22: the rail speaks outcome language; plumbing rows are hidden', async () => {
    mocks.getFlight.mockResolvedValue(manifest())
    await render('fl_1')
    expect(container.querySelector('[data-testid="stage-rail-portify"]')?.textContent).toContain('Parallel setup')
    expect(container.querySelector('[data-testid="stage-rail-scaffold"]')?.textContent).toContain('Suite setup')
    expect(container.querySelector('[data-testid="stage-rail-docs"]')?.textContent).toContain('Requirements')
    expect(container.querySelector('[data-testid="stage-rail-evaluation-export"]')?.textContent).toContain('Report')
    // Run + heal are one user step; similarity never shows unless it needs a
    // human; the pair companions (env-capture, prd-summary) fold into their rows.
    const runRow = container.querySelector('[data-testid="stage-rail-run"]')!
    const parallelSetupRow = container.querySelector('[data-testid="stage-rail-portify"]')!
    expect(runRow.textContent).toContain('Test run')
    expect(runRow.compareDocumentPosition(parallelSetupRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('[data-testid="stage-rail-heal"]')).toBeNull()
    expect(container.querySelector('[data-testid="stage-rail-similarity"]')).toBeNull()
    expect(container.querySelector('[data-testid="stage-rail-env-capture"]')).toBeNull()
    expect(container.querySelector('[data-testid="stage-rail-prd-summary"]')).toBeNull()
  })

  it('R21: similarity appears ONLY when parked on the match checkpoint', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'waiting-for-approval',
      currentStage: 'similarity',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'similarity' ? ('waiting-for-approval' as const) : ('pending' as const),
        ...(key === 'similarity'
          ? {
              evidence: { scanned: 24, match: { feature: 'checkout' } },
              checkpoint: { kind: 'similarity-choice' as const, message: 'checkout already covers this repo — continue, redo, or start new?', options: ['continue', 'redo', 'new'] },
            }
          : {}),
      })),
    }))
    await render('fl_1')
    const rail = container.querySelector('[data-testid="stage-rail-similarity"]')
    expect(rail?.textContent).toContain('Existing suite found')
    expect(container.querySelector('[data-testid="stage-facts"]')?.textContent).toContain('checkout')
    expect(container.querySelector('[data-testid="checkpoint-controls"]')).toBeTruthy()
  })
})
