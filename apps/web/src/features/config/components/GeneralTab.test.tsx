// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getFeatureConfigDoc, putFeatureConfigDoc, type ParsedConfigDoc } from '../../../shared/api/client'
import { GeneralTab } from './GeneralTab'

vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    getFeatureConfigDoc: vi.fn(),
    putFeatureConfigDoc: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
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
})

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
}

function doc(name: string): ParsedConfigDoc {
  return {
    path: `/features/${name}/feature.config.cjs`,
    format: 'cjs',
    content: '',
    parsed: {
      value: {
        name,
        description: 'desc',
        envs: ['local'],
        repos: [],
        featureDir: { $expr: '__dirname' },
      },
      complexFields: [],
      source: '',
    },
  }
}
