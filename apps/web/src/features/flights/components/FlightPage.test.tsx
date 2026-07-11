// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightManifest } from '../../../shared/api/client'
import { FLIGHT_STAGE_KEYS } from '../../../../../../shared/flights/types'

const mocks = vi.hoisted(() => ({
  listFlights: vi.fn(),
  getFlight: vi.fn(),
  getRunDetail: vi.fn(),
  listJournal: vi.fn(),
  respondFlightCheckpoint: vi.fn(),
  resumeFlight: vi.fn(),
  abortFlight: vi.fn(),
  pauseFlight: vi.fn(),
  redoFlight: vi.fn(),
  deleteFlight: vi.fn(),
  listRuns: vi.fn(),
  downloadTask: vi.fn(),
  getFeatureConfigDoc: vi.fn(),
  getPlaywrightConfig: vi.fn(),
  putFeatureConfigDoc: vi.fn(),
  putPlaywrightConfig: vi.fn(),
  listFeatureDocs: vi.fn(),
  importFeatureDoc: vi.fn(),
  deleteFeatureDoc: vi.fn(),
  linkFeatureDocPath: vi.fn(),
  openEditor: vi.fn(),
  cancelHealRun: vi.fn(),
  stopRun: vi.fn(),
  restartRun: vi.fn(),
  taskById: vi.fn(),
  taskForRun: vi.fn(),
}))

