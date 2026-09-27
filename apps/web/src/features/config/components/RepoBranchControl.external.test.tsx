import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { connectWorkspaceEvents, type WorkspaceEvent } from '@/shared/api/workspace-socket'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { useWorkspaceData } from '@/shared/state/use-workspace-data'
import { BranchControl } from './RepoBranchControl'

vi.mock('@/shared/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof api>(),
  getRepoGitStatus: vi.fn(), listFeatures: vi.fn(), listFlights: vi.fn(), listPlanFeatures: vi.fn(), getVersionStatus: vi.fn(),
}))
vi.mock('@/shared/api/workspace-socket', () => ({ connectWorkspaceEvents: vi.fn() }))
vi.mock('@/features/flights', () => ({ useFlightsStream: () => ({ hydrated: false, flights: [], details: {} }) }))
let container: HTMLDivElement
let root: Root
const status = (currentBranch: string): api.GitRepoStatus => ({ path: '/workspace/app', expectedBranch: null, isGitRepo: true, currentBranch, detached: false, dirty: false, dirtyFiles: [], localBranches: ['main', 'other'], remoteBranches: [] })
function Workspace() {
  const { invalidate } = useInvalidation()
  const selectedFeatureRef = useRef('checkout')
  const selectedRunIdRef = useRef(null)
  useWorkspaceData({ invalidate, selectedFeatureRef, selectedRunIdRef, onInitialFeatures: () => {}, onFeaturesRefreshed: () => {} })
  return <BranchControl feature="checkout" repo={{ name: 'app', localPath: '/workspace/app', startCommands: [] }} repoLookupName="app" localPathStr="/workspace/app" isExpr={false} activeRun={false} onChange={() => {}} />
}
const fire = (event: WorkspaceEvent) => act(async () => { vi.mocked(connectWorkspaceEvents).mock.calls[0][0].onEvent(event) })
const branch = () => container.querySelector('input')?.placeholder
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(api.listFeatures).mockResolvedValue([])
  vi.mocked(api.listFlights).mockResolvedValue([])
  vi.mocked(api.listPlanFeatures).mockResolvedValue({ tasks: [] })
  vi.mocked(api.getVersionStatus).mockResolvedValue({ current: '1', latest: null, updateAvailable: false, packageName: null, update: null })
  vi.mocked(api.getRepoGitStatus).mockResolvedValue(status('main'))
  vi.mocked(connectWorkspaceEvents).mockReturnValue({ close: vi.fn() })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks() })

it.each(['features-changed', 'connected'] as const)('updates the mounted branch reader through %s without reconnecting its workspace socket', async (type) => {
  await act(async () => { root.render(<InvalidationProvider><Workspace /></InvalidationProvider>) })
  expect(branch()).toBe('main')
  vi.mocked(api.getRepoGitStatus).mockResolvedValue(status('other'))
  await fire({ type })
  expect(branch()).toBe('other')
  expect(connectWorkspaceEvents).toHaveBeenCalledTimes(1)
})

it('ignores an older branch response after a newer invalidation has completed', async () => {
  let resolveOld!: (result: api.GitRepoStatus) => void
  vi.mocked(api.getRepoGitStatus).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
  await act(async () => { root.render(<InvalidationProvider><Workspace /></InvalidationProvider>) })
  vi.mocked(api.getRepoGitStatus).mockResolvedValue(status('other'))
  await fire({ type: 'features-changed' })
  expect(branch()).toBe('other')
  await act(async () => { resolveOld(status('main')) })
  expect(branch()).toBe('other')
})

it('recovers an external branch change without an event and stops recovery when closed', async () => {
  await act(async () => { root.render(<InvalidationProvider><Workspace /></InvalidationProvider>) })
  expect(branch()).toBe('main')
  vi.mocked(api.getRepoGitStatus).mockResolvedValue(status('other'))
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  expect(branch()).toBe('other')
  expect(connectWorkspaceEvents).toHaveBeenCalledTimes(1)
  await act(async () => { root.render(null) })
  const reads = vi.mocked(api.getRepoGitStatus).mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
  expect(api.getRepoGitStatus).toHaveBeenCalledTimes(reads)
  expect(vi.getTimerCount()).toBe(0)
})
