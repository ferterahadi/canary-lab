// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightManifest } from '../../../shared/api/client'
import { FLIGHT_STAGE_KEYS } from '../../../../../../shared/flights/types'
import { InvalidationProvider } from '../../../shared/state/invalidation'

const mocks = vi.hoisted(() => ({
  listFlights: vi.fn(),
  getFlight: vi.fn(),
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

vi.mock('../../../shared/api/client', () => ({
  listFlights: mocks.listFlights,
  getFlight: mocks.getFlight,
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

  it('R78: autopilot reads + toggles from the facts strip, any status', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'running' }))
    mocks.setFlightAutopilot.mockResolvedValue(manifest({ status: 'running' }))
    await render('fl_1')
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="flight-autopilot-toggle"]')!
    // Absent opts.autopilot = on (the default for every new flight).
    expect(toggle.textContent).toContain('on')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { toggle.click() })
    expect(mocks.setFlightAutopilot).toHaveBeenCalledWith('fl_1', false)
  })

  it('R78: a yolo flight shows autopilot as inert — yolo already skips the checkpoints', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } }))
    await render('fl_1')
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="flight-autopilot-toggle"]')!
    expect(toggle.textContent).toContain('yolo')
    expect(toggle.disabled).toBe(true)
  })

  it('R78: a merged row is not ✓ done while its folded half has not run', async () => {
    // docs approved, then paused before prd-summary ever started: the row used
    // to read the primary alone and claim Requirements ✓ done.
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'paused',
      pauseReason: 'user',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: ['similarity', 'scout', 'scaffold', 'env-capture', 'docs'].includes(key)
          ? ('done' as const)
          : ('pending' as const),
      })),
    }))
    await render('fl_1')
    const row = container.querySelector('[data-testid="stage-rail-docs"]')!
    expect(row.textContent).toContain('Requirements')
    expect(row.textContent).not.toContain('✓')
    // Suite setup, whose folded env-capture DID settle, still reads done.
    expect(container.querySelector('[data-testid="stage-rail-scaffold"]')?.textContent).toContain('✓')
    // …and the panel still opens on that half-finished row, not "Pick a stage."
    expect(row.getAttribute('aria-current')).toBe('true')
  })

  it('R78: Continue names the ROW that resumes — a failed folded companion does not skip the label ahead', async () => {
    // docs done, its folded companion prd-summary failed: the row reads
    // "Requirements", so the resume label must too (it used to scan only the
    // primary keys, see docs as finished, and advertise the NEXT row).
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'paused',
      pauseReason: 'stage-failed',
      error: 'PRD summary requires the claude or codex agent',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'prd-summary'
          ? ('failed' as const)
          : ['similarity', 'scout', 'scaffold', 'env-capture', 'docs'].includes(key)
            ? ('done' as const)
            : ('pending' as const),
      })),
    }))
    await render('fl_1')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })
    expect(container.querySelector('[data-testid="flight-resume"]')?.textContent).toContain('Resume at Requirements')
  })

  it('R74: a paused flight offers Continue ▾ (From here resumes); a running one shows only header Pause', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', error: 'boot failed' }))
    mocks.resumeFlight.mockResolvedValue(manifest())
    await render('fl_1')
    expect(container.querySelector('[data-testid="flight-status"]')?.textContent).toBe('paused')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.click() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-resume"]')?.click() })
    expect(mocks.resumeFlight).toHaveBeenCalledWith('fl_1')

    mocks.getFlight.mockResolvedValue(manifest({ status: 'running' }))
    await render('fl_1')
    // Stop is gone from the GUI entirely; Pause is the labeled header control
    // and the ⋯ menu (Delete-only) hides while active.
    expect(container.querySelector('[data-testid="flight-abort"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-pause"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="flight-menu"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-continue"]')).toBeNull()
  })

  it('R73: a failed stage renders the shared error card (detail only; recovery is the header primary)', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'paused',
      pauseReason: 'stage-failed',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'scout'
          ? ('failed' as const)
          : key === 'similarity'
            ? ('done' as const)
            : ('pending' as const),
        ...(key === 'scout' ? { error: 'agent did not return parseable JSON (got: leftover chatter)' } : {}),
      })),
    }))
    await render('fl_1')
    // The failed stage auto-selects, so its error card is on screen.
    expect(container.querySelector('[data-testid="stage-error"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="stage-error-title"]')?.textContent).toContain('failed')
    expect(container.querySelector('[data-testid="stage-error-detail"]')?.textContent).toContain('parseable JSON')
    // No second Continue in the card — recovery lives on the header's
    // Continue ▾ menu only (R74).
    expect(container.querySelector('[data-testid="stage-error-retry"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-continue"]')).toBeTruthy()
    // No boot errorDetail on this failure → no log-tail section, no open-log.
    expect(container.querySelector('[data-testid="stage-error-log-tail"]')).toBeNull()
    expect(container.querySelector('[data-testid="stage-error-open-log"]')).toBeNull()
  })

  it('boot failure: the error card carries the service-log tail and an open-log action', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'paused',
      pauseReason: 'stage-failed',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'env-capture'
          ? ('failed' as const)
          : key === 'similarity' || key === 'scout' || key === 'scaffold'
            ? ('done' as const)
            : ('pending' as const),
        ...(key === 'env-capture'
          ? {
              error: 'service "oms" crashed during boot — it never reached its health check',
              errorDetail: {
                service: 'oms',
                reason: 'process-exited' as const,
                logPath: '/ws/logs/runs/2026-01-01T0000-x/svc-oms.log',
                logTail: "Unrecognized VM option 'MaxPermSize=512m'\nError: Could not create the Java Virtual Machine.",
              },
            }
          : {}),
      })),
    }))
    await render('fl_1')
    // The folded env-capture failure surfaces on the merged Suite setup row.
    expect(container.querySelector('[data-testid="stage-error-detail"]')?.textContent).toContain('crashed during boot')
    expect(container.querySelector('[data-testid="stage-error-log-tail"]')?.textContent).toContain('Unrecognized VM option')
    expect(container.querySelector('[data-testid="stage-error"]')?.textContent).toContain('Last lines of svc-oms.log')
    // Open full log hands the path to the editor-open API.
    mocks.openEditor.mockResolvedValue({})
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-error-open-log"]')?.click()
    })
    expect(mocks.openEditor).toHaveBeenCalledWith({ file: '/ws/logs/runs/2026-01-01T0000-x/svc-oms.log' })
  })

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

  it('a SKIPPED scaffold still reaches Advanced setup — header action and the synced-live hint', async () => {
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
    // renders it, so both routes into the full editor must be live.
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

    // The hint sentence names Advanced setup — so it must BE the link.
    const hint = container.querySelector<HTMLButtonElement>('[data-testid="setup-open-advanced"]')
    expect(hint?.textContent).toBe('Advanced setup')
    await act(async () => { hint?.click() })
    expect(onOpenConfig).toHaveBeenCalledTimes(2)
  })
})

