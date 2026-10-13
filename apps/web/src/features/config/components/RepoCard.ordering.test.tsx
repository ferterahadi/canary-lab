// @vitest-environment happy-dom
import { act, useState, type Dispatch, type SetStateAction } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RepoCard } from './RepoCard'
import type { RepoSlice } from './repo-slice'
import { deferred } from '../../../../../../tools/test-helpers/deferred'
import { mountRoot } from '@/test-helpers/mount-root'
const api = vi.hoisted(() => ({ getGitRemote: vi.fn(), checkPathExists: vi.fn(), cloneRepository: vi.fn() }))
const folder = vi.hoisted(() => ({ choose: (_: string) => {}, clone: (_: string) => {} }))
vi.mock('@/shared/api/workspace', () => ({
  getGitRemote: api.getGitRemote,
  checkPathExists: api.checkPathExists,
  cloneRepository: api.cloneRepository,
}))
vi.mock('./RepoBranchControl', () => ({ BranchControl: () => null }))
vi.mock('./FolderPicker', () => ({
  FolderPicker: ({ onChange }: { onChange: (path: string) => void }) => { folder.choose = onChange; return null },
  FolderPickerModal: ({ onConfirm }: { onConfirm: (path: string) => void }) => { folder.clone = onConfirm; return null },
}))
let root: Root
let container: HTMLDivElement
let current: RepoSlice
let edit: Dispatch<SetStateAction<RepoSlice>>
function Host({ cloneUrl }: { cloneUrl?: string }) {
  const [repo, setRepo] = useState<RepoSlice>({ name: 'app', localPath: '/repo/initial', cloneUrl, startCommands: [] })
  current = repo
  edit = setRepo
  return <RepoCard feature="suite" repo={repo} repoLookupName="app" rootEnvs={[]} activeRun={false} onChange={setRepo} onRemove={() => {}} />
}

