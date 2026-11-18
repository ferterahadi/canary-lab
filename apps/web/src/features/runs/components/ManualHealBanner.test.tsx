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
  const prompt = container.querySelector('textarea')!.value
  expect(writeText).toHaveBeenCalledWith(prompt)
  expect(prompt).toContain('run-1')
  expect(prompt).toContain('/signals/rerun')
  expect(prompt).toContain('/signals/restart')
  expect(buttons()[3].textContent).toBe('Copied')
  expect(container.textContent).toContain('launch denied')
  writeText.mockRejectedValueOnce(new Error('clipboard denied'))
  await click(3)
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

it('shows the cycle and one recorded failure without attributing other failures to that test', () => {
  const failure = { name: 'gateway becomes ready', error: { message: 'Readiness timed out' } }
  const renderFailures = (failed: typeof failure[]) => act(() => root.render(
    <ManualHealBanner
      runId="run-1"
      signalPaths={{ rerun: '/signals/rerun', restart: '/signals/restart' }}
      cycle={2}
      summary={{ complete: true, passed: 0, total: failed.length, failed }}
    />,
  ))
  renderFailures([failure])
  expect(container.textContent).toContain('Cycle 2')
  expect(container.textContent).toContain('gateway becomes ready')
  expect(container.textContent).toContain('Readiness timed out')
  renderFailures([failure, { ...failure, name: 'gateway responds' }])
  expect(container.textContent).toContain('2 failed tests')
  expect(container.textContent).not.toContain('Readiness timed out')
})

it('emphasizes one launcher and yields the primary action to a pending review', () => {
  const renderWith = (primaryAgent: 'codex' | null) => act(() => root.render(
    <ManualHealBanner runId="run-1" signalPaths={{ rerun: '/rerun', restart: '/restart' }} primaryAgent={primaryAgent} />,
  ))
  expect(container.querySelector('.cl-button-primary')?.textContent).toBe('Open Claude')
  renderWith('codex')
  expect(container.querySelector('.cl-button-primary')?.textContent).toBe('Open Codex')
  renderWith(null)
  expect(container.querySelector('.cl-button-primary')).toBeNull()
  expect(buttons().filter(button => !button.disabled)).toHaveLength(4)
})
