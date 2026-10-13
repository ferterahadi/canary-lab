import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as workspaceApi from '@/shared/api/workspace'
import * as runsApi from '@/shared/api/runs'
import { ManualHealBanner } from './ManualHealBanner'

vi.mock('@/shared/api/workspace', () => ({ openAgentApp: vi.fn() }))
vi.mock('@/shared/api/runs', () => ({ cancelHealRun: vi.fn() }))

let root: Root
let container: HTMLDivElement
const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const writeText = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  container = document.createElement('div')
  root = createRoot(container)
  act(() => root.render(<ManualHealBanner runId="run-1" signalPaths={{ rerun: '/signals/rerun', restart: '/signals/restart' }} />))
})
afterEach(() => {
  act(() => root.unmount())
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})
const buttons = () => [...container.querySelectorAll('button')]
const click = (index: number) => act(async () => { buttons()[index].click() })

it.each(['claude', 'codex'] as const)('keeps both launch buttons disabled while %s opens, then restores them', async (agent) => {
  let finish!: () => void
  vi.mocked(workspaceApi.openAgentApp).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ opened: true }) }))
  const index = agent === 'claude' ? 0 : 1
  await click(index)
  expect(workspaceApi.openAgentApp).toHaveBeenCalledWith(agent)
  expect(buttons()[0].disabled).toBe(true)
  expect(buttons()[1].disabled).toBe(true)
  expect(buttons()[index].textContent).toBe('Opening…')
  await act(async () => finish())
  expect(buttons()[0].disabled).toBe(false)
  expect(buttons()[1].disabled).toBe(false)
})

it('preserves one error stream across launch, copying, cancellation, and retry without remounting', async () => {
  vi.mocked(workspaceApi.openAgentApp).mockRejectedValueOnce(new Error('launch denied'))
  await click(0)
  expect(container.textContent).toContain('launch denied')
  await click(3)
  expect(writeText).toHaveBeenCalledWith('/signals/rerun')
  expect(container.textContent).toContain('launch denied')
  writeText.mockRejectedValueOnce(new Error('clipboard denied'))
  await click(4)
  expect(container.textContent).toContain('Could not copy to clipboard')
  expect(container.textContent).not.toContain('launch denied')
  vi.mocked(runsApi.cancelHealRun).mockRejectedValueOnce(new Error('cancel denied'))
  await click(2)
  expect(runsApi.cancelHealRun).toHaveBeenCalledWith('run-1')
  expect(container.textContent).toContain('cancel denied')
  expect(container.textContent).not.toContain('Could not copy to clipboard')
  await click(1)
  expect(container.textContent).not.toContain('cancel denied')
})

it('shows the agent-specific fallback for a non-Error rejection and clears it on cancel', async () => {
  vi.mocked(workspaceApi.openAgentApp).mockRejectedValueOnce('unavailable')
  await click(1)
  expect(container.textContent).toContain('Could not open codex')
  await click(2)
  expect(container.textContent).not.toContain('Could not open codex')
})
