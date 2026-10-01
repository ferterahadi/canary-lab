// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PlanFeaturesTask } from '@/shared/api/client'
import { ApiError } from '@/shared/api/client'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { useFlightStartDialog } from './use-flight-start-dialog'

const api = vi.hoisted(() => ({ getPlanFeaturesTask: vi.fn(), getProjectConfig: vi.fn(), launchPlannedFeatures: vi.fn(), cancelPlanFeatures: vi.fn(), planFeatures: vi.fn() }))
vi.mock('@/shared/api/client', async (original) => ({ ...(await original<typeof import('@/shared/api/client')>()), ...api }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let element: HTMLDivElement
let state: ReturnType<typeof useFlightStartDialog>
let invalidate: () => void
let sequence = 0
let id: string
const onClose = vi.fn()
const onOpenFlight = vi.fn()
function Probe({ taskId }: { taskId?: string }) {
  const bus = useInvalidation()
  invalidate = () => bus.invalidate('pre-flights')
  state = useFlightStartDialog({ feature: null, intent: 'fresh', fromStage: null, resumePlanTaskId: taskId, onClose, onOpenFlight })
  return <output>{state.phase}/{state.planTask?.status}</output>
}
const render = async (taskId: string | undefined = id) => {
  await act(async () => { root.render(<InvalidationProvider><Probe taskId={taskId} /></InvalidationProvider>) })
}
function task(status: PlanFeaturesTask['status'] = 'running', taskId = id): PlanFeaturesTask {
  return { taskId, status, repoPaths: ['/synthetic/repo'], description: 'Synthetic plan', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
}
function proposal(taskId = id): PlanFeaturesTask {
  return { ...task('done', taskId), result: { features: [
    { name: 'one', description: 'First suite' }, { name: 'two', description: 'Second suite' },
  ] } } as PlanFeaturesTask
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  id = `plan-recovery-${++sequence}`
  api.getProjectConfig.mockResolvedValue({})
  api.getPlanFeaturesTask.mockResolvedValue(task())
  element = document.createElement('div')
  document.body.appendChild(element)
  root = createRoot(element)
})
afterEach(() => { act(() => root.unmount()); element.remove(); vi.useRealTimers() })

it('rejects an older poll after accepting a proposal and stops periodic reads', async () => {
  const older = deferred<PlanFeaturesTask>()
  api.getPlanFeaturesTask.mockResolvedValueOnce(task()).mockReturnValueOnce(older.promise).mockResolvedValue(proposal())
  await render()
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(element.textContent).toBe('proposal/done')
  await act(async () => { older.resolve(task()) })
  expect(element.textContent).toBe('proposal/done')
  const calls = api.getPlanFeaturesTask.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(api.getPlanFeaturesTask).toHaveBeenCalledTimes(calls)
})

it.each(['failed', 'hung'])('recovers a %s initial resume read without reopening', async (mode) => {
  const older = deferred<PlanFeaturesTask>()
  if (mode === 'failed') api.getPlanFeaturesTask.mockRejectedValueOnce(new Error('offline'))
  else api.getPlanFeaturesTask.mockReturnValueOnce(older.promise)
  api.getPlanFeaturesTask.mockResolvedValue(proposal())
  await render()
  if (mode === 'failed') expect(state.startError).toBe('offline')
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(element.textContent).toBe('proposal/done')
  expect(state.startError).toBeNull()
  await act(async () => { older.resolve(task()) })
  expect(state.planTask?.status).toBe('done')
})

it('preserves proposal edits through refresh failure and reconnect invalidation', async () => {
  api.getPlanFeaturesTask.mockResolvedValue(proposal())
  await render()
  await act(async () => { state.setSharedGroup('edited'); state.setProposal([{ name: 'renamed', description: 'Edited intent' }]) })
  api.getPlanFeaturesTask.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { invalidate() })
  expect(state.planTask?.status).toBe('done')
  expect(state.startError).toBe('offline')
  await act(async () => { invalidate() })
  expect(state.startError).toBeNull()
  expect(state.sharedGroup).toBe('edited')
  expect(state.proposal).toEqual([{ name: 'renamed', description: 'Edited intent' }])
})

it('treats 404 as missing, disables task actions, and rechecks on a later invalidation', async () => {
  api.getPlanFeaturesTask.mockResolvedValue(proposal())
  await render()
  api.getPlanFeaturesTask.mockRejectedValueOnce(new ApiError(404, {}))
  await act(async () => { invalidate() })
  expect(state.taskUnavailable).toBe(true)
  expect(state.startError).toBe('This planning task no longer exists.')
  await act(async () => { state.launchProposal(); state.cancelPlanning(id); await vi.advanceTimersByTimeAsync(6000) })
  expect(api.launchPlannedFeatures).not.toHaveBeenCalled()
  expect(api.cancelPlanFeatures).not.toHaveBeenCalled()
  expect(api.getPlanFeaturesTask).toHaveBeenCalledTimes(2)
  await act(async () => { invalidate() })
  expect(state.taskUnavailable).toBe(false)
  expect(state.proposal).toHaveLength(2)
})

it('ignores an older task after replacement and initializes the new task independently', async () => {
  const older = deferred<PlanFeaturesTask>()
  api.getPlanFeaturesTask.mockReturnValueOnce(older.promise)
  await render()
  const nextId = `${id}-next`
  api.getPlanFeaturesTask.mockResolvedValue(proposal(nextId))
  await render(nextId)
  expect(state.proposal).toHaveLength(2)
  await act(async () => { older.resolve({ ...task('launched'), launchedFlightIds: ['old-flight'] }) })
  expect(state.planTask?.taskId).toBe(nextId)
  expect(onOpenFlight).not.toHaveBeenCalled()
})

it('cleans up reads and ignores navigation after teardown', async () => {
  const older = deferred<PlanFeaturesTask>()
  api.getPlanFeaturesTask.mockReturnValue(older.promise)
  await render()
  await act(async () => { root.render(null) })
  await act(async () => { older.resolve({ ...task('launched'), launchedFlightIds: ['late'] }); await vi.advanceTimersByTimeAsync(6000) })
  expect(api.getPlanFeaturesTask).toHaveBeenCalledTimes(1)
  expect(onOpenFlight).not.toHaveBeenCalled()
})

it('closes once when cancel response and task reconciliation both report cancellation', async () => {
  await render()
  const cancel = deferred<PlanFeaturesTask>()
  api.cancelPlanFeatures.mockReturnValue(cancel.promise)
  await act(async () => { state.cancelPlanning(id) })
  api.getPlanFeaturesTask.mockResolvedValue(task('cancelled'))
  await act(async () => { invalidate() })
  await act(async () => { cancel.resolve(task('cancelled')) })
  expect(onClose).toHaveBeenCalledOnce()
})

it('opens a launched task once and resets the guard for a different task', async () => {
  api.getPlanFeaturesTask.mockResolvedValue({ ...task('launched'), launchedFlightIds: ['flight-1'] })
  await render()
  await act(async () => { invalidate() })
  expect(onOpenFlight).toHaveBeenCalledExactlyOnceWith('flight-1')
  api.getPlanFeaturesTask.mockResolvedValue({ ...task('launched', `${id}-next`), launchedFlightIds: ['flight-2'] })
  await render(`${id}-next`)
  expect(onOpenFlight.mock.calls).toEqual([['flight-1'], ['flight-2']])
})

it('ignores a fallback launch result after replacing its task', async () => {
  const launching = deferred<{ flightIds: string[] }>()
  api.getPlanFeaturesTask.mockResolvedValue({ ...proposal(), result: { features: [{ name: 'one', description: 'Only suite' }] } })
  api.launchPlannedFeatures.mockReturnValue(launching.promise)
  await render()
  api.getPlanFeaturesTask.mockResolvedValue(proposal(`${id}-next`))
  await render(`${id}-next`)
  await act(async () => { launching.resolve({ flightIds: ['old-flight'] }) })
  expect(onOpenFlight).not.toHaveBeenCalled()
})
