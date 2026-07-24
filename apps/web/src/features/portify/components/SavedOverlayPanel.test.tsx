// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPortifyProject, type PortifyManifest } from '../../../shared/api/client'
import { SavedOverlayPanel } from './SavedOverlayPanel'

// The panel opens the saved overlay folder via the client; stub it.
vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
  return { ...actual, openPortifyProject: vi.fn() }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(openPortifyProject).mockReset().mockResolvedValue({ opened: true, paths: ['/wt'], editor: 'vscode' })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SavedOverlayPanel', () => {
  it('renders the diff, the per-service stored-in path, and the double-boot proof', async () => {
    await act(async () => { root.render(<SavedOverlayPanel manifest={manifest()} />) })
    // The captured diff renders (colourised by DiffView, text preserved).
    expect(container.textContent).toContain('app.listen(process.env.PORT)')
    // Stored-in: features/<feature>/portify/<patchFileName(repo)>.
    expect(container.textContent).toContain('features/cns/portify/app.patch')
    // Machine proof: the two concurrent boots.
    expect(container.textContent).toContain('Booted twice')
    // How-applied copy is per-service.
    expect(container.textContent).toContain('per-run worktree at boot')
  })

  it('opens the overlay folder in the editor', async () => {
    await act(async () => { root.render(<SavedOverlayPanel manifest={manifest()} />) })
    await act(async () => clickButton('Open in editor'))
    await flush()
    expect(openPortifyProject).toHaveBeenCalledWith('wf1')
    expect(container.textContent).not.toContain('Failed to open editor')
  })

  it('surfaces a launch failure inline', async () => {
    vi.mocked(openPortifyProject).mockResolvedValue({ opened: false, paths: ['/repo'], error: 'no editor' })
    await act(async () => { root.render(<SavedOverlayPanel manifest={manifest()} />) })
    await act(async () => clickButton('Open in editor'))
    await flush()
    expect(container.textContent).toContain('no editor')
  })

  it('shows the no-changes-needed state for a proven empty diff', async () => {
    await act(async () => { root.render(<SavedOverlayPanel manifest={manifest({ diff: '' })} />) })
    expect(container.textContent).toContain('No changes needed')
    // The double-boot proof still shows — the empty overlay is a verified no-op.
    expect(container.textContent).toContain('Booted twice')
  })
})

function clickButton(label: string): void {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label))
  if (!btn) throw new Error(`button not found: ${label}`)
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

function manifest(over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'wf1',
    feature: 'cns',
    repos: [{ name: 'app', path: '~/app' }],
    agent: 'claude',
    branch: 'portify/scratch',
    status: 'saved',
    attempt: 1,
    maxAttempts: 3,
    startedAt: '2026-01-01T00:00:00Z',
    diff: '# repo: app\n- app.listen(8080)\n+ app.listen(process.env.PORT)',
    verification: {
      ok: true,
      instances: [
        { ports: { api: 1 }, ok: true },
        { ports: { api: 2 }, ok: true },
      ],
    },
    ...over,
  }
}
