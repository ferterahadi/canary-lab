// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../../shared/api/client'
import type { FeatureDocsListing } from '../../../shared/api/types'
import { CoverageDocsRail } from './CoverageDocsRail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    listFeatureDocs: vi.fn(),
    importFeatureDoc: vi.fn(),
    deleteFeatureDoc: vi.fn(),
    clearPrdSummary: vi.fn(),
  }
})

const LISTING: FeatureDocsListing = {
  feature: 'checkout',
  docs: [
    { relPath: 'prd.md', generated: false, sizeBytes: 1200 },
    { relPath: '_prd-summary.json', generated: true, sizeBytes: 800 },
  ],
  hasPrdSummary: true,
  sourceDocCount: 1,
  docsDrift: false,
}

interface Overrides {
  open?: boolean
  generating?: boolean
  summaryAbsent?: boolean
  summaryStale?: boolean
  coverageActionable?: boolean
  drift?: { changedDocs: string[]; affectedArtifacts: string[] } | null
  onToggle?: () => void
  onGenerate?: (kind: 'summary' | 'coverage') => void
  onDocsChanged?: () => void
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.listFeatureDocs).mockResolvedValue(structuredClone(LISTING))
  vi.mocked(api.importFeatureDoc).mockResolvedValue({ written: true, relativePath: 'features/checkout/docs/x.md' })
  vi.mocked(api.deleteFeatureDoc).mockResolvedValue({ deleted: true })
  vi.mocked(api.clearPrdSummary).mockResolvedValue({ feature: 'checkout', removed: ['_prd-summary.json'] })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
})

async function mount(over: Overrides = {}): Promise<void> {
  const props = {
    feature: 'checkout',
    open: over.open ?? true,
    onToggle: over.onToggle ?? (() => {}),
    generating: over.generating ?? false,
    summaryAbsent: over.summaryAbsent ?? false,
    summaryStale: over.summaryStale ?? false,
    coverageActionable: over.coverageActionable ?? true,
    drift: over.drift ?? null,
    onGenerate: over.onGenerate ?? (() => {}),
    onDocsChanged: over.onDocsChanged ?? (() => {}),
  }
  await act(async () => { root.render(<CoverageDocsRail {...props} />) })
  await act(async () => { await Promise.resolve() })
}

function makeFile(name: string): File {
  return new File(['hello'], name, { type: 'text/markdown' })
}

