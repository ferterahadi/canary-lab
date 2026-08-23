// @vitest-environment happy-dom

import { act } from 'react'

import { createRoot, type Root } from 'react-dom/client'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '@/shared/api/client'

import type { CoverageLedger } from '@/shared/api/types'

import { CoverageLedgerPage } from './CoverageLedgerPage'

;

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// TestCard expands to the shared ShikiCode block, which lazily imports Shiki.
// Mock the modules (same as TestCasesColumn.test) so the highlighter resolves
// deterministically with line spans instead of loading the real wasm.
vi.mock('shiki/core', () => ({
  createHighlighterCore: async () => ({
    codeToHtml: (code: string) => (
      `<pre class="shiki one-dark-pro"><code>${
        code.split('\n').map((line) => `<span class="line">${line}</span>`).join('\n')
      }</code></pre>`
    ),
  }),
}))

vi.mock('shiki/engine/oniguruma', () => ({ createOnigurumaEngine: () => ({}) }))

vi.mock('shiki/langs/typescript.mjs', () => ({ default: {} }))

vi.mock('shiki/themes/one-dark-pro.mjs', () => ({ default: {} }))

vi.mock('shiki/themes/one-light.mjs', () => ({ default: {} }))

vi.mock('shiki/wasm', () => ({ default: {} }))

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    getFeatureCoverage: vi.fn(),
    listFeatureDocs: vi.fn(),
    regeneratePrdSummary: vi.fn(),
    startCoverageJob: vi.fn(),
    getCoverageJob: vi.fn(),
    listCoverageJobs: vi.fn(),
    getFeatureTests: vi.fn(),
    openEditor: vi.fn(),
  }
})

const LEDGER: CoverageLedger = {
  feature: 'checkout',
  requirements: [
    {
      requirement: { id: 'R1', title: 'Add to cart', text: 'user can add an item', pathTypes: ['happy', 'sad'], kind: 'functional', happyPath: 'item appears in the cart with the right qty', unhappyPath: 'out-of-stock item is rejected with a message' },
      annotatedTestNames: ['adds item'],
      pathCoverage: [{ path: 'happy', covered: true }, { path: 'sad', covered: false }],
      gapType: 'path-incomplete',
      coverageStatus: 'partial',
    },
    {
      requirement: { id: 'R2', title: 'Send receipt', text: 'send a receipt email', pathTypes: ['happy'] },
      annotatedTestNames: ['sends receipt'],
      pathCoverage: [{ path: 'happy', covered: true }],
      gapType: 'covered',
      coverageStatus: 'covered',
    },
    {
      requirement: { id: 'R3', title: 'Apply coupon', text: 'coupon reduces total', pathTypes: ['happy'] },
      annotatedTestNames: [],
      pathCoverage: [{ path: 'happy', covered: false }],
      gapType: 'untested',
      coverageStatus: 'uncovered',
    },
  ],
  tests: [
    { name: 'adds item', requirements: ['R1'], pathTypes: ['happy'], strength: 'solid', file: 'e2e/cart.spec.ts', line: 10 },
    { name: 'sends receipt', requirements: ['R2'], pathTypes: ['happy'], strength: 'shallow', file: 'e2e/receipt.spec.ts', line: 5 },
  ],
  totals: { total: 3, covered: 1, pathIncomplete: 1, variantIncomplete: 0, untested: 1, orphanTests: 0 },
  coveragePct: 33.3,
  mappedPct: 66.7,
  orphanRequirementIds: [],
  orphanTestNames: [],
  state: {
    summary: 'stale',
    coverage: 'blocked',
    headline: 'Stale',
    drift: { drifted: true, changedDocs: ['prd.md'], affectedArtifacts: ['PRD summary', 'coverage ledger'] },
  },
  docsDrift: true,
}

let container: HTMLDivElement

let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(LEDGER))
  vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: true, sourceDocCount: 1, docsDrift: true })
  vi.mocked(api.listCoverageJobs).mockResolvedValue([]) // no running job by default
  vi.mocked(api.getFeatureTests).mockResolvedValue([
    { file: '/repo/features/checkout/e2e/cart.spec.ts', tests: [{ name: 'adds item', line: 10, bodySource: 'await page.goto("/cart")\nexpect(items).toHaveLength(1)', steps: [] }] },
  ])
  vi.mocked(api.openEditor).mockResolvedValue({ opened: true, editor: 'vscode' })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
})

async function mount(): Promise<void> {
  await act(async () => { root.render(<CoverageLedgerPage feature="checkout" onClose={() => {}} />) })
  await act(async () => { await Promise.resolve() })
}

describe('CoverageLedgerPage — flight generating banner (R14)', () => {
  it('says a flight is generating the ledger and opens the flight', async () => {
    const onOpenFlight = vi.fn()
    await act(async () => {
      root.render(
        <CoverageLedgerPage
          feature="checkout"
          onClose={() => {}}
          generatingFlight={{ flightId: 'fl_1', stage: 'specs-coverage', stageStatus: 'running' }}
          onOpenFlight={onOpenFlight}
        />,
      )
    })
    await act(async () => { await Promise.resolve() })
    const banner = container.querySelector('[data-testid="coverage-flight-generating"]')
    expect(banner?.textContent).toContain('Test authoring & coverage is running')
    expect(banner?.querySelector('[data-testid="stage-status-chip"]')?.textContent).toContain('Running')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="coverage-open-flight"]')?.click()
    })
    expect(onOpenFlight).toHaveBeenCalledWith('fl_1')
  })

  it('renders no banner when no flight is generating', async () => {
    await mount()
    expect(container.querySelector('[data-testid="coverage-flight-generating"]')).toBeNull()
  })
})
