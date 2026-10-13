// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/api/internal'
import { FLIGHT_STAGE_KEYS, type FlightManifest } from '@shared/flights/types'
import { InvalidationProvider } from '@/shared/state/invalidation'
import { mountRoot } from '@/test-helpers/mount-root'

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
  loadPortify: vi.fn(async (_id: string) => {}),
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

vi.mock('@/shared/api/flights', () => ({
  listFlights: mocks.listFlights,
  getFlight: mocks.getFlight,
  getFlightRemedy: mocks.getFlightRemedy,
  applyFlightRemedy: mocks.applyFlightRemedy,
  respondFlightCheckpoint: mocks.respondFlightCheckpoint,
  resumeFlight: mocks.resumeFlight,
  setFlightAutopilot: mocks.setFlightAutopilot,
  abortFlight: mocks.abortFlight,
  pauseFlight: mocks.pauseFlight,
  redoFlight: mocks.redoFlight,
  deleteFlight: mocks.deleteFlight,
  getFlightEntryOptions: mocks.getFlightEntryOptions,
  linkFeatureDocPath: mocks.linkFeatureDocPath,
}))
vi.mock('@/shared/api/runs', () => ({
  getRunDetail: mocks.getRunDetail,
  listJournal: mocks.listJournal,
  listRuns: mocks.listRuns,
  cancelHealRun: mocks.cancelHealRun,
  stopRun: mocks.stopRun,
  restartRun: mocks.restartRun,
}))
vi.mock('@/shared/api/config', () => ({
  getEnvsetSlot: mocks.getEnvsetSlot,
  getEnvsetsIndex: mocks.getEnvsetsIndex,
  getFeatureConfigDoc: mocks.getFeatureConfigDoc,
  getPlaywrightConfig: mocks.getPlaywrightConfig,
  putFeatureConfigDoc: mocks.putFeatureConfigDoc,
  putPlaywrightConfig: mocks.putPlaywrightConfig,
  deleteFeature: mocks.deleteFeature,
}))
vi.mock('@/shared/api/coverage', () => ({
  getFeatureCoverage: mocks.getFeatureCoverage,
  listFeatureDocs: mocks.listFeatureDocs,
  importFeatureDoc: mocks.importFeatureDoc,
  deleteFeatureDoc: mocks.deleteFeatureDoc,
}))
vi.mock('@/shared/api/workspace', () => ({
  getRepoGitStatus: mocks.getRepoGitStatus,
  openEditor: mocks.openEditor,
}))
vi.mock('@/shared/api/internal', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown, message?: string) { super(message ?? `HTTP ${status}`) }
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
vi.mock('@/features/portify/state/PortifyContext', async () => {
  const { detailFixture } = await import('../../portify/state/portify-detail.fixture')
  return ({
  usePortify: () => ({ loadPortify: mocks.loadPortify }),
  usePortifyWorkflow: (id?: string | null) => mocks.portifyWorkflow(id),
  usePortifyDetail: detailFixture(async (id) => { await mocks.loadPortify(id); return mocks.portifyWorkflow(id) }, (id) => mocks.portifyWorkflow(id)),
}) })

// TestRunPanel reads the run detail + the run index off the shared runs store
// (useRun/useRuns); the real provider needs live sockets, so stub the two hooks
// over the SAME api mocks the panel-local fetches used to consume — fixtures
// keep working unchanged.
vi.mock('@/features/runs/state/RunsContext', async () => (await import('./__fixtures__/flight-page-mocks')).runsContextMock(mocks))

import { FlightPage } from './FlightPage'
import { manifest } from './__fixtures__/flight-page-part7-fixtures'
import { renderFlightPage } from './__fixtures__/FlightPageHarness'

;

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
})
mountRoot({ attach: true, onMount: (mounted) => ({ container, root } = mounted) })