// The import loop is sequential and each file goes through an async FileReader,
// so a single microtask flush isn't enough — pump macrotasks until the import
// mock has been called the expected number of times (or we give up).
async function flushUntil(predicate: () => boolean, max = 50): Promise<void> {
  for (let i = 0; i < max && !predicate(); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
}

describe('CoverageDocsRail', () => {
  it('lists docs when open', async () => {
    await mount({ open: true })
    expect(api.listFeatureDocs).toHaveBeenCalledWith('checkout')
    expect(container.querySelector('[data-testid="doc-pill-prd.md"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="doc-pill-_prd-summary.json"]')).toBeTruthy()
  })

  it('collapsed shows the toggle and hides the doc list', async () => {
    await mount({ open: false })
    expect(container.querySelector('[data-testid="docs-rail"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="docs-rail-toggle"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="doc-pill-prd.md"]')).toBeNull()
  })

  it('toggle calls onToggle', async () => {
    const onToggle = vi.fn()
    await mount({ open: true, onToggle })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="docs-rail-toggle"]')?.click() })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('multi-file select imports each file sequentially', async () => {
    const onDocsChanged = vi.fn()
    await mount({ open: true, onDocsChanged })
    const input = container.querySelector<HTMLInputElement>('[data-testid="doc-file-input"]')!
    const files = [makeFile('a.md'), makeFile('b.md'), makeFile('c.md')]
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    await flushUntil(() => vi.mocked(api.importFeatureDoc).mock.calls.length >= 3)
    expect(api.importFeatureDoc).toHaveBeenCalledTimes(3)
    expect(onDocsChanged).toHaveBeenCalled()
  })

  it('one failing file yields a combined error while the others still import', async () => {
    vi.mocked(api.importFeatureDoc)
      .mockResolvedValueOnce({ written: true, relativePath: 'a' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ written: true, relativePath: 'c' })
    await mount({ open: true })
    const input = container.querySelector<HTMLInputElement>('[data-testid="doc-file-input"]')!
    const files = [makeFile('a.md'), makeFile('b.md'), makeFile('c.md')]
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    await flushUntil(() => container.querySelector('[data-testid="docs-error"]') != null)
    expect(api.importFeatureDoc).toHaveBeenCalledTimes(3)
    const err = container.querySelector('[data-testid="docs-error"]')
    expect(err?.textContent).toContain('1 of 3 docs failed')
    expect(err?.textContent).toContain('b.md')
  })

  it('summaryAbsent renders a single Generate button that calls onGenerate(summary)', async () => {
    const onGenerate = vi.fn()
    await mount({ open: true, summaryAbsent: true, onGenerate })
    const gen = container.querySelector<HTMLButtonElement>('[data-testid="generate-summary"]')
    expect(gen?.textContent).toBe('Generate')
    expect(container.querySelector('[data-testid="generate-coverage"]')).toBeNull()
    act(() => { gen?.click() })
    expect(onGenerate).toHaveBeenCalledWith('summary')
  })

  it('Generate is disabled when there are zero source docs', async () => {
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: false, sourceDocCount: 0, docsDrift: false })
    await mount({ open: true, summaryAbsent: true })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="generate-summary"]')?.disabled).toBe(true)
  })

  it('non-absent renders both generate buttons; coverage disabled when not actionable', async () => {
    const onGenerate = vi.fn()
    await mount({ open: true, summaryAbsent: false, coverageActionable: false, onGenerate })
    expect(container.querySelector('[data-testid="generate-summary"]')).toBeTruthy()
    const cov = container.querySelector<HTMLButtonElement>('[data-testid="generate-coverage"]')
    expect(cov?.disabled).toBe(true)
  })

  it('Regenerate coverage calls onGenerate(coverage) when actionable', async () => {
    const onGenerate = vi.fn()
    await mount({ open: true, summaryAbsent: false, coverageActionable: true, onGenerate })
    const cov = container.querySelector<HTMLButtonElement>('[data-testid="generate-coverage"]')
    expect(cov?.disabled).toBe(false)
    act(() => { cov?.click() })
    expect(onGenerate).toHaveBeenCalledWith('coverage')
  })

  it('generating=true disables both generate buttons', async () => {
    await mount({ open: true, summaryAbsent: false, coverageActionable: true, generating: true })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="generate-summary"]')?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[data-testid="generate-coverage"]')?.disabled).toBe(true)
  })

  it('generating=true also disables the destructive doc actions (add + remove)', async () => {
    await mount({ open: true, summaryAbsent: false, coverageActionable: true, generating: true })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="add-another-doc"]')?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[data-testid="remove-doc-prd.md"]')?.disabled).toBe(true)
  })

  it('removing a source doc calls deleteFeatureDoc + onDocsChanged', async () => {
    const onDocsChanged = vi.fn()
    await mount({ open: true, onDocsChanged })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="remove-doc-prd.md"]')?.click()
      await Promise.resolve()
    })
    expect(api.deleteFeatureDoc).toHaveBeenCalledWith('checkout', 'prd.md')
    expect(onDocsChanged).toHaveBeenCalled()
  })

  it('removing the generated artifact calls clearPrdSummary', async () => {
    await mount({ open: true })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="remove-doc-_prd-summary.json"]')?.click()
      await Promise.resolve()
    })
    expect(api.clearPrdSummary).toHaveBeenCalledWith('checkout')
  })

  it('shows the stale drift line naming changed docs + affected artifacts', async () => {
    await mount({ open: true, summaryStale: true, drift: { changedDocs: ['prd.md'], affectedArtifacts: ['PRD summary', 'coverage ledger'] } })
    const drift = container.querySelector('[data-testid="docs-rail-drift"]')
    expect(drift?.textContent).toContain('prd.md')
    expect(drift?.textContent).toContain('PRD summary + coverage ledger')
  })
})
