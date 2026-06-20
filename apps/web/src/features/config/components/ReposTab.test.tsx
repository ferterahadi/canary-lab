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
} from '../../../api/client'
import { ReposTab } from './ReposTab'

vi.mock('../../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../api/client')>('../../../api/client')
  return {
    ...actual,
    checkPathExists: vi.fn(),
    getFeatureConfigDoc: vi.fn(),
    getGitRemote: vi.fn(),
    getRepoGitStatus: vi.fn(),
    putFeatureConfigDoc: vi.fn(),
  }
})

vi.mock('../../runs/state/RunsContext', () => ({
  useRuns: vi.fn(() => ({ runs: [] })),
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
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('ReposTab', () => {
  it('saves edited service names into repos[].name', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(doc())
    vi.mocked(putFeatureConfigDoc).mockResolvedValue(doc('customer-notifications'))

    await act(async () => {
      root.render(<ReposTab feature="exactly_once_fallback" />)
    })

    const nameInput = inputForLabel('Name')
    expect(nameInput.value).toBe('canary-lab')
    expect(container.textContent).not.toContain('repos[].name')

    await act(async () => {
      setInputValue(nameInput, 'customer-notifications')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(container.textContent).toContain('customer-notifications')

    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')
    expect(save).toBeTruthy()

    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(putFeatureConfigDoc).toHaveBeenCalledWith(
      'exactly_once_fallback',
      expect.objectContaining({
        repos: [
          expect.objectContaining({
            name: 'customer-notifications',
            localPath: '~/Documents/canary-lab',
          }),
        ],
      }),
    )
  })

  it('preserves a startCommand port slot through a Service-tab save (ports edited in the Ports tab)', async () => {
    const withPorts = docWithPorts()
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(withPorts)
    vi.mocked(putFeatureConfigDoc).mockResolvedValue(withPorts)

    await act(async () => {
      root.render(<ReposTab feature="exactly_once_fallback" />)
    })

    // Ports are no longer edited here — the Service tab does not render the
    // port-slot editor or its injection token.
    expect(container.textContent).not.toContain('${port.api}')

    // Edit the repo name to mark the slice dirty, then save — the existing
    // port slot must round-trip untouched through parse → serialize.
    const nameInput = inputForLabel('Name')
    await act(async () => {
      setInputValue(nameInput, 'renamed')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')
    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(putFeatureConfigDoc).toHaveBeenCalledWith(
      'exactly_once_fallback',
      expect.objectContaining({
        repos: [
          expect.objectContaining({
            startCommands: [
              expect.objectContaining({
                command: 'yarn start',
                ports: [{ name: 'api', env: 'PORT' }],
              }),
            ],
          }),
        ],
      }),
    )
  })
})

function docWithPorts(): ParsedConfigDoc {
  return {
    path: '/features/exactly_once_fallback/feature.config.cjs',
    format: 'cjs',
    content: '',
    parsed: {
      value: {
        name: 'exactly_once_fallback',
        description: 'desc',
        envs: ['local'],
        repos: [
          {
            name: 'canary-lab',
            localPath: '~/Documents/canary-lab',
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

function inputForLabel(label: string): HTMLInputElement {
  const field = [...container.querySelectorAll('label')]
    .find((el) => el.textContent?.trim().startsWith(label))
  const input = field?.querySelector('input')
  if (!input) throw new Error(`Missing input for ${label}`)
  return input
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
}

function doc(repoName = 'canary-lab'): ParsedConfigDoc {
  return {
    path: '/features/exactly_once_fallback/feature.config.cjs',
    format: 'cjs',
    content: '',
    parsed: {
      value: {
        name: 'exactly_once_fallback',
        description: 'desc',
        envs: ['local'],
        repos: [
          {
            name: repoName,
            localPath: '~/Documents/canary-lab',
            branch: 'release/2.8.2',
            cloneUrl: 'git@github.com:ferterahadi/canary-lab.git',
          },
        ],
        featureDir: { $expr: '__dirname' },
      },
      complexFields: [],
      source: '',
    },
  }
}
