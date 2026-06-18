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
  return {
    ...actual,
    listFeatureDocs: vi.fn(), regeneratePrdSummary: vi.fn(), writeFeatureDoc: vi.fn(),
    importFeatureDoc: vi.fn(), deleteFeatureDoc: vi.fn(), clearPrdSummary: vi.fn(),
    startCoverageJob: vi.fn(), getCoverageJob: vi.fn(),
  }
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
  vi.mocked(api.importFeatureDoc).mockResolvedValue({ written: true, relativePath: 'docs/spec.md' })
  vi.mocked(api.deleteFeatureDoc).mockResolvedValue({ deleted: true })
  vi.mocked(api.clearPrdSummary).mockResolvedValue({ feature: 'checkout', removed: ['_prd-summary.md'] })
  vi.mocked(api.startCoverageJob).mockResolvedValue({ jobId: 'j', feature: 'checkout', kind: 'summary', status: 'running', startedAt: 'n', log: '' })
  vi.mocked(api.getCoverageJob).mockResolvedValue({ jobId: 'j', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'n', log: 'done' })
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

  it('regenerate runs an async summary job (streams) and notifies the parent on done', async () => {
    const onRegenerated = vi.fn()
    await mount(onRegenerated)
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="regenerate-prd"]')?.click() })
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(api.startCoverageJob).toHaveBeenCalledWith('checkout', 'summary')
    expect(api.getCoverageJob).toHaveBeenCalledWith('j')
    expect(onRegenerated).toHaveBeenCalled()
  })

  it('has a single add affordance (no Add-doc form, no header Upload button)', async () => {
    await mount()
    expect(container.querySelector('[data-testid="add-doc-toggle"]')).toBeNull()
    expect(container.querySelector('[data-testid="upload-doc"]')).toBeNull()
    // With docs present, the lone add affordance is the compact "add another" row.
    expect(container.querySelector('[data-testid="add-another-doc"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="doc-file-input"]')).toBeTruthy()
  })

  it('labels the action "Generate" (enabled) when docs exist but no summary', async () => {
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [{ relPath: 'spec.md', generated: false, sizeBytes: 9 }], hasPrdSummary: false, sourceDocCount: 1, docsDrift: false })
    await mount()
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="regenerate-prd"]')
    expect(btn?.disabled).toBe(false)
    expect(btn?.textContent).toBe('Generate PRD summary')
  })

  it('disables generation when there are no source docs', async () => {
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: false, sourceDocCount: 0, docsDrift: false })
    await mount()
    expect(container.querySelector<HTMLButtonElement>('[data-testid="regenerate-prd"]')?.disabled).toBe(true)
  })

  it('shows a centered dropzone empty state when there are no docs', async () => {
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: false, sourceDocCount: 0, docsDrift: false })
    await mount()
    expect(container.querySelector('[data-testid="empty-dropzone"]')).toBeTruthy()
  })

  it('imports an uploaded file (picker → import endpoint)', async () => {
    await mount()
    const input = container.querySelector<HTMLInputElement>('[data-testid="doc-file-input"]')!
    const file = new File(['# Hello'], 'brief.md', { type: 'text/markdown' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(api.importFeatureDoc).toHaveBeenCalled()
    expect(vi.mocked(api.importFeatureDoc).mock.calls[0][0]).toBe('checkout')
    expect(vi.mocked(api.importFeatureDoc).mock.calls[0][1].filename).toBe('brief.md')
  })

  it('imports multiple selected files (picker → one import per file)', async () => {
    await mount()
    const input = container.querySelector<HTMLInputElement>('[data-testid="doc-file-input"]')!
    expect(input.multiple).toBe(true)
    const files = [
      new File(['# A'], 'a.md', { type: 'text/markdown' }),
      new File(['# B'], 'b.md', { type: 'text/markdown' }),
      new File(['# C'], 'c.md', { type: 'text/markdown' }),
    ]
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(api.importFeatureDoc).toHaveBeenCalledTimes(3)
    const names = vi.mocked(api.importFeatureDoc).mock.calls.map((c) => c[1].filename)
    expect(names).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('imports every dropped file', async () => {
    await mount()
    const tab = container.querySelector<HTMLDivElement>('[data-testid="coverage-docs-tab"]')!
    const files = [
      new File(['# A'], 'a.md', { type: 'text/markdown' }),
      new File(['# B'], 'b.md', { type: 'text/markdown' }),
    ]
    const event = new Event('drop', { bubbles: true }) as Event & { dataTransfer: unknown }
    Object.defineProperty(event, 'dataTransfer', { value: { files }, configurable: true })
    await act(async () => { tab.dispatchEvent(event) })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(api.importFeatureDoc).toHaveBeenCalledTimes(2)
    const names = vi.mocked(api.importFeatureDoc).mock.calls.map((c) => c[1].filename)
    expect(names).toEqual(['a.md', 'b.md'])
  })

  it('a failing file does not abort the batch and surfaces a combined error', async () => {
    vi.mocked(api.importFeatureDoc)
      .mockResolvedValueOnce({ written: true, relativePath: 'docs/a.md' })
      .mockRejectedValueOnce(new Error('unsupported'))
      .mockResolvedValueOnce({ written: true, relativePath: 'docs/c.md' })
    await mount()
    const input = container.querySelector<HTMLInputElement>('[data-testid="doc-file-input"]')!
    const files = [
      new File(['# A'], 'a.md', { type: 'text/markdown' }),
      new File(['x'], 'b.docx', { type: '' }),
      new File(['# C'], 'c.md', { type: 'text/markdown' }),
    ]
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    // All three were attempted — the middle failure did not stop the rest.
    expect(api.importFeatureDoc).toHaveBeenCalledTimes(3)
    const err = container.querySelector('[data-testid="docs-error"]')
    expect(err?.textContent).toContain('1 of 3 docs failed')
    expect(err?.textContent).toContain('b.docx')
  })

  it('removes a source doc via the pill ✕', async () => {
    await mount()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="remove-doc-spec.md"]')?.click() })
    await act(async () => { await Promise.resolve() })
    expect(api.deleteFeatureDoc).toHaveBeenCalledWith('checkout', 'spec.md')
  })

  it('clears the generated PRD summary via its ✕', async () => {
    await mount()
    expect(container.querySelector('[data-testid="remove-doc-_prd-summary.md"]')).toBeTruthy()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="remove-doc-_prd-summary.md"]')?.click() })
    await act(async () => { await Promise.resolve() })
    expect(api.clearPrdSummary).toHaveBeenCalledWith('checkout')
    expect(api.deleteFeatureDoc).not.toHaveBeenCalled()
  })
})
