// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestCasesColumn } from './TestCasesColumn'
import { InvalidationProvider } from '../state/invalidation'
import { getFeatureTests } from '../api/client'
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
async function render() {
  await act(async () => root.render(<InvalidationProvider><TestCasesColumn feature="suite" activeRunSummary={undefined} activeRunStatus={undefined} /></InvalidationProvider>))
}
describe('Tests column discovery repair', () => {
  it('shows external work started elsewhere and returns to the existing test list after verification without a refresh', async () => {
    await render()
    expect(container.textContent).toContain('In your agent')
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
    expect(container.textContent).toContain('Repair history')
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
