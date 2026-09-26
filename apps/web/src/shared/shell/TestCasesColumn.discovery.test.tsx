// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestCasesColumn } from './TestCasesColumn'
import { InvalidationProvider } from '../state/invalidation'
import { ApiError, getFeatureTests } from '../api/client'
import { listDiscoveryRepairs, startDiscoveryRepair, type DiscoveryRepairView } from '../api/discovery-repair'
import { connectReconnectingSocket } from '../api/reconnecting-socket'
import { readableTest } from '../api/__fixtures__/readable-test'

vi.mock('../api/client', async (original) => ({ ...await original<typeof import('../api/client')>(), getFeatureTests: vi.fn(), getFeatureDirtyDiff: vi.fn().mockResolvedValue({ tests: [] }) }))
vi.mock('../api/discovery-repair', () => ({ listDiscoveryRepairs: vi.fn(), startDiscoveryRepair: vi.fn() }))
vi.mock('../api/reconnecting-socket', () => ({ defaultWsBase: () => 'ws://test', connectReconnectingSocket: vi.fn(() => ({ close: vi.fn() })) }))
vi.mock('../ui/TestPresentation', () => ({ TestPresentation: () => null }))

let root: Root
let container: HTMLDivElement
const repair = (status: DiscoveryRepairView['status'], message = 'Inspecting imports'): DiscoveryRepairView => ({
  id: 'dr_0123456789abcdef01234567', feature: 'suite', featureDir: '/features/suite', status,
  owner: { kind: 'external', clientKind: 'codex', sessionId: 'external' },
  createdAt: '2026-09-09T00:00:00Z', updatedAt: `2026-09-09T00:00:0${status === 'succeeded' ? 3 : 1}Z`, heartbeatAt: new Date().toISOString(),
  message, diagnostic: 'missing import', log: ['[Canary] Discovery failed', `[agent-report] ${message}`], promptPath: '/prompt.md', promptReady: true,
})
const failedSpecs = [{ file: '/features/suite/e2e/a.spec.ts', tests: [], discoveryError: 'Discovery failed', discoveryDiagnostics: 'missing import' }]
async function send(value: DiscoveryRepairView[]) {
  const opts = vi.mocked(connectReconnectingSocket).mock.calls[0][0]
  await act(async () => opts.onMessage(JSON.stringify({ repairs: value })))
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listDiscoveryRepairs).mockResolvedValue([])
  vi.mocked(getFeatureTests).mockResolvedValue(failedSpecs)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
