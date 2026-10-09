// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLIGHT_STAGE_KEYS, type FlightStageKey } from '@shared/flights/types'
import { InvalidationProvider } from '@/shared/state/invalidation'
import { LEDGER } from '@/features/coverage/components/__fixtures__/CoverageLedgerPage.part2-fixtures'
import { mountRoot } from '@/test-helpers/mount-root'

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
  requestFlightTakeover: mocks.requestFlightTakeover,
  forceFlightTakeover: mocks.forceFlightTakeover,
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
vi.mock('@/shared/api/internal', async () => (await import('./__fixtures__/flight-page-mocks')).apiInternalMock())

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

describe('flight controls (R48/R71)', () => {
  it.each([
    ['scout', 'Repo scan'], ['scaffold', 'Suite setup'], ['docs', 'Requirements'],
    ['specs-coverage', 'Tests & coverage'], ['run', 'Test run'],
    ['evaluation-export', 'Evaluation report'], ['portify', 'Parallel setup'],
  ] as const)('integrates one shared evidence toolbar for %s', async (stage, label) => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', currentStage: stage }))
    await render('fl_1', { stage, onSelectStage: vi.fn() })
    const card = container.querySelector('[data-testid="stage-facts-card"]')!
    const toolbar = card.querySelector('[data-testid="stage-evidence-toolbar"]')!
    expect(toolbar.querySelector('h2')?.textContent).toBe(label)
    expect(toolbar.querySelector('[data-testid="stage-status-chip"]')).not.toBeNull()
    expect(toolbar.querySelector('[data-testid="stage-actions"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="stage-evidence-toolbar"]')).toHaveLength(1)
    expect(toolbar.querySelectorAll('[data-testid="stage-status-chip"]')).toHaveLength(1)
    expect(card.contains(container.querySelector('[data-testid="stage-facts"]'))).toBe(true)
  })

  it('keeps one guarded recovery action in the header and links Paused to the affected stage', async () => {
    const record = manifest({ status: 'paused', pauseReason: 'stage-failed', currentStage: 'specs-coverage',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: key === 'specs-coverage' ? 'failed' : 'done',
        ...(key === 'specs-coverage' ? { error: "agent exited with code 2: unexpected argument '--full-auto'", endedAt: '2026-01-01T00:01:00Z' } : {}),
      })),
      attention: { state: 'actionable', stage: 'specs-coverage', title: 'Flight paused: Tests & coverage agent failed',
        reason: 'Coverage is 45%; target is 100%.', checkedAt: 'now', revision: 'a' },
    })
    mocks.getFlight.mockResolvedValue(record)
    let reject!: (error: Error) => void
    mocks.resumeFlight.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    // Explicitly browsing run history must not conceal a flight-level pause.
    const onSelectStage = vi.fn()
    await render('fl_1', { stage: 'run', onSelectStage })
    expect(container.querySelector('[data-testid="flight-attention"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-attention-summary"]')).toBeNull()
    const chip = container.querySelector<HTMLButtonElement>('button[data-testid="flight-status"]')!
    expect(chip.title).toContain('Coverage is 45%')
    await act(async () => chip.click())
    expect(onSelectStage).toHaveBeenCalledWith('specs-coverage')
    const button = container.querySelector<HTMLButtonElement>('header [data-testid="flight-continue"]')!
    expect(button.textContent).toBe('Resume at Tests & coverage')
    expect(container.querySelectorAll('[data-testid="flight-continue"]')).toHaveLength(1)
    await act(async () => { button.click(); button.click() })
    expect(mocks.resumeFlight).toHaveBeenCalledTimes(1)
    expect(container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.disabled).toBe(true)
    await act(async () => reject(new Error('Agent unavailable')))
    expect(container.querySelector('[data-testid="flight-action-error"]')?.textContent).toContain('Agent unavailable')
    expect(container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')?.disabled).toBe(false)
  })

  it('routes the attention recovery to stale Requirements instead of retrying the later failed stage', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', pauseReason: 'stage-failed', currentStage: 'specs-coverage',
      attention: { state: 'actionable', stage: 'specs-coverage', remainingStage: 'prd-summary', title: 'Flight paused',
        reason: 'Requirements must be refreshed', checkedAt: 'now', revision: 'a' },
    }))
    await render('fl_1')
    const button = container.querySelector<HTMLButtonElement>('header [data-testid="flight-continue"]')!
    expect(button.textContent).toBe('Run from Requirements')
    await act(async () => button.click())
    expect(container.querySelector('[data-testid="flight-redo-docs"]')?.getAttribute('aria-checked')).toBe('true')
    expect(mocks.resumeFlight).not.toHaveBeenCalled()
  })

  it('shows a compact stage reason and opens the historical failure in Activity only on request', async () => {
    const ledger = structuredClone(LEDGER)
    mocks.getFeatureCoverage.mockResolvedValue(ledger)
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', pauseReason: 'stage-failed', currentStage: 'specs-coverage',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: key === 'specs-coverage' ? 'failed' : 'done',
        ...(key === 'specs-coverage' ? { error: 'Recorded launch failure\nFull diagnostics', endedAt: '2026-01-01T00:01:00Z' } : {}),
      })),
      attention: { state: 'actionable', stage: 'specs-coverage', title: 'Flight paused', reason: 'Mapping is stale', checkedAt: 'now', revision: 'a' },
    }))
    const onOpenLog = vi.fn()
    await render('fl_1', { stage: 'specs-coverage', onSelectStage: vi.fn(), onOpenLog })
    expect(container.querySelector('[data-testid="flight-attention"]')).toBeNull()
    const summary = container.querySelector('[data-testid="flight-attention-summary"]')!
    expect(summary.textContent).toContain('Coverage is out of date')
    expect(summary.textContent).toContain('Target 100%')
    expect(container.querySelector('[data-testid="stage-status-chip"]')?.textContent).toBe('Out of date')
    expect(container.querySelector('[data-testid="stage-rail-specs-coverage"]')?.getAttribute('aria-label')).toContain('Mapping is stale')
    expect(container.querySelector('[data-testid="stage-facts-card"]')?.contains(summary)).toBe(true)
    expect(container.textContent).not.toContain('Full diagnostics')
    expect(container.querySelector('[data-testid="stage-error-detail"]')).toBeNull()
    await act(async () => summary.querySelector<HTMLButtonElement>('button')!.click())
    expect(onOpenLog).toHaveBeenCalledWith(expect.stringMatching(/^system:/))
    expect(container.querySelector('[data-testid="stage-activity"]')?.textContent).toContain('Full diagnostics')
    expect(mocks.resumeFlight).not.toHaveBeenCalled()
  })

  it('resolves and recovers attention in the already-open view without erasing history or starting work', async () => {
    vi.useFakeTimers()
    try {
      const record = manifest({ status: 'paused', pauseReason: 'stage-failed', currentStage: 'specs-coverage',
        stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: key === 'specs-coverage' ? 'failed' : 'done',
          ...(key === 'specs-coverage' ? { error: 'Old launch error' } : {}),
        })),
        error: 'Old launch error', attention: { state: 'actionable', stage: 'specs-coverage', title: 'Flight paused',
          reason: 'Below target', checkedAt: 'now', revision: 'a' },
      })
      mocks.getFlight.mockResolvedValue(record)
      await render('fl_1')
      const notice = container.querySelector('[data-testid="flight-attention-summary"]')
      mocks.getFlight.mockResolvedValue({ ...record, attention: { ...record.attention, state: 'resolved',
        title: 'Earlier failure resolved by current evidence.', reason: 'Remaining: Evaluation report', revision: 'b' } })
      await act(async () => vi.advanceTimersByTimeAsync(5000))
      expect(container.querySelector('[data-testid="flight-attention-summary"]')).toBe(notice)
      expect(notice?.textContent).toContain('Earlier failure resolved by current evidence.')
      expect(notice?.textContent).toContain('View earlier failure')
      expect(container.textContent).not.toContain('Old launch error')
      expect(container.querySelector('[data-testid="flight-continue"]')).toBeNull()
      expect(container.querySelector('[data-testid="stage-error"]')).toBeNull()
      expect(mocks.resumeFlight).not.toHaveBeenCalled()
      expect(container.querySelector('[data-testid="stage-status-chip"]')?.textContent).toBe('✓Verified')
      expect(container.querySelector('[data-testid="stage-rail-specs-coverage"]')?.getAttribute('aria-label')).toContain('Earlier failure resolved')
      mocks.getFlight.mockResolvedValue({ ...record, attention: { ...record.attention, state: 'unavailable', reason: 'Could not verify current state', revision: 'c' } })
      await act(async () => vi.advanceTimersByTimeAsync(5000))
      expect(notice?.textContent).toContain('Could not verify current state')
      expect(container.querySelector('[data-testid="stage-status-chip"]')?.textContent).toBe('Unverified')
      expect(container.querySelector('[data-testid="stage-rail-specs-coverage"]')?.getAttribute('aria-label')).toContain('Could not verify current state')
      expect(container.querySelector('header')?.textContent).toContain('Check again')
    } finally { vi.useRealTimers() }
  })

  it('updates the rail warning and recovery menu while the Flight stays open', async () => {
    vi.useFakeTimers()
    try {
      const ledger = structuredClone(LEDGER)
      ledger.freshness = { ...ledger.freshness!, state: 'current', reasons: [], nextAction: undefined }
      const stale = structuredClone(LEDGER)
      stale.freshness!.nextAction = { stage: 'specs-coverage', command: 'start_external_coverage', label: 'Update coverage mappings', arguments: { feature: 'checkout' } }
      mocks.getFeatureCoverage.mockResolvedValue(ledger)
      mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', currentStage: 'run', stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: key === 'specs-coverage' ? 'done' : 'pending' })) }))
      await render('fl_1')
      const rail = () => container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-specs-coverage"]')!
      expect(rail().textContent).toContain('✓')
      mocks.getFeatureCoverage.mockResolvedValue(stale)
      await act(async () => vi.advanceTimersByTimeAsync(5000))
      expect(rail().getAttribute('aria-label')).toContain('Coverage out of date')
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')!.click())
      expect(container.querySelector('[data-testid="flight-coverage-recover"]')).toBeTruthy()
      mocks.getFeatureCoverage.mockResolvedValue(ledger)
      await act(async () => vi.advanceTimersByTimeAsync(5000))
      expect(rail().textContent).toContain('✓')
      expect(container.querySelector('[data-testid="flight-coverage-recover"]')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it.each(['run', 'specs-coverage'] as const)('offers compact stale-coverage recovery while viewing %s', async (selectedStage) => {
    const ledger = structuredClone(LEDGER)
    ledger.freshness!.nextAction = { stage: 'specs-coverage', command: 'start_external_coverage', label: 'Update coverage mappings', arguments: { feature: 'checkout' } }
    mocks.getFeatureCoverage.mockResolvedValue(ledger)
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', currentStage: 'run', stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: key === 'specs-coverage' ? 'done' : 'pending' })) }))
    mocks.redoFlight.mockResolvedValue(manifest({ status: 'running' }))
    await render('fl_1')
    const rail = container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-specs-coverage"]')!
    expect(rail.textContent).not.toContain('✓')
    expect(rail.getAttribute('aria-label')).toContain('Coverage out of date')
    expect(rail.getAttribute('title')).toBeNull()
    act(() => { rail.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent)
      .toBe('Coverage out of date.')
    expect(container.querySelector('[data-testid="coverage-freshness-notice"]')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="stage-rail-${selectedStage}"]`)!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')!.click())
    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(3)
    expect(container.querySelector('[data-testid="flight-resume"]')?.textContent).toContain('Resume at Test run')
    const recovery = container.querySelector<HTMLButtonElement>('[data-testid="flight-coverage-recover"]')!
    expect(recovery.textContent).toContain('Run from Tests & coverage')
    await act(async () => recovery.click())
    expect(container.querySelector('[data-testid="flight-redo-specs-coverage"]')?.getAttribute('aria-checked')).toBe('true')
    expect(mocks.redoFlight).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-submit"]')!.click())
    expect(mocks.redoFlight).toHaveBeenCalledWith('fl_1', { fromStage: 'specs-coverage', feedback: undefined })
  })

  it('starts recovery at Requirements when the source changed, and preserves prerequisite checks', async () => {
    mocks.getFeatureCoverage.mockResolvedValue(structuredClone(LEDGER))
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', currentStage: 'run' }))
    mocks.getFlightEntryOptions.mockResolvedValue({ stages: [{ key: 'docs', allowed: false, reason: 'Missing source' }] })
    await render('fl_1')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')!.click())
    const recovery = container.querySelector<HTMLButtonElement>('[data-testid="flight-coverage-recover"]')!
    expect(recovery.textContent).toContain('Run from Requirements')
    await act(async () => recovery.click())
    expect(container.querySelector<HTMLButtonElement>('[data-testid="flight-redo-submit"]')!.disabled).toBe(true)
    expect(mocks.redoFlight).not.toHaveBeenCalled()
  })

  it('keeps the missing-requirements warning short on both affected steps', async () => {
    const ledger = structuredClone(LEDGER)
    ledger.freshness = {
      ...ledger.freshness!, state: 'not-measured', reasons: ['Requirements have not been generated.'],
      nextAction: { stage: 'prd-summary', command: 'start_external_summary', label: 'Generate requirements & coverage', arguments: { feature: 'checkout' } },
    }
    mocks.getFeatureCoverage.mockResolvedValue(ledger)
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', currentStage: 'docs' }))
    await render('fl_1')
    for (const key of ['docs', 'specs-coverage']) {
      const rail = container.querySelector<HTMLButtonElement>(`[data-testid="stage-rail-${key}"]`)!
      expect(rail.getAttribute('aria-label')).toContain('Requirements missing; coverage not measured.')
      act(() => rail.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Requirements missing; coverage not measured.')
      act(() => rail.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    }
  })

  it('shows only recovery when Resume would enter the same stage', async () => {
    mocks.getFeatureCoverage.mockResolvedValue(structuredClone(LEDGER))
    mocks.getFlight.mockResolvedValue(manifest({ status: 'paused', currentStage: 'prd-summary' }))
    await render('fl_1')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-specs-coverage"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="flight-continue"]')!.click())

    expect(container.querySelector('[data-testid="flight-resume"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-coverage-recover"]')?.textContent)
      .toContain('Run from Requirements')
    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(2)
  })

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

  it('uses one short custom tooltip for a rail row', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ stages: runningStages() }))
    await render('fl_1')
    const row = container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-scout"]')!
    expect(row.getAttribute('title')).toBeNull()
    act(() => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent)
      .toBe('Checks your repo and how to start it.')
  })

  it('the Follow chip spends its one sky accent on the dot, and only while following', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ stages: runningStages() }))
    await render('fl_1')
    // Following is the default and a click there is a no-op, so the pressed chip
    // must not be the loudest thing in the rail: text and border keep
    // `.cl-button`'s neutral ink and the dot is the only sky element.
    const following = container.querySelector<HTMLButtonElement>('[data-testid="rail-following"]')!
    expect(following.style.color).toBe('')
    expect(following.style.borderColor).toBe('')
    expect(following.querySelector<HTMLElement>('[aria-hidden="true"]')?.style.color).toBe('var(--accent)')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click() })
    // Parked, it is a plain resume button — the ↺ carries no accent either.
    const resume = container.querySelector<HTMLButtonElement>('[data-testid="rail-resume-follow"]')!
    expect(resume.style.color).toBe('')
    expect(resume.querySelector<HTMLElement>('[aria-hidden="true"]')?.style.color).toBe('')
  })

  it('the Follow chip explains each state in the shared tooltip, not a native title', async () => {
    mocks.getFlight.mockResolvedValue(manifest({ stages: runningStages() }))
    await render('fl_1')
    const following = container.querySelector<HTMLButtonElement>('[data-testid="rail-following"]')!
    expect(following.getAttribute('title')).toBeNull()
    act(() => { following.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Following whichever step needs you')
    act(() => { following.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="stage-rail-run"]')?.click() })
    const resume = container.querySelector<HTMLButtonElement>('[data-testid="rail-resume-follow"]')!
    expect(resume.getAttribute('title')).toBeNull()
    act(() => { resume.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Go back to following the step that needs you')
  })
})
