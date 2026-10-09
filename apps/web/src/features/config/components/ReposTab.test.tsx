// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkPathExists, getGitRemote, getRepoGitStatus } from '@/shared/api/workspace'
import { getFeatureConfigDoc, putFeatureConfigDoc, type ParsedConfigDoc } from '@/shared/api/config'
import { ReposTab } from './ReposTab'

vi.mock('@/shared/api/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/workspace')>()),
  checkPathExists: vi.fn(),
  getGitRemote: vi.fn(),
  getRepoGitStatus: vi.fn(),
}))
vi.mock('@/shared/api/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/config')>()),
  getFeatureConfigDoc: vi.fn(),
  putFeatureConfigDoc: vi.fn(),
}))

const folders = vi.hoisted(() => new Map<string, (path: string) => void>())
vi.mock('./FolderPicker', () => ({
  FolderPicker: ({ value, onChange }: { value: string; onChange: (path: string) => void }) => { folders.set(value, onChange); return null },
  FolderPickerModal: () => null,
}))

vi.mock('@/features/runs/state/RunsContext', () => ({
  useRuns: vi.fn(() => ({ runs: [] })),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(checkPathExists).mockReset().mockResolvedValue({ exists: true })
  vi.mocked(getFeatureConfigDoc).mockReset()
  vi.mocked(getGitRemote).mockReset().mockResolvedValue({ cloneUrl: null })
  vi.mocked(getRepoGitStatus).mockReset().mockResolvedValue({
    path: '~/Documents/canary-lab',
    expectedBranch: null,
    isGitRepo: false,
    currentBranch: null,
    detached: false,
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


it.each(['remove', 'discard'])('expires a pending remote lookup when its row is %s', async (action) => {
  const initial = doc()
  const value = initial.parsed.value as { repos: { cloneUrl?: string }[] }
  delete value.repos[0].cloneUrl
  vi.mocked(getFeatureConfigDoc).mockResolvedValue(initial)
  let resolve!: (value: { cloneUrl: string }) => void
  vi.mocked(getGitRemote).mockReturnValue(new Promise((yes) => { resolve = yes }))
  await act(async () => root.render(<ReposTab feature="lifetime-suite" />))
  await act(async () => folders.get('~/Documents/canary-lab')!('/different'))
  const button = action === 'remove' ? container.querySelector<HTMLButtonElement>('[aria-label="Remove repo"]')
    : [...container.querySelectorAll('button')].find((node) => node.textContent === 'Discard')
  act(() => button!.click())
  await act(async () => resolve({ cloneUrl: 'https://example.invalid/obsolete.git' }))
  expect([...container.querySelectorAll('input')].some((input) => input.value.includes('obsolete'))).toBe(false)
  if (action === 'remove') expect(container.textContent).toContain('No services configured.')
  else expect(inputForLabel('Name').value).toBe('canary-lab')
})
