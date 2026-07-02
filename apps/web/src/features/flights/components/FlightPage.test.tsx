// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightManifest } from '../../../shared/api/client'
import { FLIGHT_STAGE_KEYS } from '../../../../../../shared/flights/types'

const mocks = vi.hoisted(() => ({
  listFlights: vi.fn(),
  getFlight: vi.fn(),
  respondFlightCheckpoint: vi.fn(),
  resumeFlight: vi.fn(),
  abortFlight: vi.fn(),
}))

vi.mock('../../../shared/api/client', () => ({
  listFlights: mocks.listFlights,
  getFlight: mocks.getFlight,
  respondFlightCheckpoint: mocks.respondFlightCheckpoint,
  resumeFlight: mocks.resumeFlight,
  abortFlight: mocks.abortFlight,
}))

// The agent timeline is its own tested component with live transports — stub it.
vi.mock('../../agent-sessions/components/AgentSessionView', () => ({
  AgentSessionView: ({ source }: { source: { stage?: string } }) => (
    <div data-testid="agent-session-view" data-stage={source.stage} />
  ),
}))

import { FlightPage } from './FlightPage'

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

async function render(flightId: string | null, refreshKey = 0) {
  await act(async () => {
    root.render(
      <FlightPage flightId={flightId} refreshKey={refreshKey} onSelectFlight={vi.fn()} onClose={vi.fn()} />,
    )
  })
}

describe('FlightPage', () => {
  it('renders the landing list without a flight id', async () => {
    mocks.listFlights.mockResolvedValue([
      { id: 'fl_1', flightId: 'fl_1', feature: 'checkout', repoPaths: ['/repo/shop'], status: 'done', currentStage: null, stages: [], createdAt: '', updatedAt: '' },
    ])
    await render(null)
    expect(container.querySelector('[data-testid="flight-row-fl_1"]')).toBeTruthy()
  })

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
          ? { checkpoint: { kind: 'config-approval' as const, message: 'Approve the draft config?', options: ['approve', 'redraft', 'reject'], data: { configSource: 'module.exports = {}' } } }
          : {}),
      })),
    }))
    await render('fl_1')
    for (const key of FLIGHT_STAGE_KEYS) {
      expect(container.querySelector(`[data-testid="stage-rail-${key}"]`)).toBeTruthy()
    }
    const controls = container.querySelector('[data-testid="checkpoint-controls"]')
    expect(controls?.textContent).toContain('Approve the draft config?')
    // The draft config is editable and approve posts the response.
    expect(container.querySelector('[data-testid="checkpoint-config"]')).toBeTruthy()
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
