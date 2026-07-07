// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browseDirectory, type DirectoryBrowseResult } from '../../../shared/api/client'
import { RepoMultiPicker, type RepoOption } from './RepoMultiPicker'

vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    browseDirectory: vi.fn(),
  }
})

const HOME: DirectoryBrowseResult = {
  path: '/Users/dev/Documents/picked-repo',
  parent: '/Users/dev/Documents',
  entries: [{ name: 'nested', path: '/Users/dev/Documents/picked-repo/nested' }],
}

const KNOWN: RepoOption[] = [{ label: 'backend', path: '/Users/dev/backend' }]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(browseDirectory).mockReset().mockResolvedValue(HOME)
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
    root.render(<RepoMultiPicker known={KNOWN} selected={selected} onChange={onChange} />)
  })
  return onChange
}

describe('RepoMultiPicker (R53 polish)', () => {
  it('keeps existing testids + toggle behavior', async () => {
    const onChange = await render()
    expect(q('[data-testid="repo-multi-picker"]')).not.toBeNull()
    expect(q('[data-testid="repo-pick-backend"]')).not.toBeNull()
    expect(q('[data-testid="repo-pick-add-input"]')).not.toBeNull()
    expect(q('[data-testid="repo-pick-add"]')).not.toBeNull()
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="repo-pick-backend"] input')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(['/Users/dev/backend'])
  })

  it('Browse… toggles an inline DirectoryBrowser', async () => {
    await render()
    expect(q('[data-testid="repo-pick-browse"]')).not.toBeNull()
    expect(q('[data-testid="dir-browser"]')).toBeNull()
    await click('[data-testid="repo-pick-browse"]')
    expect(q('[data-testid="dir-browser"]')).not.toBeNull()
    // Cancel collapses it.
    await click('[data-testid="dir-browser-cancel"]')
    expect(q('[data-testid="dir-browser"]')).toBeNull()
  })

  it('picking a folder adds it as a checked extra repo and collapses the browser', async () => {
    const onChange = await render()
    await click('[data-testid="repo-pick-browse"]')
    await click('[data-testid="dir-browser-pick"]')
    expect(onChange).toHaveBeenCalledWith(['/Users/dev/Documents/picked-repo'])
    expect(q('[data-testid="dir-browser"]')).toBeNull()
  })
})