async function render(isAuthoringTests = false) {
  await act(async () => root.render(<InvalidationProvider><TestCasesColumn feature="suite" isAuthoringTests={isAuthoringTests} /></InvalidationProvider>))
}
describe('Tests column discovery repair', () => {
  it('shows a removed suite in the same card layout without repair or retry actions', async () => {
    vi.mocked(getFeatureTests).mockRejectedValue(new ApiError(404, { code: 'suite-removed', error: 'The live suite is no longer in this workspace.' }))
    await render()
    const card = container.querySelector('[data-testid="tests-unavailable-card"]')!
    expect(card.textContent).toContain('Suite removed')
    expect(card.textContent).toContain('The live suite is no longer in this workspace.')
    expect(card.querySelector('[data-testid="test-list-error-summary"]')).not.toBeNull()
    expect(card.querySelectorAll('button')).toHaveLength(0)
    expect(getFeatureTests).toHaveBeenCalledTimes(1)
  })

  it('replaces the removed card when an external agent restores the suite without a page refresh', async () => {
    let checkAvailability: (() => void) | undefined
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback, delay) => {
      if (delay === 10_000) checkAvailability = callback as () => void
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
    try {
      vi.mocked(getFeatureTests).mockRejectedValue(new ApiError(404, { code: 'suite-removed', error: 'The live suite is no longer in this workspace.' }))
      await render()
      expect(container.textContent).toContain('Suite removed')
      expect(checkAvailability).toBeDefined()

      vi.mocked(getFeatureTests).mockResolvedValue([{ file: '/features/suite/e2e/a.spec.ts', tests: [{ name: 'Restored case', line: 1, bodySource: '', steps: [], readable: readableTest('Restored case') }] }])
      await act(async () => checkAvailability?.())
      expect(container.textContent).toContain('Restored case')
      expect(container.textContent).not.toContain('Suite removed')
    } finally {
      interval.mockRestore()
    }
  })

  it.each(['missing', 'invalid'] as const)('shows %s configuration under discovery failure with working repair and retry actions', async (condition) => {
    vi.mocked(getFeatureTests).mockRejectedValue(new ApiError(422, { code: 'discovery-failed', error: `Suite configuration is ${condition}.` }))
    await render()
    const card = container.querySelector('[data-testid="tests-unavailable-card"]')!
    expect(card.textContent).toContain('Test discovery failed')
    expect(card.textContent).toContain(`Suite configuration is ${condition}.`)
    const buttons = [...card.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toContain('Repair in Canary Lab')
    expect(buttons.map((button) => button.textContent)).toContain('Retry discovery')
    expect(buttons[0].className).toContain('px-3 py-1.5')
    expect(buttons[1].className).toContain('px-3 py-1.5')
  })

  it('puts all three ways out on the card, with nothing to open for a one-line error', async () => {
    await render()
    const command = container.querySelector('[data-testid="discovery-repair-command"]')!
    const mainActions = [...container.querySelectorAll('button')].filter((button) => !command.contains(button))
    expect(mainActions.map((button) => button.textContent)).toEqual(['Repair in Canary Lab', 'Retry discovery'])
    expect(mainActions[0].classList.contains('cl-button-primary')).toBe(true)
    // The third way out — hand it to your own agent — is a peer of the buttons.
    // It used to sit behind a disclosure labelled "Details & other options",
    // where nobody looking at a failure would think to find it.
    expect(command.textContent).toContain('/canary-lab-repair-discovery suite')
    // And the error itself reads on the card rather than costing a click.
    expect(container.querySelector('[data-testid="test-list-error-summary"]')?.textContent).toBe('missing import')
    expect(container.querySelectorAll('details')).toHaveLength(0)
  })

  it('opens the rest of a multi-line error behind one named disclosure', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([{
      ...failedSpecs[0],
      discoveryDiagnostics: "Error: Cannot find module './fixtures/auth'\n  at e2e/a.spec.ts:3:1\n  at playwright.config.ts:12:20",
    }])
    await render()
    // The first line is the diagnosis and stays on the card; only the stack
    // behind it is worth hiding.
    expect(container.querySelector('[data-testid="test-list-error-summary"]')?.textContent).toBe("Error: Cannot find module './fixtures/auth'")
    const details = container.querySelectorAll('details')
    expect(details).toHaveLength(1)
    expect(details[0].querySelector('summary')?.textContent).toBe('Full error output')
    expect(details[0].querySelector('pre')?.textContent).toContain('at playwright.config.ts:12:20')
  })

  it('shows live placeholders instead of a discovery failure while authoring, then discovers again when writing ends', async () => {
    await render(true)
    expect(container.textContent).toContain('Writing tests…')
    expect(container.textContent).not.toContain('Test discovery failed')
    expect(container.textContent).not.toContain('Two ways to repair it')
    // The placeholder is the card it becomes, not a generic bar stack: same
    // `cl-card` chrome and the same 40px row, so the list does not re-lay itself
    // out when the first authored spec lands.
    const cards = container.querySelectorAll<HTMLElement>('[data-testid="test-card-skeleton"]')
    expect(cards).toHaveLength(3)
    expect(cards[0].className).toContain('cl-card')
    expect(cards[0].querySelector<HTMLElement>('.h-10')).not.toBeNull()
    // Each card sweeps as one unit, one step behind the card above it.
    const offsets = [...cards].map((card) => card.querySelector<HTMLElement>('[data-testid="skeleton-bar"]')!.style.animationDelay)
    expect(offsets).toEqual(['', '-110ms', '-220ms'])

    vi.mocked(getFeatureTests).mockResolvedValue([{ file: '/features/suite/e2e/a.spec.ts', tests: [{ name: 'Newly authored case', line: 1, bodySource: '', steps: [], readable: readableTest('Newly authored case') }] }])
    await render(false)
    expect(container.textContent).toContain('Newly authored case')
    expect(container.textContent).not.toContain('Writing tests…')
    expect(getFeatureTests).toHaveBeenCalledTimes(2)
  })

  it('shows external work started elsewhere and returns to the existing test list after verification without a refresh', async () => {
    await render()
    expect(container.querySelector('[data-testid="discovery-repair-command"]')).not.toBeNull()
    await send([repair('repairing')])
    expect(container.textContent).toContain('Inspecting imports')
    expect(container.textContent).not.toContain('Two ways to repair it')
    await send([repair('repairing', 'Fixed the import path')])
    expect(container.textContent).toContain('Fixed the import path')
    await send([repair('verifying')])
    expect(container.textContent).toContain('Verifying discovery')
    vi.mocked(getFeatureTests).mockResolvedValue([{ file: '/features/suite/e2e/a.spec.ts', tests: [{ name: 'A real discovered case', line: 1, bodySource: '', steps: [], readable: readableTest('A real discovered case') }] }])
    await send([repair('succeeded')])
    expect(container.textContent).toContain('A real discovered case')
    expect(container.querySelector('[data-testid="discovery-repair-activity"]')).toBeNull()
    expect(container.textContent).not.toContain('Discovery restored')
  })

  it('returns to Failure with resume actions when verification fails and attaches to the next internal start', async () => {
    await render()
    await send([repair('verifying')])
    await send([repair('failed', 'Still missing an import')])
    expect(container.textContent).toContain('Test discovery failed')
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Resume repair')!
    expect(button).toBeDefined()
    vi.mocked(startDiscoveryRepair).mockResolvedValue({ ...repair('repairing'), id: 'dr_new', createdAt: '2026-09-09T00:01:00Z' })
    await act(async () => button.click())
    expect(startDiscoveryRepair).toHaveBeenCalledWith('suite')
    expect(container.textContent).toContain('Repairing discovery')
  })

  it('allows manual recovery after a failed agent attempt without hiding a new discovery error', async () => {
    await render()
    await send([repair('failed')])
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry discovery')!
    await act(async () => retry.click())
    expect(container.textContent).toContain('Test discovery failed')
    vi.mocked(getFeatureTests).mockResolvedValue([{ file: '/features/suite/e2e/a.spec.ts', tests: [{ name: 'Manually repaired case', line: 1, bodySource: '', steps: [], readable: readableTest('Manually repaired case') }] }])
    await act(async () => retry.click())
    expect(container.textContent).toContain('Manually repaired case')
    expect(container.textContent).not.toContain('Test discovery failed')
    // The restored list IS the evidence the repair worked. A permanent
    // "Repair history" disclosure above it was chrome for a one-time event.
    expect(container.textContent).not.toContain('Repair history')
    expect(container.querySelector('[data-testid="tests-unavailable-card"]')).toBeNull()
  })

  it('acknowledges the start and, when no agent is free, points at the command below it', async () => {
    await render()
    const button = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Repair in Canary Lab') || b.textContent === 'Starting…') as HTMLButtonElement
    let release!: (value: DiscoveryRepairView) => void
    vi.mocked(startDiscoveryRepair).mockReturnValue(new Promise((r) => { release = r }))
    await act(async () => button().click())
    expect(button().textContent).toBe('Starting…')
    expect(button().disabled).toBe(true)
    await act(async () => release(repair('repairing')))

    // A 409 here is not a transport problem the user can wait out: it means no
    // agent is free, and the fix is the command on this same card.
    await send([repair('failed')])
    vi.mocked(startDiscoveryRepair).mockRejectedValue(new Error('No repair agent is available. Use the In your agent command.'))
    const resume = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Resume repair')!
    await act(async () => resume.click())
    const alert = container.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('No repair agent is available')
    expect(alert.compareDocumentPosition(container.querySelector('[data-testid="discovery-repair-command"]')!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('rehydrates the live record from a reconnect snapshot and ignores an older REST response', async () => {
    let resolve!: (value: DiscoveryRepairView[]) => void
    vi.mocked(listDiscoveryRepairs).mockReturnValue(new Promise((r) => { resolve = r }))
    await render()
    await send([repair('repairing', 'Resumed external session')])
    await act(async () => resolve([]))
    expect(container.textContent).toContain('Resumed external session')
    expect(vi.mocked(connectReconnectingSocket).mock.calls[0][0].maxReconnects).toBe(Infinity)
  })
})
