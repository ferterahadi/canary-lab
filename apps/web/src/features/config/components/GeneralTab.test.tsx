// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getFeatureConfigDoc, putFeatureConfigDoc, type ParsedConfigDoc } from '@/shared/api/client'
import { GeneralTab } from './GeneralTab'

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    getFeatureConfigDoc: vi.fn(),
    putFeatureConfigDoc: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(getFeatureConfigDoc).mockReset()
  vi.mocked(putFeatureConfigDoc).mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('GeneralTab', () => {
  it('notifies the parent when saving changes the feature name', async () => {
    const onFeatureRenamed = vi.fn()
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(doc('old_feature'))
    vi.mocked(putFeatureConfigDoc).mockResolvedValue(doc('new_feature'))

    await act(async () => {
      root.render(<GeneralTab feature="old_feature" onFeatureRenamed={onFeatureRenamed} />)
    })

    const input = container.querySelector('input')
    expect(input).toBeTruthy()

    await act(async () => {
      setInputValue(input!, 'new_feature')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')
    expect(save).toBeTruthy()

    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(putFeatureConfigDoc).toHaveBeenCalledWith('old_feature', expect.objectContaining({ name: 'new_feature' }))
    expect(onFeatureRenamed).toHaveBeenCalledWith('new_feature')
  })

  it('round-trips the group field, and drops the key when cleared', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(doc('feat', { group: 'checkout' }))
    vi.mocked(putFeatureConfigDoc).mockResolvedValue(doc('feat', { group: 'billing' }))

    await act(async () => {
      root.render(<GeneralTab feature="feat" />)
    })

    // Inputs in DOM order: Name (0), Group (1) — Description is a <textarea>.
    const groupInput = container.querySelectorAll('input')[1] as HTMLInputElement
    expect(groupInput.value).toBe('checkout')

    await act(async () => {
      setInputValue(groupInput, 'billing')
      groupInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickSave()
    expect(putFeatureConfigDoc).toHaveBeenCalledWith('feat', expect.objectContaining({ group: 'billing' }))

    // Clearing the field removes the key rather than persisting an empty string.
    vi.mocked(putFeatureConfigDoc).mockClear()
    await act(async () => {
      setInputValue(groupInput, '')
      groupInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickSave()
    const savedValue = vi.mocked(putFeatureConfigDoc).mock.calls[0][1] as Record<string, unknown>
    expect('group' in savedValue).toBe(false)
  })

  it('offers the same two run shapes as the flight digest, and persists an explicit 0 for the run-everything one', async () => {
    vi.mocked(getFeatureConfigDoc).mockResolvedValue(doc('feat'))
    vi.mocked(putFeatureConfigDoc).mockResolvedValue(doc('feat'))

    await act(async () => {
      root.render(<GeneralTab feature="feat" />)
    })

    // An absent threshold reads as on at the default — not as "off" — and both
    // shapes are named, so the cost of the other one isn't hidden behind a
    // switch the user has to flip to discover.
    const stop = container.querySelector('[data-testid="general-heal-mode-stop"]')
    const full = container.querySelector('[data-testid="general-heal-mode-full"]')
    expect(stop?.getAttribute('aria-checked')).toBe('true')
    expect(full?.getAttribute('aria-checked')).toBe('false')
    expect(container.querySelector<HTMLInputElement>('[data-testid="general-heal-threshold"]')?.value).toBe('2')

    await act(async () => {
      full!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await clickSave()
    expect(putFeatureConfigDoc).toHaveBeenCalledWith('feat', expect.objectContaining({ healOnFailureThreshold: 0 }))
  })

  async function clickSave(): Promise<void> {
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')
    expect(save).toBeTruthy()
    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
})

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
}

function doc(name: string, extra: { group?: string } = {}): ParsedConfigDoc {
  return {
    path: `/features/${name}/feature.config.cjs`,
    format: 'cjs',
    content: '',
    parsed: {
      value: {
        name,
        description: 'desc',
        ...(extra.group !== undefined ? { group: extra.group } : {}),
        envs: ['local'],
        repos: [],
        featureDir: { $expr: '__dirname' },
      },
      complexFields: [],
      source: '',
    },
  }
}
