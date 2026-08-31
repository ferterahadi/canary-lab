// @vitest-environment happy-dom

import { act } from 'react'

import { createRoot, type Root } from 'react-dom/client'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'
import type { FlightCheckpoint } from '@shared/flights/types'

import { InvalidationProvider } from '@/shared/state/invalidation'

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

import { manifest } from './__fixtures__/flight-page-part7-fixtures'

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

;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

describe('checkpoint display language (R71/W3)', () => {
  const parkedOn = (key: string, checkpoint: FlightCheckpoint, over: Record<string, unknown> = {}) => manifest({
    status: 'waiting-for-approval',
    stages: FLIGHT_STAGE_KEYS.map((k) => ({
      key: k,
      status: k === key ? ('waiting-for-approval' as const) : ('done' as const),
      ...(k === key ? { checkpoint } : {}),
    })),
    ...over,
  })

  /** A hand-off ONLY happens on an externally driven flight — the checkpoint
   *  kind and the producer always travel together in production, so a fixture
   *  that sets one without the other tests a state that cannot occur. */
  const externallyDriven = { opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' } }

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
    expect(container.querySelector('[data-testid="prd-source-verdict"]')?.textContent).toContain('Nothing changed vs. the base branch')
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
      // `future-kind` is not in `FlightCheckpointKind` on purpose: this case
      // simulates a NEWER server sending a kind this build has never heard of,
      // which is the whole point of the raw-key fallback being tested. The cast
      // is the honest spelling — checkpoints arrive over the wire, where the
      // union is a claim about the peer rather than something tsc can check.
    mocks.getFlight.mockResolvedValue(parkedOn('scout', {
      kind: 'future-kind', message: 'Pick one.', options: ['first', 'second', 'third', 'fourth'],
    } as unknown as FlightCheckpoint))
    await render('fl_1')
    expect(container.querySelector('[data-testid="checkpoint-choice-first"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="checkpoint-choice-second"]')).toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-more-options"]')?.click() })
    expect(container.querySelector('[data-testid="checkpoint-choice-second"]')?.textContent).toBe('second')
    expect(container.querySelector('[data-testid="checkpoint-more-options"]')).toBeNull()
  })

  it('portify-apply "Request changes" opens the feedback composer and responds with choice+feedback', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('portify', {
      kind: 'portify-apply', message: 'Save the overlay?', options: ['apply', 'revise', 'cancel'],
      data: { workflowId: 'wf1', diff: '--- a/x\n+++ b/x' },
    }))
    await render('fl_1')
    // The revise button toggles the composer — it never fires a bare respond.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-choice-revise"]')?.click() })
    expect(mocks.respondFlightCheckpoint).not.toHaveBeenCalled()
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="checkpoint-revise-feedback"]')!
    expect(textarea).toBeTruthy()
    // Empty feedback can't send (the server requires it).
    expect(container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-revise-submit"]')?.disabled).toBe(true)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'use env vars, not args')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    mocks.respondFlightCheckpoint.mockResolvedValue(manifest())
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="checkpoint-revise-submit"]')?.click() })
    expect(mocks.respondFlightCheckpoint).toHaveBeenCalledWith('fl_1', { choice: 'revise', feedback: 'use env vars, not args' })
  })

  it('an external-work hand-off is running Activity with takeover as its only header action', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('scout', {
      kind: 'external-work',
      message: 'Run this scout step in your own client, then respond with the result on `data`.',
      options: ['submit', 'run-internally'],
      data: { stage: 'scout', prompt: 'scan the repo', handOffId: 'ab12cd34' },
    }, externallyDriven))
    await render('fl_1')
    // A hand-off is work in progress, not a human checkpoint. Its protocol
    // answers do not become disabled buttons or a second card in the page.
    expect(container.querySelector('[data-testid="checkpoint-controls"]')).toBeNull()
    expect(container.querySelector('[data-testid="checkpoint-choice-submit"]')).toBeNull()
    expect(container.querySelector('[data-testid="checkpoint-choice-run-internally"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-primary-respond"]')).toBeNull()
    expect(container.querySelector('[data-testid="flight-pause"]')).toBeNull()
    expect(container.querySelector('[data-testid="external-session-activity"]')?.textContent)
      .toBe('Work is continuing in your external agent session.')
    expect(container.textContent).not.toContain('respond with the result on')
    expect(container.textContent).toContain('Canary handed this step to the agent that started the flight')

    // Takeover remains reachable in the header. It first explains the
    // handshake, then records a request without starting local work.
    mocks.requestFlightTakeover.mockResolvedValue(manifest())
    const request = container.querySelector<HTMLButtonElement>('[data-testid="flight-request-takeover"]')
    expect(request?.disabled).toBe(false)
    await act(async () => { request?.click() })
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('will not start local work until that agent acknowledges')
    const confirm = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Request takeover')
    await act(async () => { confirm?.click() })
    expect(mocks.requestFlightTakeover).toHaveBeenCalledWith('fl_1')
    expect(mocks.respondFlightCheckpoint).not.toHaveBeenCalled()
  })

  it('a requested takeover waits for release and gates force behind a risk confirmation', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('scout', {
      kind: 'external-work',
      message: 'hand-off',
      options: ['submit', 'run-internally'],
      data: {
        stage: 'scout',
        handOffId: 'ff00ff00',
        takeoverRequestedAt: '2026-08-25T01:00:00.000Z',
      },
    }, externallyDriven))
    mocks.forceFlightTakeover.mockResolvedValue(manifest())
    await render('fl_1')

    expect(container.querySelector('[data-testid="external-session-activity"]')?.textContent)
      .toContain('Waiting for your agent to release this step')
    expect(container.querySelector('[data-testid="flight-request-takeover"]')).toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="flight-force-takeover"]')?.click() })
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('same files may be changed concurrently')
    expect(mocks.forceFlightTakeover).not.toHaveBeenCalled()
    const confirm = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Force takeover')
    await act(async () => { confirm?.click() })
    expect(mocks.forceFlightTakeover).toHaveBeenCalledWith('fl_1')
  })

  it('names a discarded late result, so a re-park is not mistaken for the first ask', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('scout', {
      kind: 'external-work',
      message: 'hand-off',
      options: ['submit', 'run-internally'],
      data: { stage: 'scout', handOffId: 'ff00ff00', lastRejection: 'stale_submission' },
    }, externallyDriven))
    await render('fl_1')
    expect(container.querySelector('[data-testid="external-session-activity"]')?.textContent)
      .toBe('A late result from an earlier attempt was ignored. This step is still running in your agent.')
    expect(container.querySelector('[data-testid="checkpoint-controls"]')).toBeNull()
  })

  it('R74: the requirements fork goes inert when the agent owns the answer', async () => {
    mocks.getFlight.mockResolvedValue(parkedOn('docs', {
      kind: 'prd-source', message: 'No requirement docs yet.', options: ['collect-repo-docs', 'infer-from-diff'],
    }, externallyDriven))
    await render('fl_1')
    // The question still renders — a viewer wants to know what it stopped on.
    expect(container.querySelector('[data-testid="requirements-fork"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="requirements-fork-read-only"]')).toBeNull()
    for (const id of ['fork-path-manual', 'fork-path-agent']) {
      const button = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
      expect(button?.disabled).toBe(true)
      expect(button?.title).toContain('from the Claude/Codex session')
    }
    // Disabled cards mean `mode` never leaves null, so no path content mounts.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="fork-path-manual"]')?.click() })
    expect(container.querySelector('[data-testid="fork-use-docs"]')).toBeNull()
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
})
