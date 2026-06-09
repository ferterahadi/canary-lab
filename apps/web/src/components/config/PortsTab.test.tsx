// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkPathExists,
  getFeatureConfigDoc,
  getGitRemote,
  getRepoGitStatus,
  putFeatureConfigDoc,
  type ParsedConfigDoc,
} from '../../api/client'
import { PortsTab } from './PortsTab'

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client')
  return {
    ...actual,
    checkPathExists: vi.fn(),
    getFeatureConfigDoc: vi.fn(),
    getGitRemote: vi.fn(),
    getRepoGitStatus: vi.fn(),
    putFeatureConfigDoc: vi.fn(),
  }
})

// PortsTab imports parsers/components from ReposTab, which imports RunsContext.
vi.mock('../../state/RunsContext', () => ({
  useRuns: vi.fn(() => ({ runs: [] })),
}))

// PortsTab embeds the Portify history list, which reads PortifyContext.
vi.mock('../../state/PortifyContext', () => ({
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
  vi.mocked(putFeatureConfigDoc).mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PortsTab', () => {
  it('groups slots by service → command, shows the injection token, and round-trips an edit', async () => {
    const withPorts = docWithPorts()
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(withPorts)
    vi.mocked(putFeatureConfigDoc).mockResolvedValue(withPorts)

    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" />)
    })

    // Service name + the command the slots attach to are both shown.
    expect(container.textContent).toContain('mighty-cns')
    expect(container.textContent).toContain('yarn start')
    // The read-only injection token is rendered for the slot.
    expect(container.textContent).toContain('${port.api}')

    // Rename the slot and save — it must round-trip through parse → serialize.
    const slotName = slotNameInput()
    expect(slotName.value).toBe('api')
    await act(async () => {
      setInputValue(slotName, 'web')
      slotName.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => clickButton('Save'))

    expect(putFeatureConfigDoc).toHaveBeenCalledWith(
      'cns_exactly_once_fallback',
      expect.objectContaining({
        repos: [
          expect.objectContaining({
            startCommands: [
              expect.objectContaining({
                command: 'yarn start',
                ports: [{ name: 'web', env: 'PORT' }],
              }),
            ],
          }),
        ],
      }),
    )
  })

  it('shows PORTIFIED ✓ and confirms a re-run before firing onStartPortify', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docWithPorts())
    const onStartPortify = vi.fn()
    await act(async () => {
      root.render(<PortsTab feature="cns_exactly_once_fallback" onStartPortify={onStartPortify} />)
    })
    // Slots declared → portified badge + a re-run-style action that confirms first.
    expect(container.textContent).toContain('PORTIFIED ✓')
    await act(async () => clickButton('Re-run Portify'))
    expect(onStartPortify).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Re-run Portify?')

    // Confirm (the dialog's button) → launches.
    const dlg = container.querySelector('[role="dialog"]')!
    const confirmBtn = [...dlg.querySelectorAll('button')].find((b) => b.textContent?.includes('Re-run Portify'))!
    await act(async () => confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onStartPortify).toHaveBeenCalledWith('cns_exactly_once_fallback')
  })

  it('shows NOT PORTIFIED and launches directly (no confirm) when no port slots are declared', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(docNoPorts())
    const onStartPortify = vi.fn()
    await act(async () => {
      root.render(<PortsTab feature="np_feature" onStartPortify={onStartPortify} />)
    })
    expect(container.textContent).toContain('NOT PORTIFIED')
    await act(async () => clickButton('Portify'))
    expect(onStartPortify).toHaveBeenCalledWith('np_feature')
    expect(container.textContent).not.toContain('Re-run Portify?')
  })

  it('shows an empty state when there are no services', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(emptyDoc())
    await act(async () => {
      root.render(<PortsTab feature="empty_feature" />)
    })
    expect(container.textContent).toContain('No services configured')
  })
})

function slotNameInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="api"]')
  if (!input) throw new Error('Missing slot name input')
  return input
}

function clickButton(label: string): void {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label))
  if (!btn) throw new Error(`button not found: ${label}`)
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
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
            name: 'mighty-cns',
            localPath: '~/Documents/mighty-cns',
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
