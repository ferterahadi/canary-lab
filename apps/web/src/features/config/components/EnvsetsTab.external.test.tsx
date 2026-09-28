import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { connectWorkspaceEvents, type WorkspaceEvent } from '@/shared/api/workspace-socket'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { useWorkspaceData } from '@/shared/state/use-workspace-data'
import { ConfigDocCacheProvider } from './config-doc-cache'
import { EnvsetsTab } from './EnvsetsTab'

vi.mock('@/shared/api/client', () => ({
  getEnvsetsIndex: vi.fn(), getEnvsetSlot: vi.fn(), listFeatures: vi.fn(), listFlights: vi.fn(),
  listPlanFeatures: vi.fn(), getVersionStatus: vi.fn(),
}))
vi.mock('@/shared/api/workspace-socket', () => ({ connectWorkspaceEvents: vi.fn() }))
vi.mock('@/features/flights', () => ({ useFlightsStream: () => ({ hydrated: false, flights: [], details: {} }) }))

let container: HTMLDivElement
let root: Root
const close = vi.fn()
const index = (...names: string[]) => ({ envs: names.map((name) => ({ name, slots: [] })), slotDescriptions: {}, slotTargets: {} })
function Workspace() {
  const { invalidate } = useInvalidation()
  const selectedFeatureRef = useRef('checkout')
  const selectedRunIdRef = useRef(null)
  useWorkspaceData({ invalidate, selectedFeatureRef, selectedRunIdRef, onInitialFeatures: () => {}, onFeaturesRefreshed: () => {} })
  return <ConfigDocCacheProvider><EnvsetsTab feature="checkout" /></ConfigDocCacheProvider>
}
const render = () => root.render(<InvalidationProvider><Workspace /></InvalidationProvider>)
const fire = (event: WorkspaceEvent) => act(async () => { vi.mocked(connectWorkspaceEvents).mock.calls[0][0].onEvent(event) })
const hasEnv = (name: string) => container.querySelector(`option[value="${name}"]`) !== null
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.mocked(api.listFeatures).mockResolvedValue([])
  vi.mocked(api.listFlights).mockResolvedValue([])
  vi.mocked(api.listPlanFeatures).mockResolvedValue({ tasks: [] })
  vi.mocked(api.getVersionStatus).mockResolvedValue({ current: '1.0.0', latest: null, updateAvailable: false, packageName: null, update: null })
  vi.mocked(connectWorkspaceEvents).mockReturnValue({ close })
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue(index('local'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks() })

it('updates the mounted Envsets tab through workspace events, bulk changes and reconnect', async () => {
  await act(async () => { render() })
  expect(hasEnv('local')).toBe(true)
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue(index('local', 'staging'))
  await fire({ type: 'envsets-changed', feature: 'unrelated' })
  expect(api.getEnvsetsIndex).toHaveBeenCalledTimes(1)
  expect(hasEnv('staging')).toBe(false)
  await fire({ type: 'envsets-changed', feature: 'checkout' })
  expect(hasEnv('staging')).toBe(true)
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue(index('local', 'preview'))
  await fire({ type: 'features-changed' })
  expect(hasEnv('preview')).toBe(true)
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue(index('local', 'production'))
  await fire({ type: 'connected' })
  expect(hasEnv('production')).toBe(true)
  expect(connectWorkspaceEvents).toHaveBeenCalledTimes(1)
})

it('recovers missed events, retries failed reads, retains selection and releases recovery work', async () => {
  await act(async () => { render() })
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue(index('local', 'staging'))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(hasEnv('staging')).toBe(true)
  const select = container.querySelector('select')!
  await act(async () => { select.value = 'staging'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(select.value).toBe('staging')
  expect(api.getEnvsetsIndex).toHaveBeenCalledTimes(3)
  vi.mocked(api.getEnvsetsIndex).mockRejectedValueOnce(new Error('temporary read failure'))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(hasEnv('staging')).toBe(true)
  expect(container.textContent).toContain('temporary read failure')
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue(index('local'))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(select.value).toBe('local')
  expect(container.textContent).not.toContain('temporary read failure')
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue(index())
  await fire({ type: 'envsets-changed', feature: 'checkout' })
  expect(container.textContent).toContain('No envs yet')
  await act(async () => { root.render(null) })
  const reads = vi.mocked(api.getEnvsetsIndex).mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); window.dispatchEvent(new Event('focus')) })
  expect(api.getEnvsetsIndex).toHaveBeenCalledTimes(reads)
  expect(vi.getTimerCount()).toBe(0)
  expect(close).toHaveBeenCalledOnce()
})

it('refreshes slot content while mounted and follows externally removed slots', async () => {
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue({ ...index('local'), envs: [{ name: 'local', slots: ['app.env', 'worker.env'] }] })
  vi.mocked(api.getEnvsetSlot).mockResolvedValue({ entries: [{ key: 'MODE', value: 'initial' }], unparsedLines: [], path: '/workspace/app.env', content: 'MODE=initial\n' })
  await act(async () => { render() })
  expect(container.textContent).toContain('initial')
  vi.mocked(api.getEnvsetSlot).mockResolvedValue({ entries: [{ key: 'MODE', value: 'external' }], unparsedLines: [], path: '/workspace/app.env', content: 'MODE=external\n' })
  await fire({ type: 'envsets-changed', feature: 'checkout' })
  expect(container.textContent).toContain('external')
  expect(container.textContent).not.toContain('initial')
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue({ ...index('local'), envs: [{ name: 'local', slots: ['worker.env'] }] })
  await fire({ type: 'envsets-changed', feature: 'checkout' })
  expect(container.querySelectorAll('select')[1].value).toBe('worker.env')
  expect(api.getEnvsetSlot).toHaveBeenLastCalledWith('checkout', 'local', 'worker.env')
})

it('refreshes the displayed slot target after metadata events, reconnect and missed-event recovery', async () => {
  const withTarget = (target: string) => ({ ...index('local'), envs: [{ name: 'local', slots: ['app.env'] }], slotTargets: { 'app.env': target } })
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue(withTarget('/workspace/original.env'))
  vi.mocked(api.getEnvsetSlot).mockResolvedValue({ entries: [], unparsedLines: [], path: '/workspace/app.env', content: '' })
  await act(async () => { render() })
  await act(async () => { container.querySelector<HTMLElement>('[aria-label="Replaces path"]')!.click() })
  const tooltip = () => document.querySelector('[role="tooltip"]')?.textContent
  expect(tooltip()).toContain('/workspace/original.env')
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue(withTarget('/workspace/event.env'))
  await fire({ type: 'envsets-changed', feature: 'checkout' })
  expect(tooltip()).toContain('/workspace/event.env')
  expect(tooltip()).not.toContain('/workspace/original.env')
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue(withTarget('/workspace/reconnected.env'))
  await fire({ type: 'connected' })
  expect(tooltip()).toContain('/workspace/reconnected.env')
  vi.mocked(api.getEnvsetsIndex).mockResolvedValue(withTarget('/workspace/recovered.env'))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(tooltip()).toContain('/workspace/recovered.env')
  expect(container.querySelectorAll('select')[1].value).toBe('app.env')
  expect(connectWorkspaceEvents).toHaveBeenCalledTimes(1)
})
