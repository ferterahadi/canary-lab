// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { readableTest } from '@/shared/api/__fixtures__/readable-test'
import type { CoverageLedger } from '@/shared/api/types'
import { RAIL_PREF_KEY } from './CoverageHeader'
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
  localStorage.removeItem(RAIL_PREF_KEY)
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

  // The empty pane teaches the three-step exercise; with the rail open it can point
  // at it ("on the left"), so it offers no button of its own.
  it('reads as the three-step exercise and leaves the way in to the open rail', async () => {
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(EMPTY_LEDGER))
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: false, sourceDocCount: 0, docsDrift: false })
    await mount()
    await act(async () => { await Promise.resolve() })
    const main = container.querySelector('[data-testid="coverage-empty-main"]') as HTMLElement
    expect([...main.querySelectorAll('.clcov-empty-name')].map((el) => el.textContent))
      .toEqual(['Add your docs', 'Press Generate', 'Read the results'])
    expect(main.textContent).toContain('Source docs on the left')
    expect(container.querySelector('[data-testid="coverage-empty-open-rail"]')).toBeNull()
  })

  // Rail collapsed: "on the left" would point at a 46px strip, so the pane carries a
  // real way in instead — never a dead-end (cl_ui-design-philosophy).
  it('offers a way into the collapsed rail, and opening it retires the button', async () => {
    localStorage.setItem(RAIL_PREF_KEY, 'closed')
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(EMPTY_LEDGER))
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: false, sourceDocCount: 0, docsDrift: false })
    await mount()
    await act(async () => { await Promise.resolve() })
    const open = container.querySelector<HTMLButtonElement>('[data-testid="coverage-empty-open-rail"]')
    expect(open).toBeTruthy()
    expect(container.querySelector('[data-testid="coverage-empty-main"]')?.textContent).not.toContain('on the left')
    await act(async () => { open?.click(); await Promise.resolve() })
    expect(container.querySelector('[data-testid="doc-file-input"]')).toBeTruthy() // rail is open now
    expect(container.querySelector('[data-testid="coverage-empty-open-rail"]')).toBeNull()
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

  // Channels live in the expanded detail as a GRID — channels down, paths across.
  // They used to be a chip row repeated under each promise, printing the same four
  // names twice in two disconnected lists, so "is `line` tested anywhere?" meant
  // scanning both. A channel is a property of the requirement, not of one promise.
  function expandR6(): void {
    act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R6"]')?.click() })
  }

  const rowSegs = (variant: string) =>
    [...container.querySelectorAll(`[data-testid="channel-R6-${variant}"] [data-seg]`)].map((el) => el.getAttribute('data-seg'))

  it('shows one segment per applicable path×variant cell at rest', async () => {
    await mount()
    const cov = container.querySelector('[data-testid="cov-R6"]')
    const segs = [...cov!.querySelectorAll('[data-seg]')].map((el) => el.getAttribute('data-seg'))
    // 2 paths × 4 channels, email covered on both.
    expect(segs.length).toBe(8)
    expect(segs.filter((v) => v === 'claimed').length).toBe(2)
    expect(cov?.textContent).toContain('2/8')
    expect(container.querySelector('[data-testid="channel-grid-R6"]')).toBeNull()
  })

  it('opens to one row per channel and one column per path, with the paths named', async () => {
    await mount()
    expandR6()
    const grid = container.querySelector('[data-testid="channel-grid-R6"]') as HTMLElement
    expect(grid).toBeTruthy()
    expect(grid.textContent).toContain('Per channel')
    expect([...grid.querySelectorAll('.clcov-grid-col')].map((el) => el.textContent)).toEqual(['happy', 'sad'])
    expect([...grid.querySelectorAll('.clcov-grid-name')].map((el) => el.textContent)).toEqual(['whatsapp', 'call', 'line', 'email'])
    expect(rowSegs('email')).toEqual(['claimed', 'claimed'])
    expect(rowSegs('whatsapp')).toEqual(['off', 'off'])
  })

  // Worst-first, like every other list of work here: the channels with the most
  // missing tests lead, and the fully covered one sinks.
  it('leads with the channel that is missing the most, so the gap is read first', async () => {
    await mount()
    expandR6()
    const first = container.querySelector('[data-testid="channel-grid-R6"] .clcov-grid-row') as HTMLElement
    expect(first.querySelector('.clcov-grid-name')?.textContent).toBe('whatsapp')
  })

  // A column label that doesn't sit over its own marks isn't a header. happy-dom
  // lays nothing out, so the testable form of "one column resolution" is that the
  // template is declared once, on the container the head and rows are subgrids of.
  // The path tracks are content-sized (`minmax(22px,auto)`), never a fixed width:
  // at 22px a label as ordinary as `happy` overflowed into the next column, so the
  // head read `happyedge` and no label sat over the marks it names.
  it('declares the column template once, so the labels and the marks share it', async () => {
    await mount()
    expandR6()
    const grid = container.querySelector('[data-testid="channel-grid-R6"]') as HTMLElement
    expect(grid.style.gridTemplateColumns).toBe('minmax(64px,auto) repeat(2,minmax(22px,auto)) minmax(0,1fr)')
    const lines = [...grid.querySelectorAll('.clcov-grid-head, .clcov-grid-row')] as HTMLElement[]
    expect(lines.length).toBe(5)
    for (const line of lines) expect(line.style.gridTemplateColumns).toBe('')
  })

  // At two or three channels an axis lookup costs more than the sentence does.
  it('ends each channel row with the word its marks add up to', async () => {
    await mount()
    expandR6()
    expect(container.querySelector('[data-testid="channel-R6-email"] .clcov-grid-word')?.textContent).toBe('has a test · not yet passed')
    expect(container.querySelector('[data-testid="channel-R6-line"] .clcov-grid-word')?.textContent).toBe('no test')
  })

  // The grid owns every mark once there is a channel dimension, so a band that has
  // no prose of its own has nothing left to say — it would be a name over blank space.
  it('drops the prose-less bands when the grid is carrying the coverage', async () => {
    await mount()
    expandR6()
    expect(container.querySelector('[data-testid="behaviour-R6"]')).toBeNull()
  })

  it('keeps a band that has prose, but leaves its marks to the grid', async () => {
    const withProse = structuredClone(VARIANT_LEDGER)
    withProse.requirements[0].requirement.happyPath = 'Every channel honours the scope.'
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(withProse)
    await mount()
    expandR6()
    const happy = container.querySelector('[data-testid="behaviour-happy-R6"]') as HTMLElement
    expect(happy.textContent).toContain('Every channel honours the scope.')
    expect(happy.querySelector('[data-seg]')).toBeNull()
    expect(container.querySelector('[data-testid="behaviour-unhappy-R6"]')).toBeNull()
    // A channelled requirement reads its marks off the channel grid, never the
    // per-path table — one table per requirement, always.
    expect(container.querySelector('[data-testid="path-grid-R6"]')).toBeNull()
  })

  it('names the gap "Variant gap" in the row tooltip and the missing channels in the verdict', async () => {
    await mount()
    const cov = container.querySelector('[data-testid="cov-R6"]')
    act(() => { cov?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('Variant gap')
    expect(cov?.textContent).not.toContain('whatsapp')
    expect(container.querySelector('[data-testid="gap-R6"]')).toBeNull()
    expandR6()
    // Each mark still names its own case on hover, and the verdict names the set.
    expect(container.querySelector('[data-testid="channel-R6-whatsapp"] [data-seg]')?.getAttribute('title')).toBe('happy · whatsapp — no test')
    expect(container.querySelector('[data-testid="proof-verdict-R6"]')).toBeNull()
  })

  it('counts the requirement in the variant-incomplete breakdown segment', async () => {
    await mount()
    const badge = container.querySelector('[data-testid="gap-badge-variant-incomplete"]')
    expect(badge?.textContent).toContain('1')
  })

  it('renders a single-path variant requirement as a one-column grid', async () => {
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
    expandR6()
    const grid = container.querySelector('[data-testid="channel-grid-R6"]') as HTMLElement
    expect([...grid.querySelectorAll('.clcov-grid-col')].map((el) => el.textContent)).toEqual(['happy'])
    expect(rowSegs('email')).toEqual(['claimed'])
    expect(rowSegs('whatsapp')).toEqual(['off'])
  })

  it('excludes N/A channels from the count and sinks them to the bottom with the reason', async () => {
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
    // The row counts applicable cells only → 2/2 segments, both filled.
    expect(container.querySelector('[data-testid="cov-R6"]')?.textContent).toContain('2/2')
    expandR6()
    // N/A is never a gap, so it never competes for the top of a worst-first list.
    expect([...container.querySelectorAll('[data-testid="channel-grid-R6"] .clcov-grid-name')].map((el) => el.textContent))
      .toEqual(['email', 'whatsapp', 'call', 'line'])
    const row = container.querySelector('[data-testid="channel-R6-whatsapp"]') as HTMLElement
    expect(row.dataset.na).toBe('true')
    expect(rowSegs('whatsapp')).toEqual(['na', 'na'])
    expect(row.textContent).toContain('n/a — no V4 config endpoint')
    expect(row.querySelector('[data-seg]')?.getAttribute('title')).toContain('no V4 config endpoint')
  })
})
