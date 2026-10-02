// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as runsApi from '@/shared/api/runs'
import { GitHubSection } from './GitHubSection'
vi.mock('@/shared/api/runs', () => ({
  getGhStatus: vi.fn(),
}))
let root: Root
let element: HTMLDivElement
const connected = { installed: true, authenticated: true, account: 'new-account', host: 'github.example' }
const render = () => act(async () => { root.render(<GitHubSection />) })
const refresh = () => act(async () => { element.querySelector<HTMLButtonElement>('[data-testid="settings-github-refresh"]')!.click() })
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); element = document.createElement('div'); root = createRoot(element); vi.mocked(runsApi.getGhStatus).mockResolvedValue(connected) })
afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })
it('a newer manual probe supersedes the delayed initial response', async () => {
  let resolve!: (value: typeof connected) => void
  vi.mocked(runsApi.getGhStatus).mockReturnValueOnce(new Promise((yes) => { resolve = yes }))
  await render(); await refresh()
  expect(element.textContent).toContain('new-account (github.example)')
  await act(async () => { resolve({ ...connected, authenticated: false }) })
  expect(element.textContent).toContain('new-account (github.example)')
  expect(element.textContent).not.toContain('Not signed in')
})
it('retains accepted status on failure, retries manually, and never polls', async () => {
  await render()
  vi.mocked(runsApi.getGhStatus).mockRejectedValueOnce(new Error('probe unavailable'))
  await refresh()
  expect(element.textContent).toContain('new-account')
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('probe unavailable')
  expect(element.textContent).not.toContain('brew install')
  await act(async () => { [...element.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click() })
  expect(element.querySelector('[role="alert"]')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(runsApi.getGhStatus).toHaveBeenCalledTimes(3)
})
it.each([
  [{ installed: false, authenticated: false }, 'brew install gh'],
  [{ installed: true, authenticated: false }, 'gh auth login'],
])('shows remediation only for authoritative results %j', async (value, command) => {
  vi.mocked(runsApi.getGhStatus).mockResolvedValue(value)
  await render()
  expect(element.textContent).toContain(command)
})
it('shows an initial read failure separately from missing CLI and rejects teardown results', async () => {
  vi.mocked(runsApi.getGhStatus).mockRejectedValueOnce(new Error('offline'))
  await render()
  expect(element.textContent).toContain('GitHub status unavailable')
  expect(element.textContent).not.toContain('not installed')
  let resolve!: (value: typeof connected) => void
  vi.mocked(runsApi.getGhStatus).mockReturnValueOnce(new Promise((yes) => { resolve = yes }))
  await refresh()
  await act(async () => { root.render(null) })
  await act(async () => { resolve(connected) })
  expect(element.textContent).toBe('')
})
