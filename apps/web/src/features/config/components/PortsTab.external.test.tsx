import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { connectWorkspaceEvents, type WorkspaceEvent } from '@/shared/api/workspace-socket'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { useWorkspaceData } from '@/shared/state/use-workspace-data'
import { ConfigDocCacheProvider } from './config-doc-cache'
import { PortsTab } from './PortsTab'

vi.mock('@/shared/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof api>(),
  getFeatureConfigDoc: vi.fn(), listFeatures: vi.fn(), listFlights: vi.fn(), listPlanFeatures: vi.fn(), getVersionStatus: vi.fn(),
  checkPathExists: vi.fn(), getGitRemote: vi.fn(), getRepoGitStatus: vi.fn(),
}))
vi.mock('@/shared/api/workspace-socket', () => ({ connectWorkspaceEvents: vi.fn() }))
vi.mock('@/features/flights', () => ({ useFlightsStream: () => ({ hydrated: false, flights: [], details: {} }) }))
vi.mock('@/features/runs/state/RunsContext', () => ({ useRuns: () => ({ runs: [] }) }))
vi.mock('@/features/portify/state/PortifyContext', async () => {
  const { detailFixture } = await import('../../portify/state/portify-detail.fixture')
  return { usePortify: () => ({ workflows: [] }), usePortifyDetail: detailFixture(async () => undefined) }
})

let container: HTMLDivElement
let root: Root
const close = vi.fn()
function remote(portified: boolean) {
  vi.mocked(api.listFeatures).mockResolvedValue([{ name: 'checkout', envs: ['local'], repos: [], portified }])
  vi.mocked(api.getFeatureConfigDoc).mockResolvedValue({
    path: '/workspace/checkout/feature.config.cjs', format: 'cjs', content: '',
    parsed: { source: '', complexFields: [], value: { name: 'checkout', repos: [{ name: 'app', localPath: '/workspace/app', startCommands: [{ command: 'node app.js', ...(portified ? { ports: [{ name: 'http', env: 'PORT' }] } : {}) }] }] } },
  })
}
function Workspace() {
  const { invalidate } = useInvalidation()
  const selectedFeatureRef = useRef('checkout')
  const selectedRunIdRef = useRef(null)
  const { features } = useWorkspaceData({ invalidate, selectedFeatureRef, selectedRunIdRef, onInitialFeatures: () => {}, onFeaturesRefreshed: () => {} })
  return <ConfigDocCacheProvider><PortsTab feature="checkout" portified={features.find((feature) => feature.name === 'checkout')?.portified} /></ConfigDocCacheProvider>
}
const fire = (event: WorkspaceEvent) => act(async () => { vi.mocked(connectWorkspaceEvents).mock.calls[0][0].onEvent(event) })
const removed = () => {
  expect(container.textContent).not.toContain('Portified — boots concurrently')
  expect(container.querySelector('[aria-label="Remove portification"]')).toBeNull()
  expect(container.textContent).not.toContain('${port.http}')
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  remote(true)
  vi.mocked(api.listFlights).mockResolvedValue([])
  vi.mocked(api.listPlanFeatures).mockResolvedValue({ tasks: [] })
  vi.mocked(api.getVersionStatus).mockResolvedValue({ current: '1.0.0', latest: null, updateAvailable: false, packageName: null, update: null })
  vi.mocked(api.checkPathExists).mockResolvedValue({ exists: true })
  vi.mocked(api.getGitRemote).mockResolvedValue({ cloneUrl: null })
  vi.mocked(api.getRepoGitStatus).mockResolvedValue({ path: '/workspace/app', expectedBranch: null, isGitRepo: false, currentBranch: null, detached: false, dirty: false, dirtyFiles: [], localBranches: [], remoteBranches: [] })
  vi.mocked(connectWorkspaceEvents).mockReturnValue({ close })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks() })

it.each(['features-changed', 'connected'] as const)('updates a mounted Ports tab after external removal via %s', async (type) => {
  await act(async () => { root.render(<InvalidationProvider><Workspace /></InvalidationProvider>) })
  expect(container.textContent).toContain('Portified — boots concurrently')
  expect(container.textContent).toContain('${port.http}')
  remote(false)
  await fire({ type })
  removed()
  expect(connectWorkspaceEvents).toHaveBeenCalledTimes(1)
})

it('recovers a missed removal through existing cache and feature-list intervals, then stops on unmount', async () => {
  await act(async () => { root.render(<InvalidationProvider><Workspace /></InvalidationProvider>) })
  expect(container.textContent).toContain('Portified — boots concurrently')
  remote(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  removed()
  expect(connectWorkspaceEvents).toHaveBeenCalledTimes(1)
  await act(async () => { root.render(null) })
  const reads = vi.mocked(api.getFeatureConfigDoc).mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
  expect(api.getFeatureConfigDoc).toHaveBeenCalledTimes(reads)
  expect(close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
