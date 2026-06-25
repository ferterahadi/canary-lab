// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkPathExists,
  getFeatureConfigDoc,
  getGitRemote,
  getRepoGitStatus,
  removePortifyOverlay,
  type ParsedConfigDoc,
} from '../../../shared/api/client'
import { PortsTab } from './PortsTab'

vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    checkPathExists: vi.fn(),
    getFeatureConfigDoc: vi.fn(),
    getGitRemote: vi.fn(),
    getRepoGitStatus: vi.fn(),
    removePortifyOverlay: vi.fn(),
  }
})

// PortsTab imports parsers/components from ReposTab, which imports RunsContext.
vi.mock('../../runs/state/RunsContext', () => ({
  useRuns: vi.fn(() => ({ runs: [] })),
}))

// PortsTab embeds the Portify history list, which reads PortifyContext.
vi.mock('../../portify/state/PortifyContext', () => ({
  usePortify: () => ({ workflows: [] }),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(checkPathExists).mockReset().mockResolvedValue({ exists: true })
  vi.mocked(getFeatureConfigDoc).mockReset()
  vi.mocked(getGitRemote).mockReset().mockResolvedValue({})
  vi.mocked(getRepoGitStatus).mockReset().mockResolvedValue({
    isGitRepo: false,
    currentBranch: null,
    dirty: false,
    dirtyFiles: [],
    localBranches: [],
    remoteBranches: [],
  })
  vi.mocked(removePortifyOverlay).mockReset().mockResolvedValue({ name: 'cns_exactly_once_fallback', portified: false })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PortsTab', () => {
  it('groups slots by service → command, shows the injection token, and round-trips an edit', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docWithPorts())

    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" />)
    })

    // Service name + the command the slots attach to are both shown.
    expect(container.textContent).toContain('my-backend')
    expect(container.textContent).toContain('yarn start')
    // The slot facts render read-only: name, env var, and the injection token.
    expect(container.textContent).toContain('api')
    expect(container.textContent).toContain('PORT')
    expect(container.textContent).toContain('${port.api}')

    // Display-only — no editing affordances anywhere, even when not portified.
    expect(container.querySelector('input[placeholder="api"]')).toBeNull()
    expect(container.querySelector('input[placeholder="PORT"]')).toBeNull()
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.some((b) => b.textContent?.includes('Add port slot'))).toBe(false)
    expect(buttons.some((b) => b.getAttribute('aria-label')?.startsWith('Remove port slot'))).toBe(false)
    // No Save bar — the tab never writes config.
    expect(buttons.some((b) => b.textContent?.trim() === 'Save')).toBe(false)
  })

  it('shows the portified headline (driven by overlay presence) and confirms a re-run before firing onStartPortify', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docWithPorts())
    const onStartPortify = vi.fn()
    await act(async () => {
      // portified=true (a saved overlay exists) → portified headline + a
      // re-run-style action that confirms first. This is overlay presence, NOT
      // the declared-slot count.
      root.render(<PortsTab feature="cns_exactly_once_fallback" portified onStartPortify={onStartPortify} />)
    })
    expect(container.textContent).toContain('Portified — boots concurrently')
    await act(async () => clickButton('Re-run Portify'))
    expect(onStartPortify).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Re-run Portify?')

    // Confirm (the dialog's button) → launches.
    const dlg = container.querySelector('[role="dialog"]')!
    const confirmBtn = [...dlg.querySelectorAll('button')].find((b) => b.textContent?.includes('Re-run Portify'))!
    await act(async () => confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onStartPortify).toHaveBeenCalledWith('cns_exactly_once_fallback')
  })

  it('shows Not portified and launches directly (no confirm) when no overlay exists', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docNoPorts())
    const onStartPortify = vi.fn()
    await act(async () => {
      // portified defaults to false (no saved overlay) → Not portified.
      root.render(<PortsTab feature="np_feature" onStartPortify={onStartPortify} />)
    })
    expect(container.textContent).toContain('Not portified')
    // The per-command empty state is a single neutral status — no repeated pitch,
    // no per-card CTA (the band carries the one Portify action).
    expect(container.textContent).toContain('No port slots declared')
    await act(async () => clickButton('Portify'))
    expect(onStartPortify).toHaveBeenCalledWith('np_feature')
    expect(container.textContent).not.toContain('Re-run Portify?')
  })

  it('copies the reference token to the clipboard on click', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docWithPorts())
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" />)
    })
    await act(async () => clickButton('${port.api}'))
    expect(writeText).toHaveBeenCalledWith('${port.api}')
    expect(container.textContent).toContain('copied ✓')
  })

  it('refetches the config doc when portsRefreshKey changes (re-run Portify rewrote the slots)', async () => {
    // Before re-run: one slot named "api". After re-run the overlay rewrote the
    // slots, but `portified` stays true, so only the bumped key signals the change.
    const before = docWithPorts()
    const after = docWithPorts()
    after.parsed.value = {
      ...(after.parsed.value as Record<string, unknown>),
      repos: [
        {
          name: 'my-backend',
          localPath: '~/Documents/my-backend',
          startCommands: [{ command: 'yarn start', ports: [{ name: 'gateway', env: 'GATEWAY_PORT' }] }],
        },
      ],
    }
    vi.mocked(getFeatureConfigDoc).mockResolvedValueOnce(before).mockResolvedValueOnce(after)

    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" portified portsRefreshKey={0} />)
    })
    expect(container.textContent).toContain('${port.api}')
    expect(getFeatureConfigDoc).toHaveBeenCalledTimes(1)

    // Same feature, same portified=true — only the key changes, as it would after
    // an in-place re-run save. The slots must reload without a tab switch.
    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" portified portsRefreshKey={1} />)
    })
    expect(getFeatureConfigDoc).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('${port.gateway}')
    expect(container.textContent).not.toContain('${port.api}')
  })

  it('strips all edit chrome when portified — no "(optional)" label, no "=" twin', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docWithPorts())
    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" portified onStartPortify={vi.fn()} />)
    })
    expect(container.textContent).toContain('${port.api}')
    // Edit-mode chrome is gone: no "(optional)" label, no "=" twin glyph.
    expect(container.textContent).not.toContain('(optional)')
    expect(container.textContent).not.toContain('=')
  })

  it('un-portifies behind a confirm → calls removePortifyOverlay and refetches the reverted config', async () => {
    // First load shows the portified slots; after removal the config is reverted,
    // so the in-place refetch returns the pre-Portify (no-ports) doc.
    vi.mocked(getFeatureConfigDoc).mockResolvedValueOnce(docWithPorts()).mockResolvedValue(docNoPorts())
    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" portified onStartPortify={vi.fn()} />)
    })
    expect(getFeatureConfigDoc).toHaveBeenCalledTimes(1)

    // Intro-band action opens the confirm; the call does not fire yet.
    await act(async () => clickButton('Remove portification'))
    expect(removePortifyOverlay).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Remove portification?')

    // Confirm inside the modal → fires the delete, then refetches the reverted
    // config in place (reloadKey bump). The status-band flip is driven by the
    // server's features-changed broadcast, not local state.
    const modal = container.querySelector('.cl-modal')!
    const confirmBtn = [...modal.querySelectorAll('button')].find((b) => b.textContent?.includes('Remove portification'))!
    await act(async () => confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(removePortifyOverlay).toHaveBeenCalledWith('cns_exactly_once_fallback')
    expect(getFeatureConfigDoc).toHaveBeenCalledTimes(2)
  })

  it('offers "Clear port slots" for a not-portified feature with orphaned slots', async () => {
    // Not portified, but the config still declares a slot → orphaned leftover.
    // The danger action reads "Clear port slots" (not "Remove portification")
    // and routes through the same un-portify endpoint.
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docWithPorts())
    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" onStartPortify={vi.fn()} />)
    })
    const clear = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Clear port slots')
    expect(clear).toBeTruthy()
    expect([...container.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Remove portification')).toBe(false)

    await act(async () => clear!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Clear port slots?')
    const modal = container.querySelector('.cl-modal')!
    const confirmBtn = [...modal.querySelectorAll('button')].find((b) => b.textContent?.includes('Clear port slots'))!
    await act(async () => confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(removePortifyOverlay).toHaveBeenCalledWith('cns_exactly_once_fallback')
  })

  it('shows an empty state when there are no services', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(emptyDoc())
    await act(async () => {
      root.render(<PortsTab feature="empty_feature" />)
    })
    expect(container.textContent).toContain('No services configured')
  })
})

