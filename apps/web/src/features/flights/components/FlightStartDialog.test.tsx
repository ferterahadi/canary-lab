// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightEntryOptions } from '@/shared/api/client'

const mocks = vi.hoisted(() => ({
  getFlightEntryOptions: vi.fn(),
  startFlight: vi.fn(),
  planFeatures: vi.fn(),
  getPlanFeaturesTask: vi.fn(),
  launchPlannedFeatures: vi.fn(),
  listWorkspaceDirs: vi.fn(),
  getProjectConfig: vi.fn(),
  abortFlight: vi.fn(),
}))

vi.mock('@/shared/api/client', async (importOriginal) => ({
  // Keep ApiError (the dialog branches on it for the server's error body).
  ...(await importOriginal<typeof import('@/shared/api/client')>()),
  getFlightEntryOptions: mocks.getFlightEntryOptions,
  startFlight: mocks.startFlight,
  planFeatures: mocks.planFeatures,
  getPlanFeaturesTask: mocks.getPlanFeaturesTask,
  launchPlannedFeatures: mocks.launchPlannedFeatures,
  getProjectConfig: mocks.getProjectConfig,
  abortFlight: mocks.abortFlight,
  // The repo picker reuses FolderPickerModal, which lists dirs via this.
  listWorkspaceDirs: mocks.listWorkspaceDirs,
}))

// The planning view embeds the live agent timeline — its transports are its
// own tested concern; stub it.
vi.mock('@/shared/ui/AgentSessionView', () => ({
  AgentSessionView: ({ source }: { source: { kind: string } }) => (
    <div data-testid="agent-session-view" data-kind={source.kind} />
  ),
}))

import { ApiError } from '@/shared/api/client'
import { FlightStartDialog } from './FlightStartDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement

let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProjectConfig.mockResolvedValue({ healAgent: 'external', editor: 'auto', personalWikiPath: null })
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
    // Non-fresh re-fly: attaching is the only move — no stop offered.
    expect(byTestId('flight-start-stop-active')).toBeNull()
  })

  it('R80: fresh intent on a flying suite offers the stop, then lands on the editable form', async () => {
    const active = entry({
      active: true,
      flight: { flightId: 'fl_live', status: 'running', stages: [] },
      prefill: { repoPaths: ['/repo'], description: 'checkout flow', env: 'local', coverageTarget: 100 },
    })
    mocks.getFlightEntryOptions.mockResolvedValueOnce(active)
    mocks.abortFlight.mockResolvedValue({ flightId: 'fl_live' })
    await render({ intent: 'fresh' })

    // The dead-end explains the cost instead of just refusing.
    expect(container.textContent).toContain('restarts the flight from the beginning')

    // Second fetch (post-stop) reports the flight inactive.
    mocks.getFlightEntryOptions.mockResolvedValueOnce(entry({
      active: false,
      flight: { flightId: 'fl_live', status: 'aborted', stages: [] },
      prefill: active.prefill,
    }))
    click(byTestId('flight-start-stop-active')!)
    await flush()

    expect(mocks.abortFlight).toHaveBeenCalledWith('fl_live')
    // …and the fresh form the user opened the dialog for is now in front of them.
    expect(byTestId('flight-start-stop-active')).toBeNull()
    expect((byTestId('flight-start-submit') as HTMLButtonElement).textContent).toBe('Start fresh flight')
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('checkout flow')
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

describe('FlightStartDialog — fresh intent (R76)', () => {
  const paused = (): FlightEntryOptions => entry({
    canContinue: true,
    flight: { flightId: 'fl_1', status: 'paused', stages: [{ key: 'scout', status: 'done' }] },
    prefill: { repoPaths: ['/repo'], description: 'checkout flow', env: 'local', coverageTarget: 100 },
  })

  it('shows the full flight as a READ-ONLY preview — no resume row, no pickable step', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(paused())
    await render({ intent: 'fresh' })

    // No re-entry choice: a changed input set is only valid from the beginning.
    expect(byTestId('flight-start-continue')).toBeNull()
    // …but the journey it WILL run is still spelled out.
    expect(byTestId('flight-steps-toggle')).not.toBeNull()
    const first = byTestId('flight-start-stage-similarity')!
    const later = byTestId('flight-start-stage-scout')!
    expect(first.tagName).toBe('DIV')
    expect(later.tagName).toBe('DIV')
    expect(first.getAttribute('role')).toBeNull()
    // The restart is what happens, so the lead row carries the selected mark —
    // the app's selected-grey, and no accent: every row in a picker is
    // clickable, so accent-tinting the picked one would invert what blue means.
    expect(first.getAttribute('style')).toContain('var(--bg-selected)')
    expect(first.getAttribute('style')).not.toContain('var(--accent)')
    expect(later.getAttribute('style')).not.toContain('var(--bg-selected)')
  })

  it('shows bare step numbers, never the wiped flight\'s status glyphs', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(paused())
    await render({ intent: 'fresh' })

    // `scout` was done last flight; fresh wipes it, so claiming ✓ would lie.
    expect(byTestId('flight-start-stage-scout')!.textContent).toContain('2')
    expect(byTestId('flight-start-stage-scout')!.textContent).not.toContain('✓')
  })

  it('lands with the intent EDITABLE, never frozen — even though the flight can continue', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(paused())
    await render({ intent: 'fresh' })

    // The bug this rework fixes: defaulting to `continue` re-froze the very
    // fields the "Change…" handoff exists to edit.
    expect(byTestId('flight-start-frozen-intent')).toBeNull()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('checkout flow')
    expect((byTestId('flight-start-submit') as HTMLButtonElement).textContent).toBe('Start fresh flight')
  })

  it('posts mode redo WITH the edited repos + intent', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(paused())
    mocks.startFlight.mockResolvedValue({ flightId: 'fl_2' })
    const { onOpenFlight } = await render({ intent: 'fresh' })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'the refund flow instead')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(byTestId('flight-start-submit')!)
    await flush()

    expect(mocks.startFlight).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'checkout',
      mode: 'redo',
      description: 'the refund flow instead',
      repoPaths: ['/repo'],
    }))
    expect(onOpenFlight).toHaveBeenCalledWith('fl_2')
  })

  it('states what a fresh start costs', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(paused())
    await render({ intent: 'fresh' })
    expect(byTestId('flight-start-reset-note')!.textContent).toContain('wiped')
  })

  it('leaves the re-fly intent alone — the stage menu still preselects Continue', async () => {
    mocks.getFlightEntryOptions.mockResolvedValue(paused())
    await render()
    expect(byTestId('flight-start-continue')).not.toBeNull()
    expect((byTestId('flight-start-submit') as HTMLButtonElement).textContent).toBe('Continue flight')
  })
})
