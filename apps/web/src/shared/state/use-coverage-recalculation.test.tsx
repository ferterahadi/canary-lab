// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverageJobIndexEntry } from '@shared/coverage/types'
import { ApiError } from '@/shared/api/internal'
import { useCoverageRecalculation } from './use-coverage-recalculation'

const mocks = vi.hoisted(() => ({ start: vi.fn(), get: vi.fn() }))
vi.mock('@/shared/api/coverage', () => ({ startCoverageJob: mocks.start, getCoverageJob: mocks.get }))

describe('direct coverage recalculation', () => {
  let root: Root
  let host: HTMLDivElement
  let controller: ReturnType<typeof useCoverageRecalculation>
  const open = vi.fn()
  const invalidate = vi.fn()
  const hasActiveFlight = vi.fn(() => false)
  function Harness({ jobs = [] }: { jobs?: CoverageJobIndexEntry[] }) {
    controller = useCoverageRecalculation({ jobs, hasActiveFlight, openRequirements: open, invalidate })
    return <span>{controller.launch?.status}:{controller.launch?.error}</span>
  }
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.start.mockResolvedValue({ jobId: 'job' })
    host = document.createElement('div')
    root = createRoot(host)
    act(() => root.render(<Harness />))
  })
  afterEach(() => act(() => root.unmount()))

  it('navigates immediately, starts summary once, and survives leaving the source page', async () => {
    let finish!: (value: unknown) => void
    mocks.start.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    act(() => {
      controller.start('checkout', 'prd-summary')
      controller.start('checkout', 'prd-summary')
    })
    expect(open).toHaveBeenCalledExactlyOnceWith('checkout')
    expect(host.textContent).toBe('starting:')
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith('checkout', 'summary', undefined)
    await act(async () => finish({ jobId: 'job' }))
    expect(host.textContent).toBe('started:')
    expect(invalidate).toHaveBeenCalledOnce()
  })

  it('starts mapping only for a mapping recovery and never starts run recovery', async () => {
    await act(async () => controller.start('checkout', 'specs-coverage'))
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith('checkout', 'coverage', undefined)
    act(() => controller.start('checkout', 'run'))
    expect(mocks.start).toHaveBeenCalledOnce()
  })

  it('sends the confirmed models and keeps them for a retry', async () => {
    const launchModels = { agent: 'codex' as const, models: { prd: { model: null, effort: null } } }
    mocks.start.mockRejectedValueOnce(new Error('Cannot start'))
    await act(async () => controller.start('checkout', 'prd-summary', launchModels))
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith('checkout', 'summary', { adapter: 'codex', models: launchModels.models })
    expect(controller.launch?.launchModels).toBe(launchModels)
    expect(host.textContent).toBe('failed:Cannot start')
  })

  it('attaches to active work and to a concurrent launch conflict', async () => {
    const active = { feature: 'checkout', status: 'running', jobId: 'existing' } as CoverageJobIndexEntry
    act(() => root.render(<Harness jobs={[active]} />))
    await act(async () => controller.start('checkout', 'prd-summary'))
    expect(mocks.start).not.toHaveBeenCalled()
    act(() => root.render(<Harness />))
    mocks.start.mockRejectedValue(new ApiError(409, { existingJobId: 'existing' }))
    await act(async () => controller.start('checkout', 'prd-summary'))
    expect(mocks.get).toHaveBeenCalledWith('existing')
    expect(host.textContent).toBe('started:')
  })

  it('attaches when a flight conductor already owns coverage work', async () => {
    hasActiveFlight.mockReturnValue(true)
    await act(async () => controller.start('checkout', 'prd-summary'))
    expect(mocks.start).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('checkout')
    expect(host.textContent).toBe('started:')
  })

  it('retains failures for an explicit retry, and ignores a late result from another feature', async () => {
    mocks.start.mockRejectedValueOnce(new Error('Cannot start'))
    await act(async () => controller.start('checkout', 'prd-summary'))
    expect(host.textContent).toBe('failed:Cannot start')
    await act(async () => controller.start('checkout', 'prd-summary'))
    expect(host.textContent).toBe('started:')
    let fail!: (error: Error) => void
    mocks.start.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    act(() => controller.start('old', 'prd-summary'))
    await act(async () => controller.start('new', 'prd-summary'))
    await act(async () => fail(new Error('Late old error')))
    expect(controller.launch?.feature).toBe('new')
    expect(host.textContent).toBe('started:')
  })

  it('ignores a late success from a replaced launch and reports a non-Error rejection as text', async () => {
    let finish!: (value: unknown) => void
    mocks.start.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    act(() => controller.start('old', 'prd-summary'))
    mocks.start.mockRejectedValueOnce('offline')
    await act(async () => controller.start('new', 'prd-summary'))
    expect(host.textContent).toBe('failed:offline')
    await act(async () => finish({ jobId: 'late' }))
    expect(controller.launch?.feature).toBe('new')
    expect(host.textContent).toBe('failed:offline')
  })
})