function clickButton(label: string): void {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label))
  if (!btn) throw new Error(`button not found: ${label}`)
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function docWithPorts(): ParsedConfigDoc {
  return {
    path: '/features/cns_exactly_once_fallback/feature.config.cjs',
    format: 'cjs',
    content: '',
    parsed: {
      value: {
        name: 'cns_exactly_once_fallback',
        description: 'desc',
        envs: ['local'],
        repos: [
          {
            name: 'my-backend',
            localPath: '~/Documents/my-backend',
            startCommands: [
              { command: 'yarn start', ports: [{ name: 'api', env: 'PORT' }] },
            ],
          },
        ],
        featureDir: { $expr: '__dirname' },
      },
      complexFields: [],
      source: '',
    },
  }
}

function docNoPorts(): ParsedConfigDoc {
  return {
    path: '/features/np_feature/feature.config.cjs',
    format: 'cjs',
    content: '',
    parsed: {
      value: {
        name: 'np_feature',
        description: 'desc',
        envs: ['local'],
        repos: [
          { name: 'svc', localPath: '~/svc', startCommands: [{ command: 'yarn start' }] },
        ],
        featureDir: { $expr: '__dirname' },
      },
      complexFields: [],
      source: '',
    },
  }
}

function emptyDoc(): ParsedConfigDoc {
  return {
    path: '/features/empty_feature/feature.config.cjs',
    format: 'cjs',
    content: '',
    parsed: {
      value: { name: 'empty_feature', description: 'desc', envs: ['local'], repos: [], featureDir: { $expr: '__dirname' } },
      complexFields: [],
      source: '',
    },
  }
}
