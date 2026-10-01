// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { SettingsModal } from './SettingsModal'

vi.mock('@/shared/api/client', async (original) => ({ ...(await original<typeof import('@/shared/api/client')>()),
  getProjectConfig: vi.fn(), putProjectConfig: vi.fn(), getGhStatus: vi.fn(), getAgentProbe: vi.fn(),
}))
let root: Root
let element: HTMLDivElement
let invalidate: () => void
const close = vi.fn()
const config: api.ProjectConfig = { healAgent: 'claude', editor: 'auto', personalWikiPath: null, askModelsOnLaunch: false, agentModels: { claude: {}, codex: {} }, port: 7421 }
function Capture() { const bus = useInvalidation(); invalidate = () => bus.invalidate('project-config'); return <SettingsModal onClose={close} /> }
const render = () => act(async () => { root.render(<InvalidationProvider><Capture /></InvalidationProvider>) })
const input = (name: string) => element.querySelector<HTMLInputElement>(`[data-testid="${name}"]`)!
const save = () => [...element.querySelectorAll('button')].find((b) => b.textContent === 'Save')!
const codex = () => element.querySelector<HTMLInputElement>('input[name="healAgent"][value="codex"]')!
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks()
  element = document.createElement('div'); document.body.appendChild(element); root = createRoot(element)
  vi.mocked(api.getProjectConfig).mockResolvedValue(config)
  vi.mocked(api.putProjectConfig).mockImplementation(async (patch) => ({ ...config, ...patch }))
  vi.mocked(api.getGhStatus).mockResolvedValue({ installed: true, authenticated: true })
  vi.mocked(api.getAgentProbe).mockReturnValue(new Promise(() => {}))
})
afterEach(() => { act(() => root.unmount()); element.remove(); vi.useRealTimers() })

it('refreshes untouched settings after invalidation and saves only the edited field', async () => {
  await render()
  vi.mocked(api.getProjectConfig).mockResolvedValue({ ...config, askModelsOnLaunch: true })
  await act(async () => { invalidate() })
  expect(input('settings-ask-models').checked).toBe(true)
  await act(async () => { codex().click() })
  await act(async () => { save().click() })
  expect(api.putProjectConfig).toHaveBeenCalledExactlyOnceWith({ healAgent: 'codex' })
  expect(close).toHaveBeenCalledOnce()
})

it('preserves dirty fields and rebases untouched fields after a missed event', async () => {
  await render()
  const editor = element.querySelector<HTMLInputElement>('input[name="editor"][value="vscode"]')!
  await act(async () => { editor.click() })
  vi.mocked(api.getProjectConfig).mockResolvedValue({ ...config, editor: 'cursor', askModelsOnLaunch: true })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(editor.checked).toBe(true)
  expect(input('settings-ask-models').checked).toBe(true)
  expect(element.textContent).toContain('Changed elsewhere')
  await act(async () => { save().click() })
  expect(api.putProjectConfig).toHaveBeenCalledWith({ editor: 'vscode' })
})

it.each(['failed', 'hung'])('recovers a %s initial read and rejects superseded results', async (mode) => {
  const old = deferred<api.ProjectConfig>()
  if (mode === 'hung') vi.mocked(api.getProjectConfig).mockReturnValueOnce(old.promise)
  else vi.mocked(api.getProjectConfig).mockRejectedValueOnce(new Error('offline'))
  vi.mocked(api.getProjectConfig).mockResolvedValue({ ...config, askModelsOnLaunch: true })
  await render()
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(input('settings-ask-models').checked).toBe(true)
  await act(async () => { old.resolve(config) })
  expect(input('settings-ask-models').checked).toBe(true)
  vi.mocked(api.getProjectConfig).mockRejectedValueOnce(new Error('offline again'))
  await act(async () => { invalidate() })
  expect(input('settings-ask-models').checked).toBe(true)
  expect(element.textContent).toContain('offline again')
})

it('accepts saves over delayed reads, keeps newer edits, and closes only after they are saved', async () => {
  const writing = deferred<api.ProjectConfig>()
  const reading = deferred<api.ProjectConfig>()
  await render()
  await act(async () => { codex().click() })
  vi.mocked(api.putProjectConfig).mockReturnValueOnce(writing.promise)
  await act(async () => { save().click() })
  await act(async () => { input('settings-ask-models').click() })
  vi.mocked(api.getProjectConfig).mockReturnValueOnce(reading.promise)
  await act(async () => { invalidate() })
  await act(async () => { writing.resolve({ ...config, healAgent: 'codex' }) })
  await act(async () => { reading.resolve(config) })
  expect(codex().checked).toBe(true)
  expect(input('settings-ask-models').checked).toBe(true)
  expect(close).not.toHaveBeenCalled()
  await act(async () => { save().click() })
  expect(api.putProjectConfig).toHaveBeenLastCalledWith({ askModelsOnLaunch: true })
  expect(close).toHaveBeenCalledOnce()
})

it('retains failed drafts and rejects late saves and reader work after teardown', async () => {
  await render()
  await act(async () => { codex().click() })
  vi.mocked(api.putProjectConfig).mockRejectedValueOnce(new Error('read only'))
  await act(async () => { save().click() })
  expect(codex().checked).toBe(true)
  expect(element.textContent).toContain('read only')
  const writing = deferred<api.ProjectConfig>()
  vi.mocked(api.putProjectConfig).mockReturnValueOnce(writing.promise)
  await act(async () => { save().click() })
  await act(async () => { root.render(null) })
  const calls = vi.mocked(api.getProjectConfig).mock.calls.length
  await act(async () => { writing.resolve(config); await vi.advanceTimersByTimeAsync(10000) })
  expect(close).not.toHaveBeenCalled()
  expect(api.getProjectConfig).toHaveBeenCalledTimes(calls)
})

it('publishes model-matrix responses without overwriting unrelated Settings drafts', async () => {
  await render()
  await act(async () => { codex().click(); element.querySelector<HTMLButtonElement>('[data-testid="configure-models-claude"]')!.click() })
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Auto-repair model"]')!
  await act(async () => { select.value = 'sonnet'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="model-matrix-save"]')!.click() })
  expect(element.textContent).toContain('Auto-repair sonnet')
  expect(codex().checked).toBe(true)
  expect(close).not.toHaveBeenCalled()
  await act(async () => { save().click() })
  expect(api.putProjectConfig).toHaveBeenLastCalledWith({ healAgent: 'codex' })
})