vi.mock('../../../shared/api/client', () => ({
  listFlights: mocks.listFlights,
  getFlight: mocks.getFlight,
  getRunDetail: mocks.getRunDetail,
  listJournal: mocks.listJournal,
  respondFlightCheckpoint: mocks.respondFlightCheckpoint,
  resumeFlight: mocks.resumeFlight,
  abortFlight: mocks.abortFlight,
  pauseFlight: mocks.pauseFlight,
  redoFlight: mocks.redoFlight,
  deleteFlight: mocks.deleteFlight,
  listRuns: mocks.listRuns,
  getFeatureConfigDoc: mocks.getFeatureConfigDoc,
  getPlaywrightConfig: mocks.getPlaywrightConfig,
  putFeatureConfigDoc: mocks.putFeatureConfigDoc,
  putPlaywrightConfig: mocks.putPlaywrightConfig,
  listFeatureDocs: mocks.listFeatureDocs,
  importFeatureDoc: mocks.importFeatureDoc,
  deleteFeatureDoc: mocks.deleteFeatureDoc,
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
vi.mock('../../agent-sessions/components/AgentSessionView', () => ({
  AgentSessionView: ({ source, systemRows }: { source?: { kind: string; stage?: string }; systemRows?: { pre: string[]; post: string[] } }) => (
    <div data-testid="agent-session-view" data-kind={source?.kind} data-stage={source?.stage}>
      {systemRows?.pre.map((l, i) => <div key={`pre-${i}`} data-testid="system-pre">{l}</div>)}
      {systemRows?.post.map((l, i) => <div key={`post-${i}`} data-testid="system-post">{l}</div>)}
    </div>
  ),
}))

// The export stage reads the download action + task lookups from the export
// context; the provider needs live sockets, so stub the hook.
vi.mock('../../evaluation/state/EvaluationExportContext', () => ({
  useEvaluationExports: () => ({
    downloadTask: mocks.downloadTask,
    taskById: mocks.taskById,
    taskForRun: mocks.taskForRun,
    logsByTaskId: {},
    watchTask: vi.fn(),
  }),
}))

import { FlightPage } from './FlightPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getRunDetail.mockResolvedValue({ runId: 'run-9', manifest: { status: 'passed' } })
  mocks.listRuns.mockResolvedValue([])
  mocks.listJournal.mockResolvedValue([])
  mocks.downloadTask.mockResolvedValue(undefined)
  mocks.getFeatureConfigDoc.mockRejectedValue(new Error('no config'))
  mocks.getPlaywrightConfig.mockRejectedValue(new Error('no config'))
  mocks.listFeatureDocs.mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: false, sourceDocCount: 0, docsDrift: false })
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

async function render(flightId: string, refreshKey = 0) {
  await act(async () => {
    root.render(
      <FlightPage flightId={flightId} refreshKey={refreshKey} onSelectFlight={vi.fn()} onClose={vi.fn()} />,
    )
  })
}

describe('FlightPage', () => {
  it('renders the full stage rail and auto-selects the stage that needs eyes', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'waiting-for-approval',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'scout'
          ? ('waiting-for-approval' as const)
          : key === 'similarity'
            ? ('done' as const)
            : ('pending' as const),
        ...(key === 'scout'
          ? { checkpoint: { kind: 'config-approval' as const, message: 'Approve the draft config?', options: ['approve', 'redraft'], data: { configSource: 'module.exports = {}', configPath: '/w/features/checkout/feature.config.cjs' } } }
          : {}),
      })),
    }))
    await render('fl_1')
    for (const key of FLIGHT_STAGE_KEYS) {
      if (key === 'similarity' || key === 'heal' || key === 'env-capture' || key === 'prd-summary') {
        // R21/R22/R32/R33: plumbing + folded pair companions never get their
        // own row — similarity passed silently, heal folds into run,
        // env-capture into scaffold, prd-summary into docs.
        expect(container.querySelector(`[data-testid="stage-rail-${key}"]`)).toBeNull()
      } else {
        expect(container.querySelector(`[data-testid="stage-rail-${key}"]`)).toBeTruthy()
      }
    }
    const controls = container.querySelector('[data-testid="checkpoint-controls"]')
    expect(controls?.textContent).toContain('Approve the draft config?')
    // R43: no raw config textarea — the Feature Setup panel + Advanced setup
    // are the edit surface; approve just posts the choice (server re-reads disk).
    expect(container.querySelector('[data-testid="checkpoint-config"]')).toBeNull()
    mocks.respondFlightCheckpoint.mockResolvedValue(manifest())
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-choice-approve"]')?.click()
    })
    expect(mocks.respondFlightCheckpoint).toHaveBeenCalledWith('fl_1', { choice: 'approve' })
  })

  it('missing-env: parses KEY=VALUE lines and submits them as values', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'waiting-for-approval',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'env-capture' ? ('waiting-for-approval' as const) : ('done' as const),
        ...(key === 'env-capture'
          ? { checkpoint: { kind: 'missing-env' as const, message: 'Provide values', options: ['retry', 'waive'], data: { missing: ['/repo/shop/.env'] } } }
          : {}),
      })),
    }))
    mocks.respondFlightCheckpoint.mockResolvedValue(manifest())
    await render('fl_1')
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="checkpoint-env-values"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'API_KEY=abc\nDB_URL=postgres://x')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-submit-values"]')?.click()
    })
    expect(mocks.respondFlightCheckpoint).toHaveBeenCalledWith('fl_1', {
      values: { API_KEY: 'abc', DB_URL: 'postgres://x' },
    })
  })

  it('a paused flight offers Resume; an active one offers Abort', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', error: 'boot failed' }))
    mocks.resumeFlight.mockResolvedValue(manifest())
    await render('fl_1')
    expect(container.querySelector('[data-testid="flight-status"]')?.textContent).toBe('paused')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-resume"]')?.click() })
    expect(mocks.resumeFlight).toHaveBeenCalledWith('fl_1')

    mocks.getFlight.mockResolvedValue(manifest({ status: 'running' }))
    await render('fl_1', 1)
    expect(container.querySelector('[data-testid="flight-abort"]')).toBeTruthy()
  })

  it('R25: a settled flight offers the stage-entry launcher; an active one does not', async () => {
    const onStartFlight = vi.fn()
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done' }))
    await act(async () => {
      root.render(
        <FlightPage flightId="fl_1" refreshKey={0} onSelectFlight={vi.fn()} onClose={vi.fn()} onStartFlight={onStartFlight} />,
      )
    })
    const refly = container.querySelector<HTMLButtonElement>('[data-testid="flight-refly"]')
    expect(refly).toBeTruthy()
    await act(async () => { refly?.click() })
    expect(onStartFlight).toHaveBeenCalledWith('checkout')

    mocks.getFlight.mockResolvedValue(manifest({ status: 'running' }))
    await act(async () => {
      root.render(
        <FlightPage flightId="fl_1" refreshKey={1} onSelectFlight={vi.fn()} onClose={vi.fn()} onStartFlight={onStartFlight} />,
      )
    })
    expect(container.querySelector('[data-testid="flight-refly"]')).toBeNull()

    // No handler wired → no button (the launcher is App-owned and optional).
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done' }))
    await render('fl_1', 2)
    expect(container.querySelector('[data-testid="flight-refly"]')).toBeNull()
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
})

