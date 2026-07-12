// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightEntryOptions } from '../../../shared/api/client'

const mocks = vi.hoisted(() => ({
  getFlightEntryOptions: vi.fn(),
  startFlight: vi.fn(),
  planFeatures: vi.fn(),
  getPlanFeaturesTask: vi.fn(),
  launchPlannedFeatures: vi.fn(),
  listWorkspaceDirs: vi.fn(),
}))

vi.mock('../../../shared/api/client', async (importOriginal) => ({
  // Keep ApiError (the dialog branches on it for the server's error body).
  ...(await importOriginal<typeof import('../../../shared/api/client')>()),
  getFlightEntryOptions: mocks.getFlightEntryOptions,
  startFlight: mocks.startFlight,
  planFeatures: mocks.planFeatures,
  getPlanFeaturesTask: mocks.getPlanFeaturesTask,
  launchPlannedFeatures: mocks.launchPlannedFeatures,
  // The repo picker reuses FolderPickerModal, which lists dirs via this.
  listWorkspaceDirs: mocks.listWorkspaceDirs,
}))

// The planning view embeds the live agent timeline — its transports are its
// own tested concern; stub it.
vi.mock('../../agent-sessions/components/AgentSessionView', () => ({
  AgentSessionView: ({ source }: { source: { kind: string } }) => (
    <div data-testid="agent-session-view" data-kind={source.kind} />
  ),
}))

import { ApiError } from '../../../shared/api/client'
import { FlightStartDialog } from './FlightStartDialog'
import { STAGE_BLURB } from './stage-meta'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve() })
}

function entry(over: Partial<FlightEntryOptions> = {}): FlightEntryOptions {
  return {
    feature: 'checkout',
    flight: null,
    active: false,
    canContinue: false,
    prefill: { repoPaths: ['/repo'], description: '', env: 'local', coverageTarget: 100 },
    stages: [
      { key: 'similarity', allowed: true },
      { key: 'scout', allowed: true },
      { key: 'scaffold', allowed: true },
      { key: 'env-capture', allowed: true },
      { key: 'docs', allowed: false, reason: 'no captured envset at envsets/local/' },
      { key: 'prd-summary', allowed: false, reason: 'no captured envset at envsets/local/' },
      { key: 'specs-coverage', allowed: false, reason: 'no captured envset at envsets/local/' },
      { key: 'portify', allowed: false, reason: 'no captured envset at envsets/local/' },
      { key: 'run', allowed: false, reason: 'no captured envset at envsets/local/' },
      { key: 'heal', allowed: false, reason: 'cannot start at "heal"' },
      { key: 'evaluation-export', allowed: false, reason: 'no run yet' },
    ],
    ...over,
  }
}

async function render(props: Partial<Parameters<typeof FlightStartDialog>[0]> = {}) {
  const onClose = vi.fn()
  const onOpenFlight = vi.fn()
  await act(async () => {
    root.render(<FlightStartDialog feature="checkout" onClose={onClose} onOpenFlight={onOpenFlight} {...props} />)
  })
  await flush()
  return { onClose, onOpenFlight }
}

