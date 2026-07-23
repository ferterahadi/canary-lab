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
import { InvalidationProvider, useInvalidation } from '../../../shared/state/invalidation'

// Captures the bus dispatch so a test can bump a topic the way the WS handler
// does — the leaf reads its refetch key from context now, not a prop.
let capturedInvalidate: ((topic: 'ports', scope?: string) => void) | null = null
function CaptureInvalidate() {
  capturedInvalidate = useInvalidation().invalidate
  return null
}

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

// PortsTab reads the live workflow index from PortifyContext (active workflow
// + latest saved overlay). Tests set `mockWorkflows` to simulate the WS feed.
let mockWorkflows: { workflowId: string; feature: string; status: string; startedAt: string }[] = []
vi.mock('../../portify/state/PortifyContext', () => ({
  usePortify: () => ({ workflows: mockWorkflows }),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mockWorkflows = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(checkPathExists).mockReset().mockResolvedValue({ exists: true })
  vi.mocked(getFeatureConfigDoc).mockReset()
  vi.mocked(getGitRemote).mockReset().mockResolvedValue({ cloneUrl: null })
  vi.mocked(getRepoGitStatus).mockReset().mockResolvedValue({
    path: '/Users/dev/Documents/my-backend',
    expectedBranch: null,
    isGitRepo: false,
    currentBranch: null,
    detached: false,
    dirty: false,
    dirtyFiles: [],
    localBranches: [],
    remoteBranches: [],
  })
  vi.mocked(removePortifyOverlay)
    .mockReset()
    .mockResolvedValue({ name: 'cns_exactly_once_fallback', portified: false, reverted: true })
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

  it('verified state: portified headline + View/Remove only — no Portify button, no re-run', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docWithPorts())
    const onStartPortify = vi.fn()
    await act(async () => {
      // portified=true (a saved overlay exists) → verified headline. Overlay
      // presence, NOT the declared-slot count. Re-portify is the sanctioned
      // two-step (Remove → Portify), so no start button renders here.
      root.render(<PortsTab feature="cns_exactly_once_fallback" portified onStartPortify={onStartPortify} />)
    })
    expect(container.textContent).toContain('Portified — boots concurrently')
    expect(container.textContent).toContain('double-boot verified')
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.some((b) => b.textContent?.trim() === 'Portify')).toBe(false)
    expect(buttons.some((b) => b.textContent?.includes('Re-run'))).toBe(false)
    expect(buttons.some((b) => b.getAttribute('aria-label') === 'Remove portification')).toBe(true)
  })

  it('none state: Not injectable headline, accent Portify launches directly', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docNoPorts())
    const onStartPortify = vi.fn()
    await act(async () => {
      // No overlay, no slots anywhere → not injectable; Portify is the way in.
      root.render(<PortsTab feature="np_feature" onStartPortify={onStartPortify} />)
    })
    expect(container.textContent).toContain('Not injectable — no port slots declared')
    // The per-command empty state is a single neutral status — no repeated pitch,
    // no per-card CTA (the band carries the one Portify action).
    expect(container.textContent).toContain('No port slots declared')
    await act(async () => clickButton('Portify'))
    expect(onStartPortify).toHaveBeenCalledWith('np_feature')
  })

  it('declared state: all commands slotted without overlay → Injectable headline + demoted optional Portify, no danger actions', async () => {
    // The mpass-oauth-support case: services natively read PORT from env, slots
    // hand-declared in config, no overlay. Concurrency-ready — the band must
    // NOT pitch a clash or offer any destructive action.
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docWithPorts())
    const onStartPortify = vi.fn()
    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" onStartPortify={onStartPortify} />)
    })
    expect(container.textContent).toContain('Injectable — declared in config')
    expect(container.textContent).toContain('not agent-verified')
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.some((b) => b.getAttribute('aria-label') === 'Clear port slots')).toBe(false)
    expect(buttons.some((b) => b.getAttribute('aria-label') === 'Remove portification')).toBe(false)
    const portify = buttons.find((b) => b.textContent?.trim() === 'Portify')!
    expect(portify.getAttribute('title')).toContain('Optional')
    await act(async () => portify.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onStartPortify).toHaveBeenCalledWith('cns_exactly_once_fallback')
  })

  it('partial state: some commands slotted → Partially injectable count + accent Portify', async () => {
    const doc = docWithPorts()
    doc.parsed.value = {
      ...(doc.parsed.value as Record<string, unknown>),
      repos: [
        {
          name: 'my-backend',
          localPath: '~/Documents/my-backend',
          startCommands: [
            { command: 'yarn start', ports: [{ name: 'api', env: 'PORT' }] },
            { command: 'yarn worker' },
          ],
        },
      ],
    }
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(doc)
    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" onStartPortify={vi.fn()} />)
    })
    expect(container.textContent).toContain('Partially injectable — 1 of 2 start commands have slots')
    const portify = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Portify')!
    expect(portify.getAttribute('title')).not.toContain('Optional')
  })

  it('always shows the slot explainer caption', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docNoPorts())
    await act(async () => {
      root.render(<PortsTab feature="np_feature" />)
    })
    expect(container.textContent).toContain('Slots are declared in feature.config.cjs')
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

  it('refetches the config doc when the ports topic is invalidated (re-run Portify rewrote the slots)', async () => {
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
      root.render(
        <InvalidationProvider>
          <CaptureInvalidate />
          <PortsTab feature="cns_exactly_once_fallback" portified />
        </InvalidationProvider>,
      )
    })
    expect(container.textContent).toContain('${port.api}')
    expect(getFeatureConfigDoc).toHaveBeenCalledTimes(1)

    // Same feature, same portified=true — only the ports topic is invalidated, as
    // it would be after an in-place re-run save. The slots must reload without a
    // tab switch.
    await act(async () => { capturedInvalidate?.('ports') })
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

  it('shows the in-progress band for an active workflow on this feature — View progress opens it, start/remove actions hidden', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docWithPorts())
    mockWorkflows = [{ workflowId: 'wf_live', feature: 'cns_exactly_once_fallback', status: 'verifying', startedAt: '2026-01-01T00:00:00Z' }]
    const onStartPortify = vi.fn()
    const onOpenPortify = vi.fn()
    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" onStartPortify={onStartPortify} onOpenPortify={onOpenPortify} />)
    })
    // The active workflow owns the band regardless of how it was started
    // (this dialog, a flight stage, or an agent over MCP — same shared index).
    expect(container.textContent).toContain('Portify in progress')
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.some((b) => b.textContent?.includes('Portify') && !b.textContent.includes('progress'))).toBe(false)
    expect(buttons.some((b) => b.getAttribute('aria-label') === 'Clear port slots')).toBe(false)

    await act(async () => clickButton('View progress'))
    expect(onOpenPortify).toHaveBeenCalledWith('wf_live')
    expect(onStartPortify).not.toHaveBeenCalled()
  })

  it('labels a parked ready-to-save workflow "Review & save"', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docWithPorts())
    mockWorkflows = [{ workflowId: 'wf_parked', feature: 'cns_exactly_once_fallback', status: 'ready-to-save', startedAt: '2026-01-01T00:00:00Z' }]
    const onOpenPortify = vi.fn()
    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" onStartPortify={vi.fn()} onOpenPortify={onOpenPortify} />)
    })
    expect(container.textContent).toContain('ready to save')
    await act(async () => clickButton('Review & save'))
    expect(onOpenPortify).toHaveBeenCalledWith('wf_parked')
  })

  it('disables Portify while another feature portifies (single-flight)', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docNoPorts())
    mockWorkflows = [{ workflowId: 'wf_other', feature: 'other_feature', status: 'editing', startedAt: '2026-01-01T00:00:00Z' }]
    const onStartPortify = vi.fn()
    await act(async () => {
      root.render(<PortsTab feature="np_feature" onStartPortify={onStartPortify} />)
    })
    // Not this feature's workflow → normal band, but the start button is
    // blocked and says why.
    expect(container.textContent).toContain('Not injectable')
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Portify'))!
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(btn.getAttribute('title')).toContain('other_feature')
    await act(async () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onStartPortify).not.toHaveBeenCalled()
  })

  it('offers View saved overlay for a portified feature with a saved record', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docWithPorts())
    mockWorkflows = [{ workflowId: 'wf_saved', feature: 'cns_exactly_once_fallback', status: 'saved', startedAt: '2026-01-01T00:00:00Z' }]
    const onOpenPortify = vi.fn()
    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" portified onStartPortify={vi.fn()} onOpenPortify={onOpenPortify} />)
    })
    await act(async () => clickButton('View saved overlay'))
    expect(onOpenPortify).toHaveBeenCalledWith('wf_saved')
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