describe('stage summary + drill-through (R6)', () => {
  async function renderWithDrill(m: FlightManifest, drill: { onOpenRun?: ReturnType<typeof vi.fn>; onOpenCoverage?: ReturnType<typeof vi.fn>; onOpenPortify?: ReturnType<typeof vi.fn> }) {
    mocks.getFlight.mockResolvedValue(m)
    await act(async () => {
      root.render(
        <FlightPage flightId="fl_1" refreshKey={0} onSelectFlight={vi.fn()} onClose={vi.fn()} {...drill} />,
      )
    })
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
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent).toBe('Run run-9 passed.')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-drill-run"]')?.click()
    })
    expect(onOpenRun).toHaveBeenCalledWith('checkout', 'run-9')
  })

  it('run being repaired by an external client shows an [external] system row on the activity rail', async () => {
    // Option 1: an externally-claimed heal has no Canary session to tail, so the
    // rail carries an honest status row instead of a blank/empty timeline.
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-9',
      manifest: {
        runId: 'run-9',
        status: 'healing',
        healMode: 'external',
        externalHealSession: {
          sessionId: 'sess-abc',
          clientKind: 'claude',
          conversationName: 'fix checkout',
          claimedAt: '2026-01-01T00:00:00Z',
          lastHeartbeatAt: '2026-01-01T00:00:03Z',
          status: 'healing',
          cycleCount: 2,
        },
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
    const pre = [...container.querySelectorAll('[data-testid="system-pre"]')].map((n) => n.textContent)
    expect(pre.some((l) => l?.includes('[external] Heal claimed by Claude'))).toBe(true)
    expect(pre.some((l) => l?.includes('healing') && l?.includes('repair cycle 2'))).toBe(true)
  })

  it('a normal (auto) heal shows no [external] row', async () => {
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-9',
      manifest: { runId: 'run-9', status: 'healing', healMode: 'auto' },
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
    const pre = [...container.querySelectorAll('[data-testid="system-pre"]')].map((n) => n.textContent)
    expect(pre.some((l) => l?.includes('[external]'))).toBe(false)
  })

  it('specs-coverage drills through to the coverage ledger; portify to its workflow', async () => {
    const onOpenCoverage = vi.fn()
    const onOpenPortify = vi.fn()
    await renderWithDrill(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'portify' ? { evidence: { workflowId: 'wf-3', edits: false } } : {}),
      })),
    }), { onOpenCoverage, onOpenPortify })
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
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent).toContain('no edits needed')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-drill-portify"]')?.click()
    })
    expect(onOpenPortify).toHaveBeenCalledWith('wf-3')
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
    expect(container.querySelector('[data-testid="stage-rail-portify"]')?.textContent).toContain('Parallel readiness')
    expect(container.querySelector('[data-testid="stage-rail-scaffold"]')?.textContent).toContain('Feature setup')
    expect(container.querySelector('[data-testid="stage-rail-docs"]')?.textContent).toContain('Requirements')
    expect(container.querySelector('[data-testid="stage-rail-evaluation-export"]')?.textContent).toContain('Evaluation Report')
    // Run + heal are one user step; similarity never shows unless it needs a
    // human; the pair companions (env-capture, prd-summary) fold into their rows.
    expect(container.querySelector('[data-testid="stage-rail-run"]')?.textContent).toContain('Test Run')
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
    expect(rail?.textContent).toContain('Existing feature found')
    expect(container.querySelector('[data-testid="stage-facts"]')?.textContent).toContain('checkout')
    expect(container.querySelector('[data-testid="checkpoint-controls"]')).toBeTruthy()
  })

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
    expect(container.querySelector('[data-testid="specs-pass-1"]')?.textContent).toContain('40% covered, 3 gaps open')
    expect(container.querySelector('[data-testid="specs-pass-live"]')?.textContent).toContain('authoring tests')
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
    expect(container.querySelector('[data-testid="stage-facts"]')?.textContent).toContain('Passes')
    expect(container.querySelector('[data-testid="specs-pass-1"]')?.textContent).toContain('specs failed to compile/list')
    expect(container.querySelector('[data-testid="specs-pass-2"]')?.textContent).toContain('100% covered')
    expect(container.querySelector('[data-testid="specs-pass-live"]')).toBeNull()
  })

  it('R17: the status chip lives in its own slot, not inside the title', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done', currentStage: null, stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const })) }))
    await render('fl_1')
    const title = container.querySelector('h1')
    expect(title?.textContent).not.toContain('done')
    expect(container.querySelector('[data-testid="flight-status"]')?.textContent).toBe('done')
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
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent).toBe('Creating the feature in the workspace…')
    expect(container.querySelector('[data-testid="stage-status-chip"]')?.textContent).toContain('generating')
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
    expect(container.querySelector('[data-testid="stage-facts"]')?.textContent).toContain('None needed')
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
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'portify' ? { evidence: { workflowId: 'wf-3', edits: false } } : {}),
      })),
    }))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-portify"]')?.click()
    })
    expect(container.querySelector('[data-testid="stage-details-toggle"]')).toBeNull()
  })

  it('R22: the merged run row shows verdict/repair facts and NO agent output', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      runVerdict: 'passed',
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'run' ? { evidence: { runId: 'run-9', status: 'passed', healCycles: 1 } } : {}),
        ...(key === 'heal' ? { evidence: { runId: 'run-9', healCycles: 1, healMode: 'external', finalStatus: 'passed' } } : {}),
      })),
    }))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click()
    })
    const facts = container.querySelector('[data-testid="stage-facts"]')?.textContent ?? ''
    expect(facts).toContain('passed')
    expect(facts).toContain('1 cycle')
    expect(facts).toContain('External client')
    expect(container.querySelector('[data-testid="agent-session-view"]')).toBeNull()
  })

  it('R22: while the run is live it says what is running and what each repair fixed', async () => {
    mocks.getRunDetail.mockResolvedValue({
      runId: 'run-9',
      manifest: { status: 'healing', healCycles: 1 },
      summary: { complete: false, total: 3, passed: 1, failed: [{ name: 'checkout flow' }] },
    })
    mocks.listJournal.mockResolvedValue([
      { iteration: 1, timestamp: '2026-01-01T00:00:00Z', feature: 'checkout', run: 'run-9', outcome: 'passed', hypothesis: 'create handler dropped the note title', body: '' },
    ])
    mocks.getFlight.mockResolvedValue(manifest({
      currentStage: 'run',
      links: { runId: 'run-9' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'run' ? ('running' as const) : ('pending' as const),
      })),
    }))
    await render('fl_1')
    const summary = container.querySelector('[data-testid="run-repair-summary"]')?.textContent ?? ''
    expect(summary).toContain('Repairing — cycle 2')
    expect(summary).toContain('1/3 passed')
    expect(summary).toContain('checkout flow')
    expect(container.querySelector('[data-testid="repair-journal"]')?.textContent).toContain('create handler dropped the note title')
    expect(container.querySelector('[data-testid="agent-session-view"]')).toBeNull()
  })

  it('R15/R20: the export stage carries the explicit download action; the agent timeline stays behind details', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'done',
      currentStage: null,
      links: { runId: 'run-9', evaluationTaskId: 'task-7', evaluationZip: '/logs/evaluation-exports/task-7/export.zip' },
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: 'done' as const,
        ...(key === 'evaluation-export' ? { evidence: { taskId: 'task-7', evaluationZip: '/logs/evaluation-exports/task-7/export.zip' } } : {}),
      })),
    }))
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-evaluation-export"]')?.click()
    })
    const download = container.querySelector<HTMLButtonElement>('[data-testid="flight-download-evaluation"]')
    expect(download?.textContent).toContain('Download evaluation (.zip)')
    await act(async () => { download?.click() })
    expect(mocks.downloadTask).toHaveBeenCalledWith('task-7')
    expect(container.querySelector('[data-testid="stage-facts"]')?.textContent).toContain('export.zip')
    expect(container.querySelector('[data-testid="agent-session-view"]')).toBeNull()
  })

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
    await render('fl_1', 1)
    await act(async () => {
      // R33: prd-summary folds into the Requirements (docs) row.
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-docs"]')?.click()
    })
    expect(container.querySelector('[data-testid="stage-facts"]')?.textContent).toContain('5')
    expect(container.querySelector('[data-testid="agent-session-view"]')).toBeNull()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-details-toggle"]')?.click()
    })
    expect(container.querySelector('[data-testid="agent-session-view"]')?.getAttribute('data-stage')).toBe('prd-summary')
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
    await render('fl_1')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-scaffold"]')?.click()
    })
    // Pair-settled state line speaks the whole step.
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent)
      .toBe('Feature "checkout" created — env captured (2 files), dry-run boot passed.')
    const facts = container.querySelector('[data-testid="stage-facts"]')?.textContent ?? ''
    expect(facts).toContain('checkout')
    expect(facts).toContain('2 files')
    expect(facts).toContain('api healthy')
    // R43: the editable setup panel — run command as an input writing the real
    // config doc, ports labeled with their env, Playwright as per-setting rows.
    const panel = container.querySelector('[data-testid="feature-setup-panel"]')
    expect(panel).toBeTruthy()
    const commandInput = panel?.querySelector<HTMLInputElement>('[data-testid="setup-command-api"]')
    expect(commandInput?.value).toBe('npm run dev')
    expect(panel?.textContent).toContain('api → PORT')
    expect(panel?.querySelector<HTMLInputElement>('[data-testid="setup-pw-workers"]')?.value).toBe('2')
    expect(panel?.querySelector<HTMLSelectElement>('[data-testid="setup-pw-video"]')?.value).toBe('on')
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
    // R57: repos + intent moved from scout facts into the read-only RepoScanPanel.
    expect(container.querySelector('[data-testid="repo-card-shop"]')?.textContent).toContain('/repo/shop')
    expect(container.querySelector('[data-testid="repo-card-api"]')?.textContent).toContain('/repo/api')
    expect(container.querySelector('[data-testid="flight-intent"]')?.textContent).toContain('checkout flow')
    const scoutFacts = container.querySelector('[data-testid="stage-facts"]')?.textContent ?? ''
    expect(scoutFacts).toContain('.env')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-docs"]')?.click()
    })
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent)
      .toBe('7 requirements distilled from 2 docs (repo-docs).')
    // R59: the folded prd-summary's status chips the Requirements header.
    expect(container.querySelector('[data-testid="docs-summary-chip"]')?.textContent).toContain('done')
    const docsFacts = container.querySelector('[data-testid="stage-facts"]')?.textContent ?? ''
    expect(docsFacts).toContain('shop-readme.md')
    expect(docsFacts).toContain('api-spec.md')
    expect(docsFacts).toContain('repo-docs')
    expect(docsFacts).toContain('7')
  })

  it('R29/R66: the export stage rides the SAME rail — its export task as the agent source', async () => {
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
})