describe('stage summary + drill-through (R6)', () => {
  async function renderWithDrill(m: FlightManifest, drill: { onOpenRun?: ReturnType<typeof vi.fn>; onOpenCoverage?: ReturnType<typeof vi.fn>; onOpenPortify?: ReturnType<typeof vi.fn> }) {
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
    expect(container.querySelector('[data-testid="stage-rail-scaffold"]')?.textContent).toContain('Suite setup')
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
    expect(rail?.textContent).toContain('Existing suite found')
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

  it('R72: the status chip rides the title line, right of the name', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'done', currentStage: null, stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const })) }))
    await render('fl_1')
    const title = container.querySelector('h1')
    expect(title?.textContent).toContain('checkout')
    expect(title?.querySelector('[data-testid="flight-status"]')?.textContent).toBe('done')
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
    expect(container.querySelector('[data-testid="stage-state-line"]')?.textContent).toBe('Creating the suite in the workspace…')
    expect(container.querySelector('[data-testid="stage-status-chip"]')?.textContent).toContain('generating')
    // Advanced setup only appears once the config is APPROVED (scaffold done).
    expect(container.querySelector('[data-testid="feature-setup-advanced"]')).toBeNull()
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
    await render('fl_1')
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
      .toBe('Suite "checkout" created — env captured (2 files), dry-run boot passed.')
    const facts = container.querySelector('[data-testid="stage-facts"]')?.textContent ?? ''
    expect(facts).toContain('checkout')
    expect(facts).toContain('2 files')
    expect(facts).toContain('api healthy')
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
      .toBe('Scanned 2 repos — suite configuration drafted, 1 environment file detected.')
    expect(container.querySelector('[data-testid="flight-intent-card"]')?.textContent).toContain('Flight input')
    expect(container.querySelector('[data-testid="flight-intent-card"]')?.textContent).toContain('Intent · what to test')
    expect(container.querySelector('[data-testid="flight-intent"]')?.textContent).toContain('checkout flow')
    expect(container.querySelector('[data-testid="repo-scan-output"]')).toBeNull()
    const intentCard = container.querySelector<HTMLElement>('[data-testid="flight-intent-card"]')
    const repoScanCard = container.querySelector<HTMLElement>('[data-testid="repo-scan-card"]')
    expect(repoScanCard?.textContent).toContain('Repos · 2 scanned')
    expect(repoScanCard?.className).toBe(intentCard?.className)
    // R73: the panel fills a fixed 76ch column so the repo cards and a failed
    // stage's error card line up as one column (no shrink-wrap asymmetry).
    expect(container.querySelector('[data-testid="repo-scan-panel"]')?.className).toContain('max-w-[76ch]')
    const shopCard = container.querySelector('[data-testid="repo-card-shop"]')?.textContent ?? ''
    expect(shopCard).toContain('/repo/shop')
    expect(shopCard).toContain('.env')
    const apiCard = container.querySelector('[data-testid="repo-card-api"]')?.textContent ?? ''
    expect(apiCard).toContain('/repo/api')
    expect(apiCard).not.toContain('.env')
    expect(container.querySelector('[data-testid="stage-facts"]')).toBeNull()
    expect(container.querySelector('header')?.textContent).not.toContain('/repo/shop')

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

