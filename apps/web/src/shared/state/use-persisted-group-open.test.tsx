import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePersistedGroupOpen } from './use-persisted-group-open'

type Options = Parameters<typeof usePersistedGroupOpen>[0]
let root: Root
let state: ReturnType<typeof usePersistedGroupOpen>
const options: Options = { storageKey: 'features', group: 'alpha', defaultOpen: true }
function Probe(props: Options) { state = usePersistedGroupOpen(props); return <span>{String(state.open)}</span> }
const render = (props: Options = options) => act(() => root.render(<Probe {...props} />))
const toggle = () => act(() => state.toggle())
beforeEach(() => { localStorage.clear(); root = createRoot(document.createElement('div')) })
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); localStorage.clear() })

it('toggles while mounted and preserves the group map for a later mount', () => {
  localStorage.setItem('features', JSON.stringify({ beta: false }))
  const write = vi.spyOn(Storage.prototype, 'setItem')
  render()
  expect(state.open).toBe(true)
  expect(write).not.toHaveBeenCalled()
  toggle()
  expect(state.open).toBe(false)
  expect(JSON.parse(localStorage.getItem('features')!)).toEqual({ alpha: false, beta: false })
  toggle()
  expect(state.open).toBe(true)
  toggle()
  act(() => root.render(null))
  const writes = write.mock.calls.length
  render()
  expect(state.open).toBe(false)
  expect(write).toHaveBeenCalledTimes(writes)
})

it('keeps picker storage separate and initial expansion overrides stored false without writing', () => {
  localStorage.setItem('features', JSON.stringify({ alpha: true }))
  localStorage.setItem('flights', JSON.stringify({ alpha: false }))
  const write = vi.spyOn(Storage.prototype, 'setItem')
  render({ ...options, storageKey: 'flights', defaultOpen: false, expandInitially: true })
  expect(state.open).toBe(true)
  expect(write).not.toHaveBeenCalled()
  toggle()
  expect(state.open).toBe(false)
  expect(JSON.parse(localStorage.getItem('features')!)).toEqual({ alpha: true })
  expect(JSON.parse(localStorage.getItem('flights')!)).toEqual({ alpha: false })
})

it('uses the closed default and does not reset state when initial options change', () => {
  render({ ...options, defaultOpen: false })
  expect(state.open).toBe(false)
  render({ ...options, storageKey: 'flights', group: 'beta', expandInitially: true })
  expect(state.open).toBe(false)
  toggle()
  expect(state.open).toBe(true)
  expect(JSON.parse(localStorage.getItem('flights')!)).toEqual({ beta: true })
  expect(localStorage.getItem('features')).toBeNull()
})

it('ignores external storage changes and tolerates failed writes during local toggles', () => {
  render()
  localStorage.setItem('features', JSON.stringify({ alpha: false }))
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'features' })))
  expect(state.open).toBe(true)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  toggle()
  expect(state.open).toBe(false)
  toggle()
  expect(state.open).toBe(true)
})