describe('flight controls (R48)', () => {
  it('an active flight offers Pause + Stop; pause posts and refetches', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'running' }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="flight-pause"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="flight-abort"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="flight-start-over"]')).toBeNull()
    mocks.pauseFlight.mockResolvedValue(manifest({ status: 'paused', pauseReason: 'user' }))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="flight-pause"]')?.click()
    })
    expect(mocks.pauseFlight).toHaveBeenCalledWith('fl_1')
  })

  it('a paused flight offers Continue + Start over; start over confirms once then redoes', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', pauseReason: 'user', currentStage: 'docs' }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="flight-resume"]')?.textContent).toBe('Continue')
    expect(container.querySelector('[data-testid="flight-pause"]')).toBeNull()
    const startOver = container.querySelector<HTMLButtonElement>('[data-testid="flight-start-over"]')
    expect(startOver).toBeTruthy()
    await act(async () => { startOver!.click() })
    // First click arms the confirm; nothing fired yet.
    expect(mocks.redoFlight).not.toHaveBeenCalled()
    mocks.redoFlight.mockResolvedValue(manifest({ status: 'running' }))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="flight-start-over-confirm"]')?.click()
    })
    expect(mocks.redoFlight).toHaveBeenCalledWith('fl_1')
  })

  it('the paused status chip explains WHO paused it (pauseReason tooltip)', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', pauseReason: 'user', currentStage: 'docs' }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="flight-status"]')?.getAttribute('title')).toContain('Paused by you')
  })
})