const byTestId = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`)
const click = (el: Element): void => { act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

describe('FlightStartDialog', () => {
  it('renders the server verdict per stage: allowed rows clickable, blocked rows disabled with the reason', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(entry())
    await render()

    expect(mocks.getFlightEntryOptions).toHaveBeenCalledWith('checkout')
    const scout = byTestId('flight-start-stage-scout') as HTMLButtonElement
    expect(scout.disabled).toBe(false)
    const run = byTestId('flight-start-stage-run') as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.textContent).toContain('no captured envset')
    // heal is not a pickable step at all — it's run-driven.
    expect(byTestId('flight-start-stage-heal')).toBeNull()
  })

  it('attaches to an active flight instead of offering a start', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(entry({
      active: true,
      flight: { flightId: 'fl_live', status: 'running', stages: [] },
    }))
    const { onOpenFlight } = await render()

    expect(byTestId('flight-start-submit')).toBeNull()
    click(byTestId('flight-start-open-active')!)
    expect(onOpenFlight).toHaveBeenCalledWith('fl_live')
    expect(mocks.startFlight).not.toHaveBeenCalled()
  })

  it('preselects Continue for a paused flight and posts mode continue', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(entry({
      canContinue: true,
      flight: { flightId: 'fl_1', status: 'paused', stages: [{ key: 'scout', status: 'done' }] },
      prefill: { repoPaths: ['/repo'], description: 'checkout flow', env: 'local', coverageTarget: 100 },
    }))
    mocks.startFlight.mockResolvedValue({ flightId: 'fl_1' })
    const { onOpenFlight } = await render()

    const submit = byTestId('flight-start-submit') as HTMLButtonElement
    expect(submit.textContent).toBe('Continue flight')
    click(submit)
    await flush()
    expect(mocks.startFlight).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'checkout',
      mode: 'continue',
    }))
    // Frozen args (R57): a record exists, so repos + intent are omitted — the
    // server reuses the stored values.
    const body = mocks.startFlight.mock.calls[0][0] as Record<string, unknown>
    expect(body.repoPaths).toBeUndefined()
    expect(body.description).toBeUndefined()
    expect(onOpenFlight).toHaveBeenCalledWith('fl_1')
  })

  it('posts mode jump + fromStage when a stage is picked on a feature with a flight record', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(entry({
      flight: { flightId: 'fl_1', status: 'done', stages: [{ key: 'run', status: 'done' }] },
      prefill: { repoPaths: ['/repo'], description: 'checkout flow', env: 'local', coverageTarget: 100 },
      stages: entry().stages.map((s) => (s.key === 'heal' ? s : { key: s.key, allowed: true })),
    }))
    mocks.startFlight.mockResolvedValue({ flightId: 'fl_2' })
    const { onOpenFlight } = await render()

    click(byTestId('flight-start-stage-run')!)
    click(byTestId('flight-start-submit')!)
    await flush()
    expect(mocks.startFlight).toHaveBeenCalledWith(expect.objectContaining({ mode: 'jump', fromStage: 'run' }))
    expect(onOpenFlight).toHaveBeenCalledWith('fl_2')
  })

  it('posts mode redo when "from the beginning" is picked on a feature with a flight record', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(entry({
      flight: { flightId: 'fl_1', status: 'failed', stages: [] },
      prefill: { repoPaths: ['/repo'], description: 'checkout flow', env: 'local', coverageTarget: 100 },
    }))
    mocks.startFlight.mockResolvedValue({ flightId: 'fl_1' })
    await render()

    click(byTestId('flight-start-stage-similarity')!)
    click(byTestId('flight-start-submit')!)
    await flush()
    const body = mocks.startFlight.mock.calls[0][0] as Record<string, unknown>
    expect(body.mode).toBe('redo')
    expect(body.fromStage).toBeUndefined()
  })

  it('requires a description and a picked step before it will start (fresh feature: no mode)', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(entry())
    await render()

    const submit = byTestId('flight-start-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true) // nothing picked, empty description

    click(byTestId('flight-start-stage-scout')!)
    expect(submit.disabled).toBe(true) // still no description

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'the checkout flow')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect((byTestId('flight-start-submit') as HTMLButtonElement).disabled).toBe(false)

    mocks.startFlight.mockResolvedValue({ flightId: 'fl_new' })
    click(byTestId('flight-start-submit')!)
    await flush()
    const body = mocks.startFlight.mock.calls[0][0] as Record<string, unknown>
    expect(body.mode).toBeUndefined()
    expect(body.fromStage).toBe('scout')
  })

  it('surfaces the server error body when the start is rejected', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(entry({
      flight: { flightId: 'fl_1', status: 'done', stages: [] },
      prefill: { repoPaths: ['/repo'], description: 'checkout flow', env: 'local', coverageTarget: 100 },
    }))
    mocks.startFlight.mockRejectedValue(new ApiError(409, { error: 'flight conflict: repo busy' }))
    await render()

    click(byTestId('flight-start-stage-similarity')!)
    click(byTestId('flight-start-submit')!)
    await flush()
    expect(byTestId('flight-start-error')!.textContent).toContain('flight conflict: repo busy')
  })
})

describe('FlightStartDialog — new-flight mode (R40/R41)', () => {
  const setValue = (el: HTMLTextAreaElement | HTMLInputElement, value: string): void => {
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    act(() => { el.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  // R69: a repo enters via "Add repo" → the shared FolderPickerModal. The mock
  // resolves the picker's listing to `path`, so confirming adds that abs path;
  // the derived feature is the first repo's basename.
  const addRepo = async (path: string): Promise<void> => {
    mocks.listWorkspaceDirs.mockResolvedValue({ root: '/', at: path, absolute: path, parent: '/', dirs: [] })
    click(byTestId('repo-pick-add')!)
    await flush()
    click(byTestId('folder-picker-confirm')!)
    await flush()
  }

  it('asks exactly two things — intent + repos — and never calls the entry endpoint', async () => {
    await render({ feature: null, knownRepos: [{ label: 'shop', path: '/repo/shop' }] })
    expect(mocks.getFlightEntryOptions).not.toHaveBeenCalled()
    expect(byTestId('repo-multi-picker')).toBeTruthy()
    // The whole Start-from menu renders locked: only the full flight is pickable.
    const fullFlight = byTestId('flight-start-stage-similarity') as HTMLButtonElement
    expect(fullFlight.disabled).toBe(false)
    for (const key of ['scout', 'docs', 'specs-coverage', 'run', 'evaluation-export'] as const) {
      const rowEl = byTestId(`flight-start-stage-${key}`) as HTMLButtonElement
      expect(rowEl.disabled).toBe(true)
      // Each row explains what its stage does — not a repeated lock reason.
      expect(rowEl.textContent).toContain(STAGE_BLURB[key])
    }
    // The uniform first-flight lock is stated once, on the section header.
    expect(byTestId('flight-steps-toggle')?.textContent).toContain('unlocks after the first flight')
  })

  it('R54: submit plans first — the breakdown agent owns the dialog; closing keeps it in the background', async () => {
    mocks.planFeatures.mockResolvedValue({ taskId: 't1', status: 'running', repoPaths: ['/repo/Acme Shop'], description: 'test the checkout flow' })
    await render({ feature: null, knownRepos: [{ label: 'shop', path: '/repo/Acme Shop' }] })
    const textarea = container.querySelector('textarea')!
    setValue(textarea, 'test the checkout flow')
    await addRepo('/repo/Acme Shop')
    expect(byTestId('flight-start-submit')?.textContent).toBe('Plan flight →')
    click(byTestId('flight-start-submit')!)
    await flush()
    expect(mocks.planFeatures).toHaveBeenCalledWith({ repoPaths: ['/repo/Acme Shop'], description: 'test the checkout flow' })
    expect(mocks.startFlight).not.toHaveBeenCalled()
    // The planning view: live agent timeline. While it's thinking there is no
    // skip button (don't invite bailing on the default) and no footer close
    // button (the modal ✕ handles that) — just the background hint.
    expect(byTestId('flight-plan-view')).toBeTruthy()
    expect(byTestId('agent-session-view')?.getAttribute('data-kind')).toBe('flight-plan')
    expect(byTestId('flight-plan-background-hint')).toBeTruthy()
    expect(byTestId('flight-plan-skip')).toBeNull()
  })

  it('R54: planning failure surfaces the single-flight recovery', async () => {
    mocks.planFeatures.mockResolvedValue({ taskId: 't1', status: 'failed', repoPaths: ['/repo/Acme Shop'], description: 'test the checkout flow', error: 'agent crashed' })
    mocks.startFlight.mockResolvedValue({ flightId: 'fl_new' })
    const { onOpenFlight } = await render({ feature: null, knownRepos: [{ label: 'shop', path: '/repo/Acme Shop' }] })
    setValue(container.querySelector('textarea')!, 'test the checkout flow')
    await addRepo('/repo/Acme Shop')
    click(byTestId('flight-start-submit')!)
    await flush()
    // Failed → the background hint is gone; the single-flight recovery appears.
    expect(byTestId('flight-plan-background-hint')).toBeNull()
    const skip = byTestId('flight-plan-skip')!
    expect(skip.textContent).toBe('Start a single flight')
    click(skip)
    await flush()
    expect(mocks.startFlight).toHaveBeenCalledWith({
      feature: 'acme-shop',
      repoPaths: ['/repo/Acme Shop'],
      description: 'test the checkout flow',
    })
    expect(onOpenFlight).toHaveBeenCalledWith('fl_new')
  })

  it('R54: reopening a backgrounded pre-flight attaches to the running task', async () => {
    mocks.getPlanFeaturesTask.mockResolvedValue({ taskId: 't7', status: 'running', repoPaths: ['/repo/shop'], description: 'test the checkout flow' })
    await render({ feature: null, resumePlanTaskId: 't7' })
    expect(mocks.getPlanFeaturesTask).toHaveBeenCalledWith('t7')
    // Straight into the planning view attached to the existing task — no form,
    // no second plan spawn.
    expect(byTestId('flight-plan-view')).toBeTruthy()
    expect(byTestId('agent-session-view')?.getAttribute('data-kind')).toBe('flight-plan')
    expect(mocks.planFeatures).not.toHaveBeenCalled()
  })

  it('R54: a one-feature plan auto-launches without another click', async () => {
    mocks.planFeatures.mockResolvedValue({
      taskId: 't1',
      status: 'done',
      repoPaths: ['/repo/shop'],
      description: 'test checkout',
      result: { split: false, features: [{ name: 'shop', description: 'test checkout' }] },
    })
    mocks.launchPlannedFeatures.mockResolvedValue({ flightIds: ['fl_a'] })
    const { onOpenFlight } = await render({ feature: null, knownRepos: [{ label: 'shop', path: '/repo/shop' }] })
    setValue(container.querySelector('textarea')!, 'test checkout')
    await addRepo('/repo/shop')
    click(byTestId('flight-start-submit')!)
    await flush()
    expect(mocks.launchPlannedFeatures).toHaveBeenCalledWith('t1', { features: [{ name: 'shop', description: 'test checkout' }] })
    expect(onOpenFlight).toHaveBeenCalledWith('fl_a')
  })

  it('R54: a multi-feature plan needs confirmation — proposal cards + token warning, then one launch', async () => {
    mocks.planFeatures.mockResolvedValue({
      taskId: 't2',
      status: 'done',
      repoPaths: ['/repo/shop'],
      description: 'test everything',
      result: {
        split: true,
        features: [
          { name: 'checkout', description: 'the checkout flow', group: 'shop' },
          { name: 'catalog', description: 'browsing + search', group: 'shop' },
          { name: 'account', description: 'signup + login', group: 'shop' },
        ],
      },
    })
    mocks.launchPlannedFeatures.mockResolvedValue({ flightIds: ['fl_1', 'fl_2', 'fl_3'] })
    const { onOpenFlight } = await render({ feature: null, knownRepos: [{ label: 'shop', path: '/repo/shop' }] })
    setValue(container.querySelector('textarea')!, 'test everything')
    await addRepo('/repo/shop')
    click(byTestId('flight-start-submit')!)
    await flush()
    // Nothing launches before the user confirms.
    expect(mocks.launchPlannedFeatures).not.toHaveBeenCalled()
    expect(byTestId('flight-proposal-view')).toBeTruthy()
    expect(byTestId('flight-proposal-card-0')).toBeTruthy()
    expect(byTestId('flight-proposal-card-2')).toBeTruthy()
    expect(byTestId('flight-proposal-token-warning')?.textContent).toContain('3× the usual token cost')
    expect((byTestId('flight-proposal-group') as HTMLInputElement).value).toBe('shop')
    click(byTestId('flight-proposal-confirm')!)
    await flush()
    expect(mocks.launchPlannedFeatures).toHaveBeenCalledWith('t2', {
      features: [
        { name: 'checkout', description: 'the checkout flow', group: 'shop' },
        { name: 'catalog', description: 'browsing + search', group: 'shop' },
        { name: 'account', description: 'signup + login', group: 'shop' },
      ],
    })
    expect(onOpenFlight).toHaveBeenCalledWith('fl_1')
  })

  it('R54: launch name conflicts mark the colliding cards inline and block nothing else', async () => {
    mocks.planFeatures.mockResolvedValue({
      taskId: 't3',
      status: 'done',
      repoPaths: ['/repo/shop'],
      description: 'test everything',
      result: {
        split: true,
        features: [
          { name: 'checkout', description: 'the checkout flow' },
          { name: 'catalog', description: 'browsing + search' },
        ],
      },
    })
    mocks.launchPlannedFeatures.mockRejectedValue(
      new ApiError(409, { error: 'feature name(s) already in use: checkout', type: 'feature_name_conflicts', conflicts: ['checkout'] }),
    )
    await render({ feature: null, knownRepos: [{ label: 'shop', path: '/repo/shop' }] })
    setValue(container.querySelector('textarea')!, 'test everything')
    await addRepo('/repo/shop')
    click(byTestId('flight-start-submit')!)
    await flush()
    click(byTestId('flight-proposal-confirm')!)
    await flush()
    expect(byTestId('flight-proposal-conflict-0')?.textContent).toContain('already exists')
    expect(byTestId('flight-proposal-conflict-1')).toBeNull()
    expect(byTestId('flight-start-error')?.textContent).toContain('already in use')
  })

  it('R67: the existing-record 409 flips the dialog into feature-scoped mode instead of a raw error', async () => {
    mocks.planFeatures.mockRejectedValue(
      new ApiError(409, { error: 'flight exists', type: 'flight_exists_requires_choice', flightId: 'fl_old' }),
    )
    mocks.getFlightEntryOptions.mockResolvedValue(entry({
      feature: 'shop',
      flight: { flightId: 'fl_old', status: 'done', stages: [] },
      prefill: { repoPaths: ['/repo/shop'], description: 'old intent', env: 'local', coverageTarget: 100 },
    }))
    await render({ feature: null, knownRepos: [{ label: 'shop', path: '/repo/shop' }] })
    setValue(container.querySelector('textarea')!, 'test everything')
    await addRepo('/repo/shop')
    click(byTestId('flight-start-submit')!)
    await flush()
    expect(mocks.getFlightEntryOptions).toHaveBeenCalledWith('shop')
    // Feature-scoped + frozen: intent read-only, no repo picker.
    expect(byTestId('flight-start-frozen-intent')?.textContent).toContain('old intent')
    expect(byTestId('repo-multi-picker')).toBeNull()
  })

  it('keeps in-progress proposal edits when the parent re-renders (poll/WS tick with a fresh onOpenFlight)', async () => {
    mocks.planFeatures.mockResolvedValue({
      taskId: 't2',
      status: 'done',
      repoPaths: ['/repo/shop'],
      description: 'test everything',
      result: {
        split: true,
        features: [
          { name: 'checkout', description: 'the checkout flow', group: 'shop' },
          { name: 'catalog', description: 'browsing + search', group: 'shop' },
        ],
      },
    })
    const knownRepos = [{ label: 'shop', path: '/repo/shop' }]
    const onClose = vi.fn()
    // Render directly (not the `render` helper) so we control onOpenFlight's identity.
    await act(async () => {
      root.render(<FlightStartDialog feature={null} onClose={onClose} onOpenFlight={vi.fn()} knownRepos={knownRepos} />)
    })
    await flush()
    setValue(container.querySelector('textarea')!, 'test everything')
    await addRepo('/repo/shop')
    click(byTestId('flight-start-submit')!)
    await flush()
    // Proposal seeded from the plan.
    expect((byTestId('flight-proposal-group') as HTMLInputElement).value).toBe('shop')

    // User edits the group + a feature name.
    setValue(byTestId('flight-proposal-group') as HTMLInputElement, 'TEST')
    click(byTestId('flight-proposal-edit-0')!)
    setValue(container.querySelector('input[aria-label="Feature name"]') as HTMLInputElement, 'renamed')
    expect((byTestId('flight-proposal-group') as HTMLInputElement).value).toBe('TEST')
    expect((container.querySelector('input[aria-label="Feature name"]') as HTMLInputElement).value).toBe('renamed')

    // The parent re-renders with a FRESH onOpenFlight arrow (App re-renders every
    // few seconds on poll/WS). The settle effect must NOT re-seed the proposal.
    await act(async () => {
      root.render(<FlightStartDialog feature={null} onClose={onClose} onOpenFlight={vi.fn()} knownRepos={knownRepos} />)
    })
    await flush()
    expect((byTestId('flight-proposal-group') as HTMLInputElement).value).toBe('TEST')
    expect((container.querySelector('input[aria-label="Feature name"]') as HTMLInputElement).value).toBe('renamed')
  })

  it('adds a repo through the shared folder picker', async () => {
    await render({ feature: null })
    await addRepo('/somewhere/new-repo')
    expect(byTestId('repo-row-new-repo')).toBeTruthy()
  })

  it('will not start without an intent and at least one repo', async () => {
    await render({ feature: null, knownRepos: [{ label: 'shop', path: '/repo/shop' }] })
    const submit = byTestId('flight-start-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await addRepo('/repo/shop')
    expect((byTestId('flight-start-submit') as HTMLButtonElement).disabled).toBe(true)
    const textarea = container.querySelector('textarea')!
    setValue(textarea, 'test something')
    expect((byTestId('flight-start-submit') as HTMLButtonElement).disabled).toBe(false)
  })
})
