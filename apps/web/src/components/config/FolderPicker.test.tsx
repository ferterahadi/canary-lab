// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listWorkspaceDirs } from '../../api/client'
import { FolderPickerModal } from './FolderPicker'

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client')
  return {
    ...actual,
    listWorkspaceDirs: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(listWorkspaceDirs).mockReset().mockResolvedValue({
    absolute: '/Users/oddle/Documents/mighty-cns',
    parent: '/Users/oddle/Documents',
    dirs: ['apps'],
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('FolderPickerModal', () => {
  it('handles Escape without bubbling to parent window Escape handlers', async () => {
    const parentEscape = vi.fn()
    const onCancel = vi.fn()
    window.addEventListener('keydown', parentEscape)

    try {
      await act(async () => {
        root.render(
          <FolderPickerModal
            initialPath="/Users/oddle/Documents/mighty-cns"
            title="Select a folder"
            confirmLabel="Use this folder"
            onConfirm={() => {}}
            onCancel={onCancel}
          />,
        )
      })

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }))
      })

      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(parentEscape).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', parentEscape)
    }
  })
})
