// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browseDirectory, type DirectoryBrowseResult } from '../../../shared/api/client'
import { DirectoryBrowser } from './DirectoryBrowser'

vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    browseDirectory: vi.fn(),
  }
})

const HOME: DirectoryBrowseResult = {
  path: '/Users/dev',
  parent: null,
  entries: [
    { name: 'Documents', path: '/Users/dev/Documents' },
    { name: 'Downloads', path: '/Users/dev/Downloads' },
  ],
}
const DOCS: DirectoryBrowseResult = {
  path: '/Users/dev/Documents',
  parent: '/Users/dev',
  entries: [{ name: 'repo', path: '/Users/dev/Documents/repo' }],
}

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
  await act(async () => {
    q(sel)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function render(props: Partial<Parameters<typeof DirectoryBrowser>[0]> = {}) {
  await act(async () => {
    root.render(
      <DirectoryBrowser onPick={props.onPick ?? vi.fn()} onCancel={props.onCancel ?? vi.fn()} initialPath={props.initialPath} />,
    )
  })
}

describe('DirectoryBrowser (R53)', () => {
  it('lists entries from the home root', async () => {
    await render()
    expect(q('[data-testid="dir-browser"]')).not.toBeNull()
    expect(q('[data-testid="dir-browser-entry-Documents"]')).not.toBeNull()
    expect(q('[data-testid="dir-browser-entry-Downloads"]')).not.toBeNull()
    // Up is disabled at the root (parent === null).
    expect((q('[data-testid="dir-browser-up"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('descends into a clicked folder', async () => {
    await render()
    vi.mocked(browseDirectory).mockResolvedValueOnce(DOCS)
    await click('[data-testid="dir-browser-entry-Documents"]')
    expect(browseDirectory).toHaveBeenLastCalledWith('/Users/dev/Documents')
    expect(q('[data-testid="dir-browser-entry-repo"]')).not.toBeNull()
    expect((q('[data-testid="dir-browser-up"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('goes up to the parent', async () => {
    await render()
    vi.mocked(browseDirectory).mockResolvedValueOnce(DOCS)
    await click('[data-testid="dir-browser-entry-Documents"]')
    vi.mocked(browseDirectory).mockResolvedValueOnce(HOME)
    await click('[data-testid="dir-browser-up"]')
    expect(browseDirectory).toHaveBeenLastCalledWith('/Users/dev')
    expect(q('[data-testid="dir-browser-entry-Documents"]')).not.toBeNull()
  })

  it('pick returns the current folder path', async () => {
    const onPick = vi.fn()
    await render({ onPick })
    await click('[data-testid="dir-browser-pick"]')
    expect(onPick).toHaveBeenCalledWith('/Users/dev')
  })

  it('cancel calls onCancel', async () => {
    const onCancel = vi.fn()
    await render({ onCancel })
    await click('[data-testid="dir-browser-cancel"]')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows an error with retry when the listing fails', async () => {
    vi.mocked(browseDirectory).mockReset().mockRejectedValueOnce(new Error('EACCES'))
    await render()
    expect(container.textContent).toContain('EACCES')
    // Retry re-requests and recovers.
    vi.mocked(browseDirectory).mockResolvedValueOnce(HOME)
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry') as HTMLButtonElement
    await act(async () => { retry.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(q('[data-testid="dir-browser-entry-Documents"]')).not.toBeNull()
  })
})
