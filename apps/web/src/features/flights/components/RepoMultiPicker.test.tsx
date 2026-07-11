// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listWorkspaceDirs, type WorkspaceDirsResponse } from '../../../shared/api/client'
import { RepoMultiPicker } from './RepoMultiPicker'

vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    listWorkspaceDirs: vi.fn(),
  }
})

const dirs = (absolute: string): WorkspaceDirsResponse => ({
  root: '/Users/dev',
  at: absolute,
  absolute,
  parent: '/Users/dev',
  dirs: ['nested'],
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(listWorkspaceDirs).mockReset().mockResolvedValue(dirs('/Users/dev/picked-repo'))
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const q = (sel: string) => container.querySelector<HTMLElement>(sel)
const click = async (sel: string) => {
  await act(async () => { q(sel)!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

async function render(onChange = vi.fn(), selected: string[] = []) {
  await act(async () => {
    root.render(<RepoMultiPicker selected={selected} onChange={onChange} />)
  })
  return onChange
}

describe('RepoMultiPicker (R69 — reuses FolderPickerModal)', () => {
  it('shows selected repos as removable rows, nothing when empty', async () => {
    await render(vi.fn(), [])
    expect(q('[data-testid="repo-multi-picker"]')).not.toBeNull()
    expect(q('[data-testid="repo-row-backend"]')).toBeNull()

    const onChange = await render(vi.fn(), ['/Users/dev/backend'])
    expect(q('[data-testid="repo-row-backend"]')).not.toBeNull()
    await click('[data-testid="repo-multi-picker"] button[aria-label="Remove backend"]')
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('Add repo opens the shared FolderPickerModal; confirming a folder adds it', async () => {
    const onChange = await render()
    expect(q('[data-testid="folder-picker-modal"]')).toBeNull()
    await click('[data-testid="repo-pick-add"]')
    expect(q('[data-testid="folder-picker-modal"]')).not.toBeNull()
    // The modal loaded its listing → confirm is enabled and returns the abs path.
    await click('[data-testid="folder-picker-confirm"]')
    expect(onChange).toHaveBeenCalledWith(['/Users/dev/picked-repo'])
    expect(q('[data-testid="folder-picker-modal"]')).toBeNull()
  })

  it('Cancel closes the modal without adding', async () => {
    const onChange = await render()
    await click('[data-testid="repo-pick-add"]')
    await click('[data-testid="folder-picker-cancel"]')
    expect(q('[data-testid="folder-picker-modal"]')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})
