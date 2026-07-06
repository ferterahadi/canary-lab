// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightEntryOptions } from '../../../shared/api/client'

const mocks = vi.hoisted(() => ({
  getFlightEntryOptions: vi.fn(),
  startFlight: vi.fn(),
}))

vi.mock('../../../shared/api/client', async (importOriginal) => ({
  // Keep ApiError (the dialog branches on it for the server's error body).
  ...(await importOriginal<typeof import('../../../shared/api/client')>()),
  getFlightEntryOptions: mocks.getFlightEntryOptions,
  startFlight: mocks.startFlight,
}))

import { ApiError } from '../../../shared/api/client'
import { FlightStartDialog } from './FlightStartDialog'

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
      repoPaths: ['/repo'],
      description: 'checkout flow',
      mode: 'continue',
    }))
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
