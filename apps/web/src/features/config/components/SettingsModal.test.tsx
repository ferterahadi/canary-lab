// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../../shared/api/client'
import { SettingsModal } from './SettingsModal'

vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    getProjectConfig: vi.fn(),
    putProjectConfig: vi.fn(),
    changeProjectPort: vi.fn(),
    listWorkspaceDirs: vi.fn(),
  }
})

function setInputValue(input: HTMLInputElement, value: string): void {
  // React tracks the controlled value via a property descriptor, so a plain
  // `input.value = …` won't fire onChange. Use the prototype setter.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.getProjectConfig).mockReset()
  vi.mocked(api.putProjectConfig).mockReset()
  vi.mocked(api.changeProjectPort).mockReset()
  vi.mocked(api.listWorkspaceDirs).mockReset().mockResolvedValue({
    absolute: '/tmp/wiki',
    parent: '/tmp',
    dirs: [],
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('SettingsModal', () => {
  it('renders the current wiki path and saves a new one picked via the folder picker', async () => {
    const onClose = vi.fn()
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'auto',
      editor: 'auto',
      personalWikiPath: '/Users/dev/Documents/wiki/wiki',
    })
    vi.mocked(api.putProjectConfig).mockResolvedValue({
      healAgent: 'auto',
      editor: 'auto',
      personalWikiPath: '/tmp/wiki',
    })

    await act(async () => {
      root.render(<SettingsModal onClose={onClose} />)
    })
    await act(async () => {})

    const pickerButton = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('/Users/dev/Documents/wiki/wiki'))
    expect(pickerButton).toBeTruthy()

    await act(async () => {
      pickerButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    const confirm = [...document.querySelectorAll('button')]
      .find((b) => b.textContent === 'Use wiki folder')
    expect(confirm).toBeTruthy()
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')
    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(api.putProjectConfig).toHaveBeenCalledWith({
      healAgent: 'external',
      editor: 'auto',
      personalWikiPath: '/tmp/wiki',
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the current port and redirects to the new origin after a change', async () => {
    const onClose = vi.fn()
    const onRedirect = vi.fn()
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'external', editor: 'auto', personalWikiPath: null, port: 8000,
    })
    vi.mocked(api.changeProjectPort).mockResolvedValue({
      restarting: true, port: 9000, newOrigin: 'http://localhost:9000',
    })

    await act(async () => { root.render(<SettingsModal onClose={onClose} onRedirect={onRedirect} />) })
    await act(async () => {})

    const input = container.querySelector('input[name="port"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.value).toBe('8000')

    await act(async () => { setInputValue(input, '9000') })
    const change = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Change port')
    await act(async () => { change!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})

    expect(api.changeProjectPort).toHaveBeenCalledWith(9000, false)
    expect(onRedirect).toHaveBeenCalledWith('http://localhost:9000', expect.any(Function))
  })

  it('defaults the port field to 7421 when none is configured', async () => {
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'external', editor: 'auto', personalWikiPath: null,
    })
    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} />) })
    await act(async () => {})
    const input = container.querySelector('input[name="port"]') as HTMLInputElement
    expect(input.value).toBe('7421')
  })

  it('requires confirmation when runs are active, then retries with confirm', async () => {
    const onRedirect = vi.fn()
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'external', editor: 'auto', personalWikiPath: null, port: 8000,
    })
    vi.mocked(api.changeProjectPort)
      .mockResolvedValueOnce({ needsConfirm: true, activeRuns: 2, restarting: false })
      .mockResolvedValueOnce({ restarting: true, port: 9000, newOrigin: 'http://localhost:9000' })

    await act(async () => { root.render(<SettingsModal onClose={vi.fn()} onRedirect={onRedirect} />) })
    await act(async () => {})

    const input = container.querySelector('input[name="port"]') as HTMLInputElement
    await act(async () => { setInputValue(input, '9000') })
    const change = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Change port')
    await act(async () => { change!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})

    expect(container.textContent).toContain('2')
    const confirm = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Restart anyway')
    expect(confirm).toBeTruthy()
    await act(async () => { confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})

    expect(api.changeProjectPort).toHaveBeenNthCalledWith(1, 9000, false)
    expect(api.changeProjectPort).toHaveBeenNthCalledWith(2, 9000, true)
    expect(onRedirect).toHaveBeenCalledWith('http://localhost:9000', expect.any(Function))
  })
})
