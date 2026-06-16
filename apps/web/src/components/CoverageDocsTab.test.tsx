// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import type { FeatureDocsListing } from '../api/types'
import { CoverageDocsTab } from './CoverageDocsTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return { ...actual, listFeatureDocs: vi.fn(), regeneratePrdSummary: vi.fn(), writeFeatureDoc: vi.fn() }
})

const LISTING: FeatureDocsListing = {
  feature: 'checkout',
  docs: [
    { relPath: 'spec.md', generated: false, sizeBytes: 100 },
    { relPath: '_prd-summary.md', generated: true, sizeBytes: 200 },
  ],
  hasPrdSummary: true,
  prdSummaryGeneratedAt: '2026-06-16T00:00:00Z',
  sourceDocCount: 1,
  docsDrift: true,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.listFeatureDocs).mockResolvedValue(structuredClone(LISTING))
  vi.mocked(api.regeneratePrdSummary).mockResolvedValue({ feature: 'checkout', summary: { requirements: [], docsHash: 'h', sourceDocs: [], generatedAt: 'n' }, written: [] })
  vi.mocked(api.writeFeatureDoc).mockResolvedValue({ written: true, relativePath: 'docs/notes.md' })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
})

async function mount(onRegenerated = () => {}): Promise<void> {
  await act(async () => { root.render(<CoverageDocsTab feature="checkout" onRegenerated={onRegenerated} />) })
  await act(async () => { await Promise.resolve() })
}

describe('CoverageDocsTab', () => {
  it('renders source + generated doc pills and the drift indicator', async () => {
    await mount()
    expect(container.querySelector('[data-testid="doc-pill-spec.md"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="doc-pill-_prd-summary.md"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="docs-tab-drift"]')).toBeTruthy()
  })

  it('regenerate calls the API and notifies the parent', async () => {
    const onRegenerated = vi.fn()
    await mount(onRegenerated)
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="regenerate-prd"]')?.click() })
    await act(async () => { await Promise.resolve() })
    expect(api.regeneratePrdSummary).toHaveBeenCalledWith('checkout')
    expect(onRegenerated).toHaveBeenCalled()
  })

  it('adds a doc through the form', async () => {
    await mount()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="add-doc-toggle"]')?.click() })
    const relInput = container.querySelector<HTMLInputElement>('[data-testid="add-doc-relpath"]')!
    const contentInput = container.querySelector<HTMLTextAreaElement>('[data-testid="add-doc-content"]')!
    const setValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
      act(() => { el.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    setValue(relInput, 'notes.md')
    setValue(contentInput, '# Notes')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="add-doc-save"]')?.click() })
    await act(async () => { await Promise.resolve() })
    expect(api.writeFeatureDoc).toHaveBeenCalledWith('checkout', 'notes.md', '# Notes')
  })
})
