// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ServicesDialog } from './ServicesDialog'

const state = vi.hoisted(() => ({ sessions: [{ runId: 'r1', feature: 'shop', status: 'booted' }], abort: vi.fn() }))
vi.mock('../state/RunsContext', () => ({
  useActiveBootSessions: () => ({ sessions: state.sessions }),
  useRuns: () => ({ abort: state.abort }),
  useRun: () => ({ detail: { manifest: { lifecycle: { phase: 'services-ready' } } }, status: 'booted', transient: null }),
}))
vi.mock('./RunDetailColumn', () => ({ RunDetailColumn: ({ runId }: { runId: string }) => <div>Details {runId}</div> }))
let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); state.abort.mockReset(); state.abort.mockResolvedValue(undefined) })
afterEach(() => { act(() => root.unmount()); container.remove() })
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === label)!

it('closing Services leaves the session running; stopping uses a separate confirmation', async () => {
  const close = vi.fn()
  act(() => root.render(<ServicesDialog onClose={close} />))
  act(() => button('Done').click())
  expect(close).toHaveBeenCalledOnce()
  expect(state.abort).not.toHaveBeenCalled()
  act(() => button('Stop session & revert').click())
  expect(document.querySelector('[aria-label="Stop shop?"]')).not.toBeNull()
  expect(state.abort).not.toHaveBeenCalled()
  await act(async () => button('Stop & revert').click())
  expect(state.abort).toHaveBeenCalledWith('r1')
  expect(document.querySelector('[aria-label="Stop shop?"]')).toBeNull()
})

it('shows stop errors and leaves the confirmation recoverable', async () => {
  state.abort.mockRejectedValueOnce(new Error('Stop failed'))
  act(() => root.render(<ServicesDialog onClose={vi.fn()} />))
  act(() => button('Stop session & revert').click())
  await act(async () => button('Stop & revert').click())
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Stop failed')
  expect(button('Stop & revert').disabled).toBe(false)
})
