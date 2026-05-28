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
    listWorkspaceDirs: vi.fn(),
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

    const pickerButton = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('/Users/oddle/Documents/wiki/wiki'))
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
})
