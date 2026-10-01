import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as workspaceApi from '@/shared/api/workspace'
import { BranchControl } from './RepoBranchControl'
import type { RepoSlice } from './repo-slice'

vi.mock('@/shared/api/workspace', () => ({
  getRepoGitStatus: vi.fn(),
  checkoutRepoBranch: vi.fn(),
}))
const status = (currentBranch = 'main', dirty = false): workspaceApi.GitRepoStatus => ({ path: '/workspace/app', expectedBranch: null, isGitRepo: true, currentBranch, detached: false, dirty, dirtyFiles: dirty ? ['M app.ts'] : [], localBranches: ['main', 'other'], remoteBranches: [] })
let container: HTMLDivElement
let root: Root
function Editor({ feature = 'checkout', activeRun = false }: { feature?: string; activeRun?: boolean }) {
  const [repo, setRepo] = useState<RepoSlice>({ name: 'app', localPath: '/workspace/app', branch: 'other', startCommands: [] })
  return <BranchControl feature={feature} repo={repo} repoLookupName="app" localPathStr="/workspace/app" isExpr={false} activeRun={activeRun} onChange={setRepo} />
}
const render = (props: Parameters<typeof Editor>[0] = {}) => act(async () => { root.render(<Editor {...props} />) })
const switchButton = () => [...container.querySelectorAll('button')].find((button) => /Switch/.test(button.textContent ?? ''))!
const advance = (ms = 30000) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  vi.mocked(workspaceApi.getRepoGitStatus).mockResolvedValue(status())
  vi.mocked(workspaceApi.checkoutRepoBranch).mockResolvedValue(status('other'))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks() })

it('shows initial checking, then retains stale evidence and drafts while disabling Switch until recovery', async () => {
  let finish!: (value: workspaceApi.GitRepoStatus) => void
  vi.mocked(workspaceApi.getRepoGitStatus).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  await render()
  expect(container.textContent).toContain('Checking Git status'); expect(container.textContent).not.toContain('Not a git repository')
  expect(switchButton().disabled).toBe(true)
  await act(async () => { finish(status()) })
  expect(switchButton().disabled).toBe(false)
  vi.mocked(workspaceApi.getRepoGitStatus).mockRejectedValue(new Error('read failed'))
  await advance()
  expect(container.querySelector('input')?.placeholder).toBe('main')
  expect(container.querySelector('input')?.value).toBe('other')
  expect(container.textContent).toContain('Git status is stale'); expect(switchButton().disabled).toBe(true)
  vi.mocked(workspaceApi.getRepoGitStatus).mockResolvedValue(status('main', true)); await advance()
  expect(container.textContent).toContain('1 uncommitted'); expect(switchButton().disabled).toBe(true)
  vi.mocked(workspaceApi.getRepoGitStatus).mockResolvedValue(status()); await advance()
  expect(container.textContent).not.toContain('stale'); expect(switchButton().disabled).toBe(false)
  await render({ activeRun: true }); expect(switchButton().disabled).toBe(true)
})

it('expires the Switch decision when reads hang and preserves the open suggestions during recovery', async () => {
  await render()
  await act(async () => { container.querySelector('input')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(container.textContent).toContain('main')
  vi.mocked(workspaceApi.getRepoGitStatus).mockReturnValue(new Promise(() => {}))
  await advance(45000)
  expect(switchButton().disabled).toBe(true); expect(container.textContent).toContain('stale')
  vi.mocked(workspaceApi.getRepoGitStatus).mockResolvedValue(status('other'))
  await advance()
  expect(container.querySelector('input')?.value).toBe('other')
  expect(container.textContent).toContain('main')
  expect(container.textContent).not.toContain('stale')
})

it('refreshes authoritative state after checkout and keeps action failures across background reads', async () => {
  await render()
  vi.mocked(workspaceApi.checkoutRepoBranch).mockRejectedValue(new Error('checkout refused'))
  await act(async () => { switchButton().click() })
  expect(container.textContent).toContain('checkout refused')
  await advance(); expect(container.textContent).toContain('checkout refused')
  expect(container.querySelector('input')?.value).toBe('other')
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Refresh git status"]')!.click() })
  expect(container.textContent).not.toContain('checkout refused')
  // Mutation payload is not the reader: only the subsequent GET decides status.
  vi.mocked(workspaceApi.checkoutRepoBranch).mockResolvedValue(status('wrong-response'))
  vi.mocked(workspaceApi.getRepoGitStatus).mockResolvedValue(status('other'))
  await act(async () => { switchButton().click() })
  expect(container.querySelector('input')?.placeholder).toBe('other')
  expect(switchButton().disabled).toBe(true)
})

it.each(['target', 'unmount'] as const)('ignores checkout completion after %s, including a return to the same target', async (change) => {
  await render()
  let reject!: (error: Error) => void
  vi.mocked(workspaceApi.checkoutRepoBranch).mockReturnValue(new Promise((_resolve, no) => { reject = no }))
  await act(async () => { switchButton().click() })
  expect(switchButton().disabled).toBe(true)
  if (change === 'target') { await render({ feature: 'billing' }); await render() }
  else await act(async () => { root.render(null) })
  const reads = vi.mocked(workspaceApi.getRepoGitStatus).mock.calls.length
  await act(async () => { reject(new Error('old checkout')) })
  expect(container.textContent).not.toContain('old checkout')
  expect(workspaceApi.getRepoGitStatus).toHaveBeenCalledTimes(reads)
})