const button = (label: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!
beforeEach(() => {
  vi.resetAllMocks()
  api.checkPathExists.mockResolvedValue({ exists: false })
  api.getGitRemote.mockResolvedValue({ cloneUrl: null })
})
afterEach(() => { vi.useRealTimers() })
mountRoot({ attach: true, onMount: (mounted) => ({ container, root } = mounted) })

it('ignores delayed A after B and preserves edits made during remote detection', async () => {
  const a = deferred<unknown>()
  const b = deferred<unknown>()
  api.getGitRemote.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
  await act(async () => root.render(<Host />))
  await act(async () => folder.choose('/repo/a'))
  await act(async () => folder.choose('/repo/b'))
  act(() => edit((repo) => ({ ...repo, name: 'manual', branch: 'work' })))
  await act(async () => b.resolve({ cloneUrl: 'https://example.invalid/b.git' }))
  await act(async () => a.resolve({ cloneUrl: 'https://example.invalid/a.git' }))
  expect(current).toMatchObject({ localPath: '/repo/b', cloneUrl: 'https://example.invalid/b.git', name: 'manual', branch: 'work' })
})
it('does not refill a manually edited URL and rejects the first A in A → B → A', async () => {
  const old = deferred<unknown>()
  const latest = deferred<unknown>()
  api.getGitRemote.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ cloneUrl: null }).mockReturnValueOnce(latest.promise)
  await act(async () => root.render(<Host />))
  await act(async () => folder.choose('/repo/a'))
  await act(async () => folder.choose('/repo/b'))
  await act(async () => folder.choose('/repo/a'))
  await act(async () => old.resolve({ cloneUrl: 'obsolete' }))
  expect(current.cloneUrl).toBeUndefined()
  act(() => edit((repo) => ({ ...repo, cloneUrl: 'manual' })))
  await act(async () => latest.resolve({ cloneUrl: 'automatic' }))
  expect(current.cloneUrl).toBe('manual')
})
it('scopes path existence, supports Retry after failure, and does not poll', async () => {
  vi.useFakeTimers()
  const old = deferred<unknown>()
  api.checkPathExists.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ exists: true })
  await act(async () => root.render(<Host cloneUrl="https://example.invalid/app.git" />))
  await act(async () => folder.choose('/repo/b'))
  expect(container.textContent).toContain('offline')
  await act(async () => button('Retry').click())
  await act(async () => old.resolve({ exists: false }))
  expect(button('Clone…')).toBeUndefined()
  await act(async () => vi.advanceTimersByTime(30000))
  expect(api.checkPathExists).toHaveBeenCalledTimes(3)
})
it('clone patches only its fields, preserves newer edits, and suppresses duplicate submissions', async () => {
  const pending = deferred<unknown>()
  api.cloneRepository.mockReturnValueOnce(pending.promise)
  await act(async () => root.render(<Host cloneUrl="https://example.invalid/app.git" />))
  act(() => button('Clone…').click())
  await act(async () => { folder.clone('/parent'); folder.clone('/parent') })
  act(() => edit((repo) => ({ ...repo, name: 'manual', branch: 'new', startCommands: [{ name: 'server', command: 'serve', health: { mode: 'none' } }] })))
  await act(async () => pending.resolve({ localPath: '/parent/app' }))
  expect(api.cloneRepository).toHaveBeenCalledTimes(1)
  expect(current).toMatchObject({ localPath: '/parent/app', name: 'manual', branch: 'new', startCommands: [{ name: 'server', command: 'serve', health: { mode: 'none' } }] })
  expect(api.checkPathExists).toHaveBeenLastCalledWith('/parent/app')
})
it.each(['success', 'error'])('expires clone %s after path replacement and permits a later retry', async (outcome) => {
  const pending = deferred<unknown>()
  api.cloneRepository.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ localPath: '/new/clone' })
  await act(async () => root.render(<Host cloneUrl="https://example.invalid/app.git" />))
  act(() => button('Clone…').click())
  await act(async () => { folder.clone('/parent') })
  await act(async () => folder.choose('/different'))
  await act(async () => outcome === 'success' ? pending.resolve({ localPath: '/obsolete' }) : pending.reject(new Error('old failure')))
  expect(current.localPath).toBe('/different')
  expect(container.textContent).not.toContain('old failure')
  act(() => button('Clone…').click())
  await act(async () => folder.clone('/new'))
  expect(current.localPath).toBe('/new/clone')
})
it('ignores clone and lookup completions after row replacement or teardown', async () => {
  const pending = deferred<unknown>()
  api.cloneRepository.mockReturnValueOnce(pending.promise)
  await act(async () => root.render(<Host key="old" cloneUrl="https://example.invalid/app.git" />))
  act(() => button('Clone…').click())
  await act(async () => { folder.clone('/parent') })
  await act(async () => root.render(<Host key="new" />))
  await act(async () => pending.resolve({ localPath: '/obsolete' }))
  expect(current.localPath).toBe('/repo/initial')
  const lookup = deferred<unknown>()
  api.getGitRemote.mockReturnValueOnce(lookup.promise)
  await act(async () => folder.choose('/late'))
  await act(async () => root.render(null))
  await act(async () => lookup.resolve({ cloneUrl: 'late' }))
  expect(current.cloneUrl).toBeUndefined()
})
it('retains clone errors for the current row and allows another attempt', async () => {
  api.cloneRepository.mockRejectedValueOnce(new Error('clone unavailable')).mockResolvedValueOnce({ localPath: '/retry/app' })
  await act(async () => root.render(<Host cloneUrl="https://example.invalid/app.git" />))
  act(() => button('Clone…').click())
  await act(async () => folder.clone('/parent'))
  expect(container.textContent).toContain('clone unavailable')
  act(() => button('Clone…').click())
  await act(async () => folder.clone('/retry'))
  expect(current.localPath).toBe('/retry/app')
  expect(container.textContent).not.toContain('clone unavailable')
})
