// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/api/internal'
import { AddSlotModal } from './AddSlotModal'
import { CopyFromModal } from './CopyFromModal'
import { FolderPickerModal } from './FolderPicker'
import { useFilesystemBrowser } from './use-filesystem-browser'
import { deferred } from '../../../../../../tools/test-helpers/deferred'
import { mountRoot } from '@/test-helpers/mount-root'

const api = vi.hoisted(() => ({ browseDir: vi.fn(), listWorkspaceDirs: vi.fn(), readDotenvFile: vi.fn(), getEnvsetSlot: vi.fn(), addEnvsetSlot: vi.fn() }))
vi.mock('@/shared/api/config', () => ({
  browseDir: api.browseDir,
  readDotenvFile: api.readDotenvFile,
  getEnvsetSlot: api.getEnvsetSlot,
  addEnvsetSlot: api.addEnvsetSlot,
}))
vi.mock('@/shared/api/workspace', () => ({
  listWorkspaceDirs: api.listWorkspaceDirs,
}))
let root: Root

const directory = (dir: string, name = 'current.env') => ({ dir, parent: '/root', entries: [{ name, isDir: false }] })
const button = (label: string) => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!
function input(value: string) {
  const node = document.querySelector<HTMLInputElement>('input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
}
beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(() => { vi.useRealTimers() })
mountRoot({ attach: true, onMount: (mounted) => ({ root } = mounted) })

it.each(['add', 'copy'])('%s rejects delayed navigation and disables retained files until the requested directory succeeds', async (kind) => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  api.browseDir.mockResolvedValueOnce(directory('/root', 'old.env')).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  await act(async () => root.render(kind === 'add'
    ? <AddSlotModal feature="suite" envCount={1} onClose={() => {}} onAdded={() => {}} />
    : <CopyFromModal feature="suite" targetEnv="local" slot="app.env" siblingEnvs={[]} current={[]} onClose={() => {}} onApply={() => {}} />))
  await act(async () => { input('/root/a'); button('Go').click() })
  expect(button('old.env').disabled).toBe(true)
  await act(async () => { input('/root/b'); button('Go').click() })
  await act(async () => second.resolve(directory('/root/b')))
  expect(button('current.env').disabled).toBe(false)
  await act(async () => first.resolve(directory('/root/a', 'obsolete.env')))
  expect(button('obsolete.env')).toBeUndefined()
  expect(document.querySelector('input')?.value).toBe('/root/b')
})

let browser: ReturnType<typeof useFilesystemBrowser>
function Browser({ session = 'one', kind = 'files' as 'files' | 'folders' }) {
  browser = useFilesystemBrowser({ session, kind })
  return null
}
it('retries failed and hung reads, refreshes repeated Go, preserves typed text, and never polls', async () => {
  vi.useFakeTimers()
  const hung = deferred<unknown>()
  api.browseDir.mockResolvedValueOnce(directory('/root')).mockReturnValueOnce(hung.promise).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(directory('/root'))
  await act(async () => root.render(<Browser />))
  await act(async () => browser.navigate('/root'))
  act(() => browser.setPathInput('/typed/later'))
  await act(async () => browser.retry())
  expect(browser.error).toBe('offline')
  expect(browser.browse?.dir).toBe('/root')
  expect(browser.confirmed).toBe(false)
  await act(async () => browser.retry())
  expect(browser.confirmed).toBe(true)
  expect(browser.pathInput).toBe('/typed/later')
  await act(async () => hung.resolve(directory('/obsolete')))
  expect(browser.browse?.dir).toBe('/root')
  await act(async () => vi.advanceTimersByTime(30000))
  expect(api.browseDir).toHaveBeenCalledTimes(4)
})

it.each(['404', 'legacy'])('clears entries for an authoritative missing directory (%s) and recovers', async (kind) => {
  api.browseDir.mockResolvedValueOnce(directory('/root'))
  if (kind === '404') api.browseDir.mockRejectedValueOnce(new ApiError(404, 'missing'))
  else api.browseDir.mockResolvedValueOnce({ dir: '/home', parent: null, entries: [] })
  api.browseDir.mockResolvedValueOnce(directory('/restored'))
  await act(async () => root.render(<Browser />))
  await act(async () => browser.navigate('/gone'))
  expect(browser.browse).toBeNull()
  expect(browser.confirmed).toBe(false)
  expect(browser.error).toContain('no longer available')
  await act(async () => browser.retry())
  expect(browser.confirmed).toBe(true)
})

