// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { readableTest } from '@/shared/api/__fixtures__/readable-test'
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
    getProjectConfig: vi.fn(),
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
  // The Generate gate probes the config first — defaults keep it disarmed.
  vi.mocked(api.getProjectConfig).mockResolvedValue({ healAgent: 'claude', editor: 'auto', personalWikiPath: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(LEDGER))
  vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: true, sourceDocCount: 1, docsDrift: true })
  vi.mocked(api.listCoverageJobs).mockResolvedValue([]) // no running job by default
  vi.mocked(api.getFeatureTests).mockResolvedValue([
    { file: '/repo/features/checkout/e2e/cart.spec.ts', tests: [{ name: 'adds item', line: 10, bodySource: 'await page.goto("/cart")\nexpect(items).toHaveLength(1)', steps: [], readable: readableTest('adds item') }] },
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

const EMPTY_LEDGER: CoverageLedger = {
  feature: 'checkout',
  requirements: [],
  tests: [],
  totals: { total: 0, covered: 0, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 },
  coveragePct: 0,
  mappedPct: 0,
  orphanRequirementIds: [],
  orphanTestNames: [],
  state: { summary: 'absent', coverage: 'blocked', headline: 'Setup needed', drift: { drifted: false, changedDocs: [], affectedArtifacts: [] } },
}

// The variant axis (D1): a requirement that spans a dimension (channel) but is
// only tested on some values renders a path × variant grid + a variant-incomplete
// gap pill — the breadth gap the 2-axis ledger couldn't show.
const VARIANT_LEDGER: CoverageLedger = {
  feature: 'checkout',
  requirements: [
    {
      requirement: { id: 'R6', title: 'Config scoping on all channels', text: 'enforce on every channel', pathTypes: ['happy', 'sad'], variants: ['email', 'whatsapp', 'call', 'line'] },
      annotatedTestNames: ['sender V4'],
      pathCoverage: [{ path: 'happy', covered: true }, { path: 'sad', covered: true }],
      variantCoverage: [
        { path: 'happy', variant: 'email', covered: true },
        { path: 'sad', variant: 'email', covered: true },
        { path: 'happy', variant: 'whatsapp', covered: false },
        { path: 'sad', variant: 'whatsapp', covered: false },
        { path: 'happy', variant: 'call', covered: false },
        { path: 'sad', variant: 'call', covered: false },
        { path: 'happy', variant: 'line', covered: false },
        { path: 'sad', variant: 'line', covered: false },
      ],
      gapType: 'variant-incomplete',
      coverageStatus: 'partial',
    },
  ],
  tests: [{ name: 'sender V4', requirements: ['R6'], pathTypes: ['happy', 'sad'], variants: ['email'], strength: 'solid', file: 'e2e/sender.spec.ts', line: 3 }],
  totals: { total: 1, covered: 0, pathIncomplete: 0, variantIncomplete: 1, untested: 0, orphanTests: 0 },
  coveragePct: 0,
  mappedPct: 100,
  orphanRequirementIds: [],
  orphanTestNames: [],
  state: { summary: 'fresh', coverage: 'fresh', headline: 'Variant gap', drift: { drifted: false, changedDocs: [], affectedArtifacts: [] } },
}

describe('CoverageLedgerPage — empty (ABSENT summary)', () => {
  it('shows the empty main + the docs rail (no setup-guide tab) (R22)', async () => {
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(EMPTY_LEDGER))
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: false, sourceDocCount: 0, docsDrift: false })
    await mount()
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-testid="coverage-empty-main"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="docs-rail"]')).toBeTruthy()
    // No ledger panes while the summary is absent.
    expect(container.querySelector('[data-testid="prd-pane"]')).toBeNull()
  })

  it('generates from the rail once a doc exists and starts the chained job', async () => {
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(EMPTY_LEDGER))
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [{ relPath: 'spec.md', absPath: '/repo/features/checkout/docs/spec.md', generated: false, sizeBytes: 9 }], hasPrdSummary: false, sourceDocCount: 1, docsDrift: false })
    vi.mocked(api.startCoverageJob).mockResolvedValue({ jobId: 'j', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'n', log: '' })
    vi.mocked(api.getCoverageJob).mockResolvedValue({ jobId: 'j', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'n', log: 'done' })
    await mount()
    await act(async () => { await Promise.resolve() })
    const gen = container.querySelector<HTMLButtonElement>('[data-testid="generate-summary"]')
    expect(gen?.disabled).toBe(false)
    await act(async () => { gen?.click(); await Promise.resolve() })
    expect(api.startCoverageJob).toHaveBeenCalledWith('checkout', 'summary', undefined)
  })
})

