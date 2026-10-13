import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useControlledBoolean } from './use-controlled-boolean'

let root: Root
let state: ReturnType<typeof useControlledBoolean>
function Probe({ value, onChange }: { value?: boolean; onChange?: (next: boolean) => void }) {
  state = useControlledBoolean(value, onChange)
  return <span>{String(state[0])}</span>
}
const render = (value?: boolean, onChange?: (next: boolean) => void) => act(() => root.render(<Probe value={value} onChange={onChange} />))
const set = (value: boolean) => act(() => state[1](value))
beforeEach(() => { root = createRoot(document.createElement('div')) })
afterEach(() => { act(() => root.unmount()) })

it('opens and closes local state, preserving it across externally controlled renders', () => {
  render()
  expect(state[0]).toBe(false)
  set(true)
  expect(state[0]).toBe(true)
  render(false)
  expect(state[0]).toBe(false)
  render(true)
  expect(state[0]).toBe(true)
  render()
  expect(state[0]).toBe(true)
  set(false)
  expect(state[0]).toBe(false)
})

it('uses the latest callback without changing hidden internal state', () => {
  const first = vi.fn()
  const second = vi.fn()
  render(false, first)
  set(true)
  expect(first).toHaveBeenCalledExactlyOnceWith(true)
  expect(state[0]).toBe(false)
  render(true, second)
  set(false)
  expect(second).toHaveBeenCalledExactlyOnceWith(false)
  expect(first).toHaveBeenCalledTimes(1)
  expect(state[0]).toBe(true)
  render()
  expect(state[0]).toBe(false)
})

it('preserves callback-only and value-only behavior independently', () => {
  const onChange = vi.fn()
  render(undefined, onChange)
  set(true)
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true)
  expect(state[0]).toBe(false)
  render(false)
  set(true)
  expect(state[0]).toBe(false)
  render()
  expect(state[0]).toBe(true)
})