it('expires a replaced picker session and teardown callbacks', async () => {
  const old = deferred<unknown>()
  api.browseDir.mockReturnValueOnce(old.promise).mockResolvedValueOnce(directory('/new'))
  await act(async () => root.render(<Browser />))
  await act(async () => root.render(<Browser session="two" />))
  await act(async () => old.resolve(directory('/old')))
  expect(browser.browse?.dir).toBe('/new')
  const late = deferred<unknown>()
  api.browseDir.mockReturnValueOnce(late.promise)
  await act(async () => browser.retry())
  await act(async () => root.render(null))
  await act(async () => late.resolve(directory('/late')))
  expect(browser.confirmed).toBe(false)
})

it('folder confirmation is unavailable during refresh or failure and uses only the accepted directory', async () => {
  const hung = deferred<unknown>()
  const confirm = vi.fn()
  api.listWorkspaceDirs.mockResolvedValueOnce({ root: '/root', absolute: '/root', parent: null, dirs: ['child'] }).mockReturnValueOnce(hung.promise).mockResolvedValueOnce({ root: '/root', absolute: '/root/child', parent: '/root', dirs: [] })
  await act(async () => root.render(<FolderPickerModal initialPath="/root" title="Folder" confirmLabel="Use" onConfirm={confirm} onCancel={() => {}} />))
  await act(async () => button('child/').click())
  expect(button('Use').disabled).toBe(true)
  act(() => button('Use').click())
  expect(confirm).not.toHaveBeenCalled()
  await act(async () => button('Retry').click())
  act(() => button('Use').click())
  expect(confirm).toHaveBeenCalledWith('/root/child')
  await act(async () => hung.resolve({ root: '/old', absolute: '/old', dirs: [] }))
  expect(document.body.textContent).not.toContain('/old')
})

it('Copy From expires previews after mode, source, and feature replacement', async () => {
  const old = deferred<unknown>()
  const file = deferred<unknown>()
  api.getEnvsetSlot.mockReturnValueOnce(old.promise).mockResolvedValue({ entries: [{ key: 'CURRENT', value: 'yes' }] })
  api.browseDir.mockResolvedValue(directory('/root', 'file.env'))
  api.readDotenvFile.mockReturnValueOnce(file.promise)
  const render = (feature: string) => root.render(<CopyFromModal feature={feature} targetEnv="local" slot="app" siblingEnvs={['a', 'b']} current={[]} onClose={() => {}} onApply={() => {}} />)
  await act(async () => render('one'))
  await act(async () => button('Compare').click())
  await act(async () => button('From file').click())
  await act(async () => button('file.env').click())
  await act(async () => old.resolve({ entries: [{ key: 'OLD', value: 'bad' }] }))
  expect(button('Apply')).toBeUndefined()
  await act(async () => render('two'))
  await act(async () => file.resolve({ entries: [{ key: 'OLD_FILE', value: 'bad' }] }))
  expect(button('Apply')).toBeUndefined()
  await act(async () => button('Compare').click())
  expect(document.body.textContent).toContain('CURRENT')
  expect(document.body.textContent).not.toContain('OLD')
})

it('Add Slot suppresses duplicates and ignores completion after feature replacement', async () => {
  const pending = deferred<unknown>()
  const added = vi.fn()
  api.browseDir.mockResolvedValue(directory('/root'))
  api.addEnvsetSlot.mockReturnValue(pending.promise)
  const render = (feature: string) => root.render(<AddSlotModal feature={feature} envCount={1} onClose={() => {}} onAdded={added} />)
  await act(async () => render('one'))
  act(() => button('current.env').click())
  await act(async () => { button('Add slot').click(); button('Add slot').click() })
  expect(api.addEnvsetSlot).toHaveBeenCalledTimes(1)
  await act(async () => render('two'))
  await act(async () => pending.resolve({ slot: 'old.env' }))
  expect(added).not.toHaveBeenCalled()
  expect(button('current.env')).toBeDefined()
})