describe('CoverageLedgerPage — variant axis (D1)', () => {
  beforeEach(() => {
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(VARIANT_LEDGER))
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: true, sourceDocCount: 1, docsDrift: false })
  })

  it('shows a clickable path pill per path with a covered/total variant count, cells hidden until opened', async () => {
    await mount()
    expect(container.querySelector('[data-testid="variant-grid-R6"]')).toBeTruthy()
    const happy = container.querySelector('[data-testid="variant-path-R6-happy"]')
    expect(happy?.textContent).toContain('happy')
    expect(happy?.textContent).toContain('1/4') // only email of {email,whatsapp,call,line}
    // Variant cells are collapsed — nothing is rendered until a pill is opened.
    expect(container.querySelector('[data-testid="cell-R6-happy-email"]')).toBeNull()
  })

  it('expands one path at a time to reveal its variant cells', async () => {
    await mount()
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="variant-path-R6-happy"]')?.click() })
    expect(container.querySelector('[data-testid="cell-R6-happy-email"]')?.getAttribute('data-covered')).toBe('true')
    expect(container.querySelector('[data-testid="cell-R6-happy-whatsapp"]')?.getAttribute('data-covered')).toBe('false')
    // Opening sad closes happy — only one path's cells show at a time.
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="variant-path-R6-sad"]')?.click() })
    expect(container.querySelector('[data-testid="cell-R6-happy-email"]')).toBeNull()
    expect(container.querySelector('[data-testid="cell-R6-sad-email"]')?.getAttribute('data-covered')).toBe('true')
    // Clicking the open pill again collapses it.
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="variant-path-R6-sad"]')?.click() })
    expect(container.querySelector('[data-testid="cell-R6-sad-email"]')).toBeNull()
  })

  it('labels the gap "Variant gap" and keeps the missing channels in the pill tooltip (not the pill text)', async () => {
    await mount()
    const gap = container.querySelector('[data-testid="gap-R6"]')
    expect(gap?.textContent).toContain('Variant gap')
    expect(gap?.textContent).not.toContain('whatsapp')
    const happy = container.querySelector('[data-testid="variant-path-R6-happy"]')
    expect(happy?.getAttribute('title')).toContain('whatsapp')
    expect(happy?.getAttribute('title')).toContain('line')
  })

  it('counts the requirement in the variant-incomplete breakdown segment', async () => {
    await mount()
    const badge = container.querySelector('[data-testid="gap-badge-variant-incomplete"]')
    expect(badge?.textContent).toContain('1')
  })

  it('renders a single-path variant requirement as one pill that expands to its chips', async () => {
    const single = structuredClone(VARIANT_LEDGER)
    single.requirements[0].requirement.pathTypes = ['happy']
    single.requirements[0].pathCoverage = [{ path: 'happy', covered: true }]
    single.requirements[0].variantCoverage = [
      { path: 'happy', variant: 'email', covered: true },
      { path: 'happy', variant: 'whatsapp', covered: false },
      { path: 'happy', variant: 'call', covered: false },
      { path: 'happy', variant: 'line', covered: false },
    ]
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(single)
    await mount()
    expect(container.querySelector('[data-testid="variant-path-R6-happy"]')?.textContent).toContain('1/4')
    expect(container.querySelector('[data-testid="cell-R6-happy-email"]')).toBeNull()
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="variant-path-R6-happy"]')?.click() })
    expect(container.querySelector('[data-testid="cell-R6-happy-email"]')?.getAttribute('data-covered')).toBe('true')
    expect(container.querySelector('[data-testid="cell-R6-happy-whatsapp"]')?.getAttribute('data-covered')).toBe('false')
  })

  it('excludes N/A variants from the count and renders them as n/a with the reason', async () => {
    // email covered + whatsapp/call/line N/A (no surface) → 1/1 applicable, covered.
    const na = structuredClone(VARIANT_LEDGER)
    na.requirements[0].gapType = 'covered'
    na.requirements[0].coverageStatus = 'covered'
    na.requirements[0].requirement.variantsNA = [
      { variant: 'whatsapp', reason: 'no V4 config endpoint' },
      { variant: 'call', reason: 'no V4 config endpoint' },
      { variant: 'line', reason: 'no V4 config endpoint' },
    ]
    na.requirements[0].variantCoverage = [
      { path: 'happy', variant: 'email', covered: true, applicable: true },
      { path: 'sad', variant: 'email', covered: true, applicable: true },
      ...['whatsapp', 'call', 'line'].flatMap((v) => ([
        { path: 'happy' as const, variant: v, covered: false, applicable: false, reason: 'no V4 config endpoint' },
        { path: 'sad' as const, variant: v, covered: false, applicable: false, reason: 'no V4 config endpoint' },
      ])),
    ]
    na.totals = { total: 1, covered: 1, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 }
    na.coveragePct = 100
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(na)
    await mount()
    // Count is over applicable variants only → 1/1, not 1/4.
    const happy = container.querySelector('[data-testid="variant-path-R6-happy"]')
    expect(happy?.textContent).toContain('1/1')
    expect(happy?.getAttribute('title')).toContain('N/A')
    act(() => { (happy as HTMLButtonElement)?.click() })
    const cell = container.querySelector('[data-testid="cell-R6-happy-whatsapp"]')
    expect(cell?.getAttribute('data-covered')).toBe('na')
    expect(cell?.textContent).toContain('n/a')
    expect(cell?.getAttribute('title')).toContain('no V4 config endpoint')
  })
})
