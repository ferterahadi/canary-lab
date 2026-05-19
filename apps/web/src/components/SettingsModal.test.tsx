// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import { SettingsModal } from './SettingsModal'

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getProjectConfig: vi.fn(),
    putProjectConfig: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.getProjectConfig).mockReset()
  vi.mocked(api.putProjectConfig).mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('SettingsModal', () => {
  it('renders and saves the personal wiki path', async () => {
    const onClose = vi.fn()
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'auto',
      editor: 'auto',
      personalWikiPath: '/Users/oddle/Documents/wiki/wiki',
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

    const input = container.querySelector('input[type="text"]') as HTMLInputElement | null
    expect(input?.value).toBe('/Users/oddle/Documents/wiki/wiki')

    await act(async () => {
      setInputValue(input!, '/tmp/wiki')
    })

    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')
    expect(save).toBeTruthy()

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

  it('clears the personal wiki path when the input is emptied', async () => {
    vi.mocked(api.getProjectConfig).mockResolvedValue({
      healAgent: 'auto',
      editor: 'auto',
      personalWikiPath: '/tmp/wiki',
    })
    vi.mocked(api.putProjectConfig).mockResolvedValue({
      healAgent: 'auto',
      editor: 'auto',
      personalWikiPath: null,
    })

    await act(async () => {
      root.render(<SettingsModal onClose={() => {}} />)
    })
    await act(async () => {})

    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => {
      setInputValue(input, '')
    })

    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')
    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(api.putProjectConfig).toHaveBeenCalledWith({
      healAgent: 'external',
      editor: 'auto',
      personalWikiPath: null,
    })
  })
})

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