// FlightPage reads its refetch keys from the invalidation bus now, not a prop.
// The old tests bumped a `refreshKey` prop to force a re-fetch; here a unique
// remount key per call remounts FlightPage, which re-runs its fetch effect —
// the same observable effect, without a prop lever.
const render = (flightId: string, extraProps?: Record<string, unknown>) => renderFlightPage(root, FlightPage, flightId, extraProps)

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
    // The state word reserves the widest option's width ('off'), so flipping
    // on↔off cannot resize the strip's right-aligned cluster. happy-dom has no
    // layout engine, so the reservation is pinned by class, not by measurement.
    expect(toggle.lastElementChild?.className).toContain('min-w-[3ch]')
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
    expect(container.querySelector('[data-testid="flight-status"]')?.textContent).toBe('Paused')
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

  it('remedy: dirty-repo failure renders the fix block; stash applies and continues', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'paused',
      pauseReason: 'stage-failed',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'portify' ? ('failed' as const) : ('done' as const),
        ...(key === 'portify' ? { error: 'portify start rejected (409): repos "shop", "pay" have uncommitted changes — commit or stash them first' } : {}),
      })),
    }))
    mocks.getFlightRemedy.mockResolvedValue({
      remedy: {
        kind: 'dirty-repos',
        stage: 'portify',
        repos: [
          { name: 'shop', path: '/repo/shop', modified: 7 },
          { name: 'pay', path: '/repo/pay', modified: 2 },
        ],
        actions: ['stash', 'commit'],
      },
    })
    mocks.applyFlightRemedy.mockResolvedValue(manifest({ status: 'running' }))
    await render('fl_1')
    const block = container.querySelector('[data-testid="stage-remedy"]')
    expect(block).toBeTruthy()
    expect(block?.textContent).toContain('Recommended fix')
    expect(block?.textContent).toContain('shop')
    expect(block?.textContent).toContain('7 modified')
    expect(block?.textContent).toContain('pay')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="stage-remedy-stash"]')?.click()
    })
    expect(mocks.applyFlightRemedy).toHaveBeenCalledWith('fl_1', 'stash')
  })

  it('external ownership keeps dirty-repo remedies visible but inert', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' },
      status: 'paused',
      pauseReason: 'stage-failed',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'portify' ? ('failed' as const) : ('done' as const),
        ...(key === 'portify' ? { error: 'repo "shop" has uncommitted changes' } : {}),
      })),
    }))
    mocks.getFlightRemedy.mockResolvedValue({
      remedy: {
        kind: 'dirty-repos',
        stage: 'portify',
        repos: [{ name: 'shop', path: '/repo/shop', modified: 1 }],
        actions: ['stash', 'commit'],
      },
    })
    await render('fl_1')

    for (const id of ['stage-remedy-stash', 'stage-remedy-commit']) {
      const button = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
      expect(button?.disabled).toBe(true)
      expect(button?.title).toContain('from the Claude/Codex session')
      await act(async () => { button?.click() })
    }
    expect(mocks.applyFlightRemedy).not.toHaveBeenCalled()
  })

  it('remedy: a stale error over now-clean repos points at Continue instead of buttons', async () => {
    mocks.getFlight.mockResolvedValue(manifest({
      status: 'paused',
      pauseReason: 'stage-failed',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'portify' ? ('failed' as const) : ('done' as const),
        ...(key === 'portify' ? { error: 'portify start rejected (409): repo "shop" has uncommitted changes — commit or stash them first' } : {}),
      })),
    }))
    mocks.getFlightRemedy.mockResolvedValue({
      remedy: { kind: 'dirty-repos', stage: 'portify', repos: [], actions: ['stash', 'commit'] },
    })
    await render('fl_1')
    const block = container.querySelector('[data-testid="stage-remedy"]')
    expect(block?.textContent).toContain('clean again')
    expect(container.querySelector('[data-testid="stage-remedy-stash"]')).toBeNull()
    expect(container.querySelector('[data-testid="stage-remedy-commit"]')).toBeNull()
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
})