describe('checkpoint display language (R71/W3)', () => {
  const parkedOn = (key: string, checkpoint: Record<string, unknown>) => manifest({
    status: 'waiting-for-approval',
    stages: FLIGHT_STAGE_KEYS.map((k) => ({
      key: k,
      status: k === key ? ('waiting-for-approval' as const) : ('done' as const),
      ...(k === key ? { checkpoint } : {}),
    })),
  })

  it('renders outcome language + a Recommended tag; the POSTed key stays raw', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('similarity', {
      kind: 'similarity-choice', message: 'checkout already targets this repo.', options: ['rerun', 'enhance', 'new'],
    }))
    mocks.respondFlightCheckpoint.mockResolvedValue(manifest())
    await render('fl_1')
    expect(container.querySelector('[data-testid="checkpoint-title"]')?.textContent).toContain('Existing suite found')
    const first = container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-choice-rerun"]')
    expect(first?.textContent).toContain('Run existing tests')
    expect(first?.textContent).toContain('Recommended')
    expect(container.querySelector('[data-testid="checkpoint-choice-enhance"]')?.textContent).toBe('Update it, then run')
    // No folding at exactly 3 options.
    expect(container.querySelector('[data-testid="checkpoint-more-options"]')).toBeNull()
    await act(async () => { first?.click() })
    expect(mocks.respondFlightCheckpoint).toHaveBeenCalledWith('fl_1', { choice: 'rerun' })
  })

  it('R80: an empty-handed collector surfaces a verdict band and flips the recommendation', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('docs', {
      kind: 'prd-source',
      message: 'The agent found nothing relevant: no loyalty flow in either repo. No requirement docs yet.',
      options: ['collect-repo-docs', 'infer-from-diff'],
      data: {
        docs: [], linked: [], intent: 'checkout flow',
        lastAttempt: { mode: 'collect-repo-docs', outcome: 'empty', reason: 'no loyalty flow in either repo' },
      },
    }))
    await render('fl_1')
    // The verdict reads without expanding Activity, and without being fused
    // into the generic help sentence.
    const verdict = container.querySelector('[data-testid="prd-source-verdict"]')
    expect(verdict?.textContent).toContain('Agent searched the repos')
    expect(verdict?.textContent).toContain('no loyalty flow in either repo')
    // The path that just came back empty is no longer the recommendation.
    expect(container.querySelector('[data-testid="fork-path-agent"]')?.textContent).not.toContain('Recommended')
    expect(container.querySelector('[data-testid="fork-path-agent-note"]')?.textContent).toContain('Tried')
    expect(container.querySelector('[data-testid="fork-path-manual"]')?.textContent).toContain('Recommended')
    // The rail says so too, so it reads from the collapsed stage list.
    expect(container.querySelector('[data-testid="stage-rail-note-docs"]')?.textContent).toBe('empty')
    // The agent path stays clickable — a retry with feedback is legitimate.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-path-agent"]')?.click() })
    expect(container.querySelector('[data-testid="fork-path-agent"]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('R80: the stage prose does NOT echo the verdict the band already shows', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('docs', {
      kind: 'prd-source',
      message: 'The agent found nothing relevant: no loyalty flow in either repo. No requirement docs yet for "x". Add docs yourself, or have an agent gather them guided by the intent.',
      options: ['collect-repo-docs', 'infer-from-diff'],
      data: {
        docs: [], linked: [], intent: 'checkout flow',
        lastAttempt: { mode: 'collect-repo-docs', outcome: 'empty', reason: 'no loyalty flow in either repo' },
      },
    }))
    await render('fl_1')
    // The reason appears exactly once — in the band, not also as stage prose.
    const hits = (container.textContent?.match(/no loyalty flow in either repo/g) ?? []).length
    expect(hits).toBe(1)
    expect(container.querySelector('[data-testid="prd-source-verdict"]')?.textContent).toContain('no loyalty flow')
    // And the advice the two cards already carry is not repeated as prose.
    expect(container.textContent).not.toContain('Add docs yourself, or have an agent gather them')
  })

  it('R80: a no-diff attempt names that outcome instead of "found nothing"', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('docs', {
      kind: 'prd-source', message: 'No meaningful diff vs the base branch was found.',
      options: ['collect-repo-docs', 'infer-from-diff'],
      data: { docs: [], linked: [], intent: 'checkout flow', lastAttempt: { mode: 'infer-from-diff', outcome: 'no-diff' } },
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="prd-source-verdict"]')?.textContent).toContain('No diff vs base')
    expect(container.querySelector('[data-testid="fork-path-agent-note"]')?.textContent).toContain('No diff')
  })

  it('R80: a first visit shows no verdict and keeps the agent path recommended', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('docs', {
      kind: 'prd-source', message: 'No requirement docs yet.', options: ['collect-repo-docs', 'infer-from-diff'],
      data: { docs: [], linked: [], intent: 'checkout flow' },
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="prd-source-verdict"]')).toBeNull()
    expect(container.querySelector('[data-testid="stage-rail-note-docs"]')).toBeNull()
    expect(container.querySelector('[data-testid="fork-path-agent"]')?.textContent).toContain('Recommended')
    expect(container.querySelector('[data-testid="fork-path-manual"]')?.textContent).not.toContain('Recommended')
  })

  it('folds a 4+-option checkpoint behind More options', async () => {
    // prd-source renders as the fork (R74), so folding is exercised on a
    // generic kind — the mechanism stays for any future many-option ask.
    mocks.getFlight.mockResolvedValue(parkedOn('scout', {
      kind: 'future-kind', message: 'Pick one.', options: ['first', 'second', 'third', 'fourth'],
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="checkpoint-choice-first"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="checkpoint-choice-second"]')).toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-more-options"]')?.click() })
    expect(container.querySelector('[data-testid="checkpoint-choice-second"]')?.textContent).toBe('second')
    expect(container.querySelector('[data-testid="checkpoint-more-options"]')).toBeNull()
  })

  it('R74: prd-source parks as the two-path fork — intent row, no generic checkpoint card', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('docs', {
      kind: 'prd-source', message: 'No requirement docs yet.', options: ['collect-repo-docs', 'infer-from-diff'],
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="requirements-fork"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="checkpoint-controls"]')).toBeNull()
    // The frozen intent rides the fork, folded.
    expect(container.querySelector('[data-testid="fork-intent-text"]')?.textContent).toContain('checkout flow')
    // Manual path: the drop zone appears, and the release is disabled with 0 docs.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-path-manual"]')?.click() })
    expect(container.querySelector('[data-testid="empty-dropzone"]')).toBeTruthy()
    expect(container.querySelector<HTMLButtonElement>('[data-testid="fork-use-docs"]')?.disabled).toBe(true)
    // Both path cards STAY visible after a pick (the selection is never
    // hidden) — switching is one click on the other card, no Back step.
    expect(container.querySelector('[data-testid="fork-path-manual"]')?.getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('[data-testid="fork-path-agent"]')).toBeTruthy()
    mocks.respondFlightCheckpoint.mockResolvedValue(manifest())
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-path-agent"]')?.click() })
    expect(container.querySelector('[data-testid="fork-path-agent"]')?.getAttribute('aria-checked')).toBe('true')
    // Agent path: no hint picked yet → the release is disabled, nothing spawns.
    expect(container.querySelector<HTMLButtonElement>('[data-testid="fork-start-agent"]')?.disabled).toBe(true)
    // Picking a hint only stages it — the agent starts on the confirm button.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-hint-collect-repo-docs"]')?.click() })
    expect(mocks.respondFlightCheckpoint).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="fork-hint-collect-repo-docs"]')?.getAttribute('aria-checked')).toBe('true')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-start-agent"]')?.click() })
    expect(mocks.respondFlightCheckpoint).toHaveBeenCalledWith('fl_1', { choice: 'collect-repo-docs' })
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

  it('an unmapped kind/option degrades to its raw key, never blank', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('scout', {
      kind: 'future-kind', message: 'New question.', options: ['yes-do-it'],
    }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="checkpoint-title"]')?.textContent).toBe('future-kind')
    expect(container.querySelector('[data-testid="checkpoint-choice-yes-do-it"]')?.textContent).toContain('yes-do-it')
  })
})

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
    expect(container.querySelector('[data-testid="strip-elapsed"]')?.textContent).toContain('Elapsed so far')
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
    expect(strip()).toContain('claude')

    mocks.getFlight.mockResolvedValue(manifest({ status: 'running', opts: { env: 'local', coverageTarget: 100, yolo: false, agent: 'codex' } }))
    await render('fl_1')
    expect(container.querySelector('[data-testid="flight-summary-strip"]')?.textContent).toContain('codex')
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
    await render('fl_1', { activity, onOpenRun })
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
})