describe('detail redesign (R53–R68)', () => {
  const doneStages = () => FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))

  it('R62: the header has no back button; delete confirms once then deletes and returns to the list', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done', currentStage: null, stages: doneStages() }))
    const onSelectFlight = vi.fn()
    await act(async () => {
      root.render(
        <FlightPage flightId="fl_1" refreshKey={0} onSelectFlight={onSelectFlight} onClose={vi.fn()} />,
      )
    })
    expect(container.querySelector('[aria-label="All flights"]')).toBeNull()
    const del = container.querySelector<HTMLButtonElement>('[data-testid="flight-delete"]')
    expect(del).toBeTruthy()
    await act(async () => { del!.click() })
    expect(mocks.deleteFlight).not.toHaveBeenCalled()
    mocks.deleteFlight.mockResolvedValue({ deleted: true })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="flight-delete-confirm"]')?.click()
    })
    expect(mocks.deleteFlight).toHaveBeenCalledWith('fl_1')
    expect(onSelectFlight).toHaveBeenCalledWith(null)
  })

  it('R64: a live run for the feature flips the settled run row to running and lists the run cards', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done', currentStage: null, stages: doneStages() }))
    mocks.listRuns.mockResolvedValue([
      { runId: 'run-live', feature: 'checkout', status: 'running', startedAt: '2026-01-01T00:03:00Z', executionType: 'run' },
      { runId: 'run-9', feature: 'checkout', status: 'passed', startedAt: '2026-01-01T00:00:00Z', executionType: 'run' },
      { runId: 'boot-1', feature: 'checkout', status: 'running', startedAt: '2026-01-01T00:01:00Z', executionType: 'boot' },
    ])
    mocks.getRunDetail.mockResolvedValue({ runId: 'run-9', manifest: { status: 'passed' }, summary: { total: 8, passed: 8, failed: [] } })
    const activity = new Map([['checkout', { kind: 'running' as const, runId: 'run-live' }]])
    const onOpenRun = vi.fn()
    await act(async () => {
      root.render(
        <FlightPage flightId="fl_1" refreshKey={0} onSelectFlight={vi.fn()} onClose={vi.fn()} activity={activity} onOpenRun={onOpenRun} />,
      )
    })
    const runRail = container.querySelector('[data-testid="stage-rail-run"]')
    expect(runRail?.textContent).toContain('▸')
    expect(runRail?.textContent).not.toContain('✓')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click()
    })
    const cards = container.querySelector('[data-testid="feature-runs"]')
    expect(cards).toBeTruthy()
    // Boot sessions are plumbing — only the two real test runs render.
    expect(cards?.textContent).toContain('8/8 passed')
    const buttons = cards!.querySelectorAll('button')
    expect(buttons.length).toBe(2)
    await act(async () => { buttons[1]?.click() })
    expect(onOpenRun).toHaveBeenCalledWith('checkout', 'run-9')
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
    expect(strip).toContain('passed')
    expect(strip).toContain('3')
    expect(strip).toContain('ready')
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

  it('R66: a live agent stage renders the activity expanded with no toggle', async () => {
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
    expect(container.querySelector('[data-testid="stage-details-toggle"]')).toBeNull()
    const activitySection = container.querySelector('[data-testid="stage-activity"]')!
    // One block: the system line rides the agent timeline, no standalone log pane.
    expect(activitySection.querySelector('[data-testid="stage-log"]')).toBeNull()
    const pre = [...activitySection.querySelectorAll('[data-testid="system-pre"]')].map((e) => e.textContent).join('\n')
    expect(pre).toContain('spawning agent…')
    const asv = activitySection.querySelector('[data-testid="agent-session-view"]')
    expect(asv?.getAttribute('data-stage')).toBe('scout')
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
})
