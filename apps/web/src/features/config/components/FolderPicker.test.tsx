// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listWorkspaceDirs } from '../../../shared/api/client'
import { FolderPickerModal } from './FolderPicker'
import { Modal } from './atoms'

vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    listWorkspaceDirs: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(listWorkspaceDirs).mockReset().mockResolvedValue({
    root: '/Users/dev/Documents/my-backend',
    at: '',
    absolute: '/Users/dev/Documents/my-backend',
    parent: '/Users/dev/Documents',
    dirs: ['apps'],
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

/** The real nesting: the picker opens ON TOP of an already-open dialog
 *  (Settings, the flight launcher). Both sit on the shared escape-layer
 *  stack, so Escape must close only the innermost layer — the picker. */
function Layered({ onParentClose, onPickerCancel }: {
  onParentClose: () => void
  onPickerCancel: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  return (
    <>
      <Modal open onClose={onParentClose} title="Settings" />
      <button data-testid="open-picker" type="button" onClick={() => setPickerOpen(true)}>
        open
      </button>
      {pickerOpen && (
        <FolderPickerModal
          initialPath="/Users/dev/Documents/my-backend"
          title="Select a folder"
          confirmLabel="Use this folder"
          onConfirm={() => {}}
          onCancel={() => {
            onPickerCancel()
            setPickerOpen(false)
          }}
        />
      )}
    </>
  )
}

describe('FolderPickerModal', () => {
  it('Escape closes only the picker, not the dialog beneath it', async () => {
    const onParentClose = vi.fn()
    const onPickerCancel = vi.fn()

    await act(async () => {
      root.render(<Layered onParentClose={onParentClose} onPickerCancel={onPickerCancel} />)
    })
    // Open the picker in a later commit (as a click does live) so its escape
    // layer stacks above the parent dialog's.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-picker"]')?.click()
    })
    expect(document.querySelector('[data-testid="folder-picker-modal"]')).not.toBeNull()

    // First Escape dismisses the picker — the parent dialog stays put.
    await act(async () => { pressEscape() })
    expect(onPickerCancel).toHaveBeenCalledTimes(1)
    expect(onParentClose).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="folder-picker-modal"]')).toBeNull()

    // Second Escape now reaches the parent dialog.
    await act(async () => { pressEscape() })
    expect(onParentClose).toHaveBeenCalledTimes(1)
  })
})
