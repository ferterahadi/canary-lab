import type { WorkspaceStreamFrame as WorkspaceEvent } from '@shared/workspace-events'
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as workspaceApi from '@/shared/api/workspace'
import * as featuresApi from '@/shared/api/features'
import * as flightsApi from '@/shared/api/flights'
import { connectWorkspaceEvents } from '@/shared/api/workspace-socket'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { useWorkspaceData } from '@/shared/state/use-workspace-data'
import { BranchControl } from './RepoBranchControl'

vi.mock('@/shared/api/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/workspace')>()),
  getRepoGitStatus: vi.fn(),
  getVersionStatus: vi.fn(),
}))
vi.mock('@/shared/api/features', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/features')>()),
  listFeatures: vi.fn(),
}))
vi.mock('@/shared/api/flights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/flights')>()),
  listFlights: vi.fn(),
  listPlanFeatures: vi.fn(),
}))
vi.mock('@/shared/api/workspace-socket', () => ({ connectWorkspaceEvents: vi.fn() }))
vi.mock('@/features/flights/state/use-flights-stream', () => ({
  useFlightsStream: () => ({ hydrated: false, flights: [], details: {} }),
}))
let container: HTMLDivElement
let root: Root
const status = (currentBranch: string): workspaceApi.GitRepoStatus => ({ path: '/workspace/app', expectedBranch: null, isGitRepo: true, currentBranch, detached: false, dirty: false, dirtyFiles: [], localBranches: ['main', 'other'], remoteBranches: [] })
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
  vi.mocked(featuresApi.listFeatures).mockResolvedValue([])
  vi.mocked(flightsApi.listFlights).mockResolvedValue([])
  vi.mocked(flightsApi.listPlanFeatures).mockResolvedValue({ tasks: [] })
  vi.mocked(workspaceApi.getVersionStatus).mockResolvedValue({ current: '1', latest: null, updateAvailable: false, packageName: null, update: null })
  vi.mocked(workspaceApi.getRepoGitStatus).mockResolvedValue(status('main'))
  vi.mocked(connectWorkspaceEvents).mockReturnValue({ close: vi.fn() })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks() })

it.each(['features-changed', 'connected'] as const)('updates the mounted branch reader through %s without reconnecting its workspace socket', async (type) => {
  await act(async () => { root.render(<InvalidationProvider><Workspace /></InvalidationProvider>) })
  expect(branch()).toBe('main')
  vi.mocked(workspaceApi.getRepoGitStatus).mockResolvedValue(status('other'))
  await fire({ type })
  expect(branch()).toBe('other')
  expect(connectWorkspaceEvents).toHaveBeenCalledTimes(1)
})

it('ignores an older branch response after a newer invalidation has completed', async () => {
  let resolveOld!: (result: workspaceApi.GitRepoStatus) => void
  vi.mocked(workspaceApi.getRepoGitStatus).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
  await act(async () => { root.render(<InvalidationProvider><Workspace /></InvalidationProvider>) })
  vi.mocked(workspaceApi.getRepoGitStatus).mockResolvedValue(status('other'))
  await fire({ type: 'features-changed' })
  expect(branch()).toBe('other')
  await act(async () => { resolveOld(status('main')) })
  expect(branch()).toBe('other')
})

it('recovers an external branch change without an event and stops recovery when closed', async () => {
  await act(async () => { root.render(<InvalidationProvider><Workspace /></InvalidationProvider>) })
  expect(branch()).toBe('main')
  vi.mocked(workspaceApi.getRepoGitStatus).mockResolvedValue(status('other'))
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  expect(branch()).toBe('other')
  expect(connectWorkspaceEvents).toHaveBeenCalledTimes(1)
  await act(async () => { root.render(null) })
  const reads = vi.mocked(workspaceApi.getRepoGitStatus).mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
  expect(workspaceApi.getRepoGitStatus).toHaveBeenCalledTimes(reads)
  expect(vi.getTimerCount()).toBe(0)
})