describe('the open flight rides the push channel', () => {
  // Annotated rather than inferred: without it TypeScript pins `currentStage` to
  // the literal `'scout'` and the stage statuses to the two values this object
  // happens to use, so the later push below — which advances to `'scaffold'` and
  // introduces `'done'` — cannot be assigned to the same shape.
  const runningManifest: FlightManifest = {
    flightId: 'fl_1',
    feature: 'checkout',
    repoPaths: ['/repo/shop'],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'running' as const,
    currentStage: 'scout' as const,
    stages: FLIGHT_STAGE_KEYS.map((key) => ({
      key,
      status: key === 'scout' ? ('running' as const) : ('pending' as const),
    })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }

  it('renders the pushed manifest without fetching the flight', async () => {
    // `/ws/flights` snapshots every ACTIVE flight, so the detail view already
    // holds the record before it could ask for one.
    mocks.getFlight.mockRejectedValue(new Error('should not be called'))
    await act(async () => {
      root.render(
        <InvalidationProvider>
          <FlightPage flightId="fl_1" liveFlight={runningManifest} onSelectFlight={vi.fn()} onClose={vi.fn()} />
        </InvalidationProvider>,
      )
    })
    expect(container.querySelector('[data-testid="stage-rail-scout"]')).not.toBeNull()
    expect(container.textContent).toContain('checkout')
  })

  it('a later push advances the view — no refetch, no poll', async () => {
    const render = async (flight: typeof runningManifest) => {
      await act(async () => {
        root.render(
          <InvalidationProvider>
            <FlightPage key="live" flightId="fl_1" liveFlight={flight} onSelectFlight={vi.fn()} onClose={vi.fn()} />
          </InvalidationProvider>,
        )
      })
    }
    await render(runningManifest)
    mocks.getFlight.mockClear()
    await render({
      ...runningManifest,
      currentStage: 'scaffold',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({
        key,
        status: key === 'scout' ? ('done' as const) : key === 'scaffold' ? ('running' as const) : ('pending' as const),
      })),
    })
    expect(container.querySelector('[data-testid="stage-rail-scaffold"]')).not.toBeNull()
    expect(mocks.getFlight).not.toHaveBeenCalled()
  })
})

describe('live edit counts and deleted details', () => {
  it('updates the open Portify tile without reopening the step, then removes a deleted Running detail', async () => {
    const live = (editedFiles: number): FlightManifest => manifest({
      status: 'running', currentStage: 'portify',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: key === 'portify' ? 'running' : 'done',
        ...(key === 'portify' ? { progress: { workflowId: 'editing', status: 'editing', editedFiles } } : {}),
      })),
    })
    const render = (editedFiles: number, missing = false) => act(async () => {
      root.render(<InvalidationProvider><FlightPage flightId="fl_1" liveFlight={missing ? null : live(editedFiles)} missing={missing}
        stage="portify" onSelectStage={vi.fn()} onSelectFlight={vi.fn()} onClose={vi.fn()} /></InvalidationProvider>)
    })
    await render(1)
    expect(container.textContent).toContain('current working-tree changes')
    const tile = () => Array.from(container.querySelectorAll('[data-testid]')).find((el) => el.getAttribute('data-testid')?.includes('fact') && el.textContent?.includes('Files edited'))
    expect(tile()?.textContent).toContain('1')
    await render(2); expect(tile()?.textContent).toContain('2')
    await render(0); expect(tile()?.textContent).toContain('0')
    expect(container.textContent).not.toContain('ports were already swappable')
    await render(0, true)
    expect(container.textContent).toContain('This flight no longer exists.')
    expect(container.textContent).not.toContain('Running')
    expect(container.querySelector('[data-testid="stage-rail-portify"]')).toBeNull()
  })
})


it('reports a confirmed missing detail to the shared Flight index owner', async () => {
  mocks.getFlight.mockRejectedValue(new ApiError(404, { error: 'flight not found' }))
  const onFlightMissing = vi.fn()
  await act(async () => { root.render(<InvalidationProvider><FlightPage flightId="fl_1" onFlightMissing={onFlightMissing} onSelectFlight={vi.fn()} onClose={vi.fn()} /></InvalidationProvider>) })
  expect(onFlightMissing).toHaveBeenCalledExactlyOnceWith('fl_1')
  expect(container.textContent).toContain('This flight no longer exists.')
})
