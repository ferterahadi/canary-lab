// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/api/internal'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { TokenPicker } from './TokenPicker'
import type { TokenNamespace } from './TemplatedInput'

const api = vi.hoisted(() => ({ getEnvsetsIndex: vi.fn(), getFeatureConfigDoc: vi.fn(), getEnvsetSlot: vi.fn() }))
vi.mock('@/shared/api/client', () => api)
let root: Root
let element: HTMLDivElement
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
const picked = vi.fn()
const closed = vi.fn()
const index = (slots = ['app.env'], env = 'local') => ({ envs: [{ name: env, slots }] })
const doc = (names: string[]) => ({ parsed: { value: { repos: [{ startCommands: [{ ports: names.map((name) => ({ name })) }] }] } } })
const keys = (...names: string[]) => ({ entries: names.map((key) => ({ key, value: '' })) })
function Probe({ feature = 'checkout', namespaces = ['envset'] }: { feature?: string; namespaces?: TokenNamespace[] }) {
  invalidate = useInvalidation().invalidate
  return <TokenPicker feature={feature} namespaces={namespaces} state={{ caret: { top: 0, left: 0 }, replacingPill: null }} onClose={closed} onPick={picked} />
}
const render = (feature = 'checkout', namespaces?: TokenNamespace[]) => act(async () => root.render(<InvalidationProvider><Probe feature={feature} namespaces={namespaces} /></InvalidationProvider>))
const button = (label: string) => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)
const tick = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  element = document.createElement('div')
  document.body.appendChild(element)
  root = createRoot(element)
  api.getEnvsetsIndex.mockResolvedValue(index())
  api.getFeatureConfigDoc.mockResolvedValue(doc(['web']))
  api.getEnvsetSlot.mockResolvedValue(keys('HOST'))
})
afterEach(() => { act(() => root.unmount()); element.remove(); vi.useRealTimers() })

it('removes deleted slots from an already open picker on scoped configuration invalidation', async () => {
  await render()
  expect(button('app.env')).toBeDefined()
  api.getEnvsetsIndex.mockResolvedValue(index([]))
  await act(async () => invalidate('configuration', 'checkout'))
  expect(button('app.env')).toBeUndefined()
  expect(api.getEnvsetsIndex).toHaveBeenCalledTimes(2)
})

it('recovers missed edits every five seconds and returns to slots when the selected slot disappears', async () => {
  await render()
  await act(async () => button('app.env')!.click())
  expect(button('HOST')?.disabled).toBe(false)
  api.getEnvsetSlot.mockResolvedValue(keys('NEW'))
  await tick(4999)
  expect(button('HOST')).toBeDefined()
  await tick(1)
  expect(button('HOST')).toBeUndefined()
  expect(button('NEW')).toBeDefined()
  api.getEnvsetsIndex.mockResolvedValue(index([]))
  await tick(5000)
  expect(document.body.textContent).toContain('Pick a slot')
  expect(button('NEW')).toBeUndefined()
})

it('keeps failed options visible but disables selection until Retry succeeds', async () => {
  await render('checkout', ['envset', 'port'])
  api.getFeatureConfigDoc.mockRejectedValueOnce(new Error('read failed'))
  await tick(5000)
  expect(button('${port.web}')?.disabled).toBe(true)
  expect(button('app.env')?.disabled).toBe(false)
  await act(async () => button('${port.web}')!.click())
  expect(picked).not.toHaveBeenCalled()
  await act(async () => button('Retry')!.click())
  expect(button('${port.web}')?.disabled).toBe(false)
})

it('supersedes hung reads, rejects old environment keys, and keeps first-environment lookup', async () => {
  const old = deferred<ReturnType<typeof keys>>()
  api.getEnvsetSlot.mockReturnValueOnce(old.promise).mockResolvedValue(keys('CURRENT'))
  await render()
  await act(async () => button('app.env')!.click())
  api.getEnvsetsIndex.mockResolvedValue({ envs: [{ name: 'staging', slots: ['app.env'] }, { name: 'ignored', slots: ['other.env'] }] })
  await act(async () => invalidate('configuration'))
  await act(async () => old.resolve(keys('OLD')))
  expect(api.getEnvsetSlot).toHaveBeenLastCalledWith('checkout', 'staging', 'app.env')
  expect(button('OLD')).toBeUndefined()
  expect(button('CURRENT')?.disabled).toBe(false)
  await act(async () => button('CURRENT')!.click())
  expect(picked).toHaveBeenCalledWith('app.env', 'CURRENT')
})

it('withdraws stale keys after failure and clears authoritative missing resources', async () => {
  await render()
  await act(async () => button('app.env')!.click())
  api.getEnvsetSlot.mockRejectedValueOnce(new Error('offline'))
  await tick(5000)
  expect(button('HOST')?.disabled).toBe(true)
  api.getEnvsetSlot.mockRejectedValue(new ApiError(404, {}))
  await tick(5000)
  expect(button('HOST')).toBeUndefined()
  api.getEnvsetsIndex.mockRejectedValue(new ApiError(404, {}))
  await tick(5000)
  expect(button('app.env')).toBeUndefined()
})

it('isolates namespaces and features, recovers hung initial reads, and cleans up', async () => {
  const old = deferred<ReturnType<typeof doc>>()
  api.getFeatureConfigDoc.mockReturnValueOnce(old.promise).mockResolvedValue(doc(['new']))
  await render('first', ['port'])
  expect(api.getEnvsetsIndex).not.toHaveBeenCalled()
  expect(api.getEnvsetSlot).not.toHaveBeenCalled()
  await tick(5000)
  expect(button('${port.new}')).toBeDefined()
  await render('second', ['port'])
  await act(async () => old.resolve(doc(['old'])))
  expect(button('${port.old}')).toBeUndefined()
  const count = api.getFeatureConfigDoc.mock.calls.length
  await act(async () => root.render(null))
  await tick(10000)
  expect(api.getFeatureConfigDoc).toHaveBeenCalledTimes(count)
  expect(document.querySelector('.cl-popover')).toBeNull()
})

it('ignores other features and preserves Escape closing', async () => {
  await render()
  await act(async () => invalidate('configuration', 'unrelated'))
  expect(api.getEnvsetsIndex).toHaveBeenCalledTimes(1)
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(closed).toHaveBeenCalledTimes(1)
})
