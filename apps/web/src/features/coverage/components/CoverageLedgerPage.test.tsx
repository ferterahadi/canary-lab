// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../../shared/api/client'
import type { CoverageLedger } from '../../../shared/api/types'
import { CoverageLedgerPage } from './CoverageLedgerPage'

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

vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
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

// Summary-absent ledger: the only state whose rail exposes a "Generate" button
// (once a summary exists the footer is the destructive "Redo from the start"
// wipe, not an in-place regenerate). The generation/chain flow is driven from
// here.
const ABSENT_LEDGER: CoverageLedger = {
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

// React synthesizes onMouseEnter/onMouseLeave from the delegated native
// mouseover/mouseout events, so dispatch those (bubbling) rather than raw
// mouseenter/mouseleave (which React's root listener never sees).
function fire(el: Element | null | undefined, kind: 'enter' | 'leave') {
  if (!el) throw new Error('element not found')
  const type = kind === 'enter' ? 'mouseover' : 'mouseout'
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true })) })
}

describe('CoverageLedgerPage', () => {
  it('renders requirements, tests, and the coverage breakdown', async () => {
    await mount()
    expect(container.querySelector('[data-testid="req-R1"]')?.textContent).toContain('Add to cart')
    expect(container.querySelector('[data-testid="test-adds item"]')?.textContent).toContain('adds item')
    expect(container.querySelector('[data-testid="coverage-breakdown"]')).toBeTruthy()
  })

  it('surfaces a Mapped breadth ratio (concrete, no redundant %)', async () => {
    await mount()
    const mapped = container.querySelector('[data-testid="mapped-stat"]')
    // LEDGER: 3 reqs, 1 untested → 2 mapped. Ratio only — the % restated it.
    expect(mapped?.textContent).toContain('2/3 mapped')
    expect(mapped?.textContent).not.toContain('%')
  })

  it('renders the proportional coverage breakdown bar', async () => {
    await mount()
    expect(container.querySelector('[data-testid="coverage-breakdown"]')).toBeTruthy()
  })

  it('shows the coverage % as a ring left of the bar', async () => {
    await mount()
    const ring = container.querySelector('[data-testid="coverage-ring"]')
    expect(ring?.getAttribute('aria-label')).toBe('33.3% covered')
    expect(container.querySelector('[data-testid="coverage-hero"]')).toBeNull() // hero number gone
    expect(container.querySelector('[data-testid="coverage-breakdown"]')).toBeTruthy()
  })

  it('suppresses the state pill in the covered state (the ring owns the %)', async () => {
    const led = structuredClone(LEDGER)
    led.state = { ...led.state!, summary: 'fresh', headline: 'Covered 36.7%' }
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(led)
    await mount()
    // Covered → no redundant pill; the ring carries it.
    expect(container.querySelector('[data-testid="coverage-state-headline"]')).toBeNull()
    expect(container.querySelector('[data-testid="coverage-ring"]')?.getAttribute('aria-label')).toBe('33.3% covered')
  })

  it('places the strength filter in the stat header, above the tests column (not in the tests pane)', async () => {
    await mount()
    expect(container.querySelector('[data-testid="strength-filter"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="tests-pane"] [data-testid="strength-filter"]')).toBeNull()
  })

  it('shows a terse gap status and names the missing path via the chips (not the pill)', async () => {
    await mount()
    // R1: happy claimed, sad declared but unclaimed. The status pill is now just the
    // short label (no "· sad" note) — the path chips below name the exact gap.
    const gap = container.querySelector('[data-testid="gap-R1"]')
    expect(gap?.textContent).toContain('Path gap')
    expect(gap?.textContent).not.toContain('· sad')
    // The path chips are just the path name (the dashed/muted style carries "no test"):
    // covered shows a ✓, uncovered shows neither "✓" nor the old "· no test".
    expect(container.querySelector('[data-testid="path-R1-happy"]')?.textContent?.trim()).toBe('happy ✓')
    expect(container.querySelector('[data-testid="path-R1-sad"]')?.textContent?.trim()).toBe('sad')
  })

  it('clicking a @req tag on a test card focuses + scrolls to that requirement', async () => {
    const scrollSpy = vi.fn()
    // happy-dom has no scrollIntoView; provide one so the focus effect can run.
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy
    await mount()
    const tag = container.querySelector<HTMLButtonElement>('[data-testid="reqtag-adds item-R1"]')
    expect(tag).toBeTruthy()
    act(() => { tag?.click() })
    expect(container.querySelector('[data-testid="req-R1"]')?.getAttribute('data-focus')).toBe('true')
    expect(scrollSpy).toHaveBeenCalled()
  })

  it('clicking a @req tag lifts a gap filter that hides the target requirement', async () => {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn()
    await mount()
    // Filter to covered → R1 (path-incomplete) is hidden.
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="gap-badge-covered"]')?.click() })
    expect(container.querySelector('[data-testid="req-R1"]')).toBeNull()
    // Clicking @req-R1 on its test lifts the filter so R1 is reachable + focused.
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="reqtag-adds item-R1"]')?.click() })
    expect(container.querySelector('[data-testid="req-R1"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="req-R1"]')?.getAttribute('data-focus')).toBe('true')
  })

  it('numbers test cards by source order (shared cross-view id)', async () => {
    await mount()
    // cart.spec.ts:10 → #1, receipt.spec.ts:5 → #2 (sorted by file then line).
    expect(container.querySelector('[data-testid="test-adds item"]')?.textContent).toContain('#1')
    expect(container.querySelector('[data-testid="test-sends receipt"]')?.textContent).toContain('#2')
  })

  it('shows gap badges with counts and the drift indicator (in the docs rail)', async () => {
    await mount()
    expect(container.querySelector('[data-testid="gap-badge-untested"]')?.textContent).toContain('1')
    expect(container.querySelector('[data-testid="gap-badge-path-incomplete"]')?.textContent).toContain('1')
    expect(container.querySelector('[data-testid="docs-rail-drift"]')).toBeTruthy()
  })

  it('shows the derived state headline and names the changed docs (R22 — drift in the rail)', async () => {
    await mount()
    expect(container.querySelector('[data-testid="coverage-state-headline"]')?.textContent).toBe('Stale')
    expect(container.querySelector('[data-testid="docs-rail-drift"]')?.textContent).toContain('prd.md changed')
    expect(container.querySelector('[data-testid="docs-rail-drift"]')?.textContent).toContain('PRD summary + coverage ledger')
  })

  it('renders the unified layout: docs rail + requirements + tests, no tabs (R22)', async () => {
    await mount()
    expect(container.querySelector('[data-testid="docs-rail"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="prd-pane"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="tests-pane"]')).toBeTruthy()
    expect(container.querySelector('[role="tablist"]')).toBeNull()
  })

  it('orders requirements worst-first (uncovered before partial)', async () => {
    await mount()
    const cards = Array.from(container.querySelectorAll('[data-testid="prd-pane"] [data-testid^="req-"]'))
    expect(cards[0]?.getAttribute('data-testid')).toBe('req-R3') // untested/uncovered first
  })

  it('shows a per-test strength chip', async () => {
    await mount()
    expect(container.querySelector('[data-testid="strength-adds item"]')?.textContent).toContain('Solid')
    expect(container.querySelector('[data-testid="strength-sends receipt"]')?.textContent).toContain('Shallow')
  })

  it('filters the tests pane by strength', async () => {
    await mount()
    // Both tests visible initially.
    expect(container.querySelector('[data-testid="test-adds item"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="test-sends receipt"]')).toBeTruthy()
    // Filter to Shallow → only the shallow test remains.
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="strength-badge-shallow"]')?.click() })
    expect(container.querySelector('[data-testid="test-sends receipt"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="test-adds item"]')).toBeNull()
    // Toggling off restores both.
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="strength-badge-shallow"]')?.click() })
    expect(container.querySelector('[data-testid="test-adds item"]')).toBeTruthy()
  })

  it('surfaces covers tags on the test card (R9)', async () => {
    await mount()
    expect(container.querySelector('[data-testid="test-adds item"]')?.textContent).toContain('@req-R1')
    expect(container.querySelector('[data-testid="test-adds item"]')?.textContent).toContain('@path-happy')
  })

  it('hovering a test lights its requirement and dims the rest (two-way highlight)', async () => {
    await mount()
    fire(container.querySelector('[data-testid="test-adds item"]'), 'enter')
    expect(container.querySelector('[data-testid="req-R1"]')?.getAttribute('data-active')).toBe('true')
    expect(container.querySelector('[data-testid="req-R2"]')?.getAttribute('data-active')).toBe('false')
    fire(container.querySelector('[data-testid="test-adds item"]'), 'leave')
    expect(container.querySelector('[data-testid="req-R1"]')?.getAttribute('data-active')).toBe('false')
  })

  it('hovering a requirement lights its tests', async () => {
    await mount()
    fire(container.querySelector('[data-testid="req-R2"]'), 'enter')
    expect(container.querySelector('[data-testid="test-sends receipt"]')?.getAttribute('data-active')).toBe('true')
    expect(container.querySelector('[data-testid="test-adds item"]')?.getAttribute('data-active')).toBe('false')
  })

  it('clicking a gap badge filters the requirements pane', async () => {
    await mount()
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="gap-badge-untested"]')?.click() })
    expect(container.querySelector('[data-testid="req-R3"]')).toBeTruthy() // untested
    expect(container.querySelector('[data-testid="req-R1"]')).toBeNull() // filtered out
  })

  it('Generate (summary-absent) starts an async job (which chains coverage)', async () => {
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(ABSENT_LEDGER))
    vi.mocked(api.startCoverageJob).mockResolvedValue({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'now', log: '' })
    vi.mocked(api.getCoverageJob).mockResolvedValue({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'now', log: 'done' })
    await mount()
    // The rail loads its doc list async; flush so its generate button renders.
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="generate-summary"]')?.click()
      await Promise.resolve()
    })
    expect(api.startCoverageJob).toHaveBeenCalledWith('checkout', 'summary')
  })

  it('shows the dedicated Generating screen while a job runs, not the ledger (R13)', async () => {
    let resolveJob: ((m: import('../../../shared/api/types').CoverageJobManifest) => void) | null = null
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(ABSENT_LEDGER))
    vi.mocked(api.startCoverageJob).mockResolvedValue({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'running', startedAt: 'now', log: 'summarizing…' })
    vi.mocked(api.getCoverageJob).mockImplementation(() => new Promise((res) => { resolveJob = res }))
    await mount()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="generate-summary"]')?.click()
      await Promise.resolve()
    })
    // The generating pane owns the screen; the ledger panes are gone.
    expect(container.querySelector('[data-testid="coverage-generating"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="prd-pane"]')).toBeNull()
    expect(container.querySelector('[data-testid="generating-phases"]')).toBeTruthy()
    // Avoid leaking the pending getCoverageJob promise.
    resolveJob?.({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'now', log: 'done' })
  })

  it('puts the Tests pane (3rd column) in a loading state while generating — skeleton cards, no real test cases', async () => {
    let resolveJob: ((m: import('../../../shared/api/types').CoverageJobManifest) => void) | null = null
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(ABSENT_LEDGER))
    vi.mocked(api.startCoverageJob).mockResolvedValue({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'running', startedAt: 'now', log: 'summarizing…' })
    vi.mocked(api.getCoverageJob).mockImplementation(() => new Promise((res) => { resolveJob = res }))
    await mount()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="generate-summary"]')?.click()
      await Promise.resolve()
    })
    // Tests pane stays mounted, but the whole mapping is being recomputed, so the
    // test cards are held back entirely: a mapping note + placeholder skeleton
    // cards, NOT the real test names/chips that would read as "already done".
    expect(container.querySelector('[data-testid="tests-pane"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="tests-remapping-note"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="test-skeleton"]').length).toBeGreaterThan(0)
    expect(container.querySelector('[data-testid="test-adds item"]')).toBeNull()
    expect(container.querySelector('[data-testid="orphan-tests-note"]')).toBeNull()
    // Avoid leaking the pending getCoverageJob promise.
    resolveJob?.({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'now', log: 'done' })
  })

  it('re-lists the rail docs when generation completes so the generated PRD doc appears (items 1+2)', async () => {
    // A summary job that completes and chains a coverage job, which also completes.
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(ABSENT_LEDGER))
    vi.mocked(api.startCoverageJob).mockResolvedValue({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'running', startedAt: 'now', log: '' })
    vi.mocked(api.getCoverageJob).mockImplementation(async (id: string) => (
      id === 'j1'
        ? { jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done', chainedJobId: 'j2', startedAt: 'now', log: 'summary done' }
        : { jobId: 'j2', feature: 'checkout', kind: 'coverage', status: 'done', startedAt: 'now', log: 'coverage done' }
    ))
    await mount()
    await act(async () => { await Promise.resolve() })
    const before = vi.mocked(api.listFeatureDocs).mock.calls.length
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="generate-summary"]')?.click()
      await Promise.resolve()
    })
    // Flush the pollJob chain + the rail's reload effect.
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
    // The rail re-fetched its doc list on completion — no manual refresh needed,
    // so the generated _prd-summary.md pill shows up live.
    expect(vi.mocked(api.listFeatureDocs).mock.calls.length).toBeGreaterThan(before)
  })

  it('rehydrates a running job on mount so a refresh restores the Generating screen (R18)', async () => {
    // Server says a coverage job is still running for this feature.
    vi.mocked(api.listCoverageJobs).mockResolvedValue([
      { jobId: 'jX', feature: 'checkout', kind: 'coverage', status: 'running', startedAt: '2026-01-01T00:00:01Z' },
    ])
    let resolveJob: ((m: import('../../../shared/api/types').CoverageJobManifest) => void) | null = null
    vi.mocked(api.getCoverageJob).mockImplementation(() => new Promise((res) => { resolveJob = res }))
    await mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // Without any click, the Generating screen is restored from the running job.
    expect(api.listCoverageJobs).toHaveBeenCalledWith('checkout')
    expect(container.querySelector('[data-testid="coverage-generating"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="prd-pane"]')).toBeNull()
    resolveJob?.({ jobId: 'jX', feature: 'checkout', kind: 'coverage', status: 'done', startedAt: '2026-01-01T00:00:01Z', log: 'done' })
  })

  it('self-heals a wedged poll: a hung getCoverageJob never leaves the Generating screen stuck', async () => {
    vi.useFakeTimers()
    try {
      // Rehydrate finds a running job; the per-job poll then HANGS forever (the real
      // bug: a getCoverageJob fetch that never resolves wedges the setTimeout chain).
      // Meanwhile the authoritative job index shows the job actually finished.
      vi.mocked(api.listCoverageJobs)
        .mockResolvedValueOnce([{ jobId: 'jW', feature: 'checkout', kind: 'coverage', status: 'running', startedAt: '2026-01-01T00:00:01Z' }])
        .mockResolvedValue([{ jobId: 'jW', feature: 'checkout', kind: 'coverage', status: 'done', startedAt: '2026-01-01T00:00:01Z', endedAt: '2026-01-01T00:01:00Z' }])
      vi.mocked(api.getCoverageJob).mockImplementation(() => new Promise(() => {})) // never resolves → wedge
      await act(async () => { root.render(<CoverageLedgerPage feature="checkout" onClose={() => {}} />) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      // Generating screen is up and the poll is wedged.
      expect(container.querySelector('[data-testid="coverage-generating"]')).toBeTruthy()
      expect(container.querySelector('[data-testid="prd-pane"]')).toBeNull()
      // The reconcile backstop (3s interval) sees "no running job" on two consecutive
      // checks and clears the screen — without the wedged poll ever resolving.
      await act(async () => { await vi.advanceTimersByTimeAsync(7000) })
      expect(container.querySelector('[data-testid="coverage-generating"]')).toBeNull()
      expect(container.querySelector('[data-testid="prd-pane"]')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the requirement kind without expanding the card', async () => {
    await mount()
    // Kind lives on the always-visible header, not behind the disclosure.
    expect(container.querySelector('[data-testid="req-detail-R1"]')).toBeNull()
    expect(container.querySelector('[data-testid="kind-R1"]')?.textContent).toContain('Functional')
  })

  it('expands a requirement to reveal its happy/unhappy paths', async () => {
    await mount()
    // Collapsed: the detail block is absent.
    expect(container.querySelector('[data-testid="req-detail-R1"]')).toBeNull()
    act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R1"]')?.click() })
    const detail = container.querySelector('[data-testid="req-detail-R1"]')
    expect(detail?.textContent).toContain('item appears in the cart')
    expect(detail?.textContent).toContain('out-of-stock item is rejected')
    // Kind is no longer duplicated inside the detail (it's on the header now).
    expect(detail?.textContent).not.toContain('Functional')
    // Toggling again collapses it.
    act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R1"]')?.click() })
    expect(container.querySelector('[data-testid="req-detail-R1"]')).toBeNull()
  })

  it('hides an N/A path block instead of rendering a hollow "N/A"', async () => {
    const led = structuredClone(LEDGER)
    led.requirements[0].requirement.happyPath = 'token matches the pattern'
    led.requirements[0].requirement.unhappyPath = 'N/A — internal bug, format tests catch it'
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(led)
    await mount()
    act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R1"]')?.click() })
    const detail = container.querySelector('[data-testid="req-detail-R1"]')
    expect(detail?.textContent).toContain('token matches the pattern')
    expect(detail?.textContent).not.toContain('N/A')
    expect(detail?.textContent).not.toContain('Unhappy path')
  })

  it('does not make a card expandable when every path prose is N/A', async () => {
    const led = structuredClone(LEDGER)
    led.requirements[0].requirement.happyPath = 'N/A'
    led.requirements[0].requirement.unhappyPath = 'n/a — nothing to assert'
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(led)
    await mount()
    expect(container.querySelector('[data-testid="req-toggle-R1"]')).toBeNull()
  })

  it('offers no expand toggle for a requirement with no extra detail', async () => {
    await mount()
    // R3 has no kind/happyPath/unhappyPath → not disclosable.
    expect(container.querySelector('[data-testid="req-toggle-R3"]')).toBeNull()
  })

  it('expands a test to fetch and render its source, lazily', async () => {
    await mount()
    // Not fetched until first expand.
    expect(api.getFeatureTests).not.toHaveBeenCalled()
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="test-toggle-adds item"]')?.click()
      await Promise.resolve()
    })
    expect(api.getFeatureTests).toHaveBeenCalledWith('checkout')
    const src = container.querySelector('[data-testid="test-source-adds item"]')
    expect(src?.textContent).toContain('await page.goto("/cart")')
    expect(src?.textContent).toContain('expect(items).toHaveLength(1)')
  })

  it('opens the test in the editor at its source location', async () => {
    await mount()
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="test-toggle-adds item"]')?.click()
      await Promise.resolve()
    })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="test-open-editor-adds item"]')?.click() })
    expect(api.openEditor).toHaveBeenCalledWith({ file: '/repo/features/checkout/e2e/cart.spec.ts', line: 10 })
  })

  it('shows a not-found note when a test has no extractable source', async () => {
    await mount()
    // 'sends receipt' (receipt.spec.ts:5) is absent from the getFeatureTests mock.
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="test-toggle-sends receipt"]')?.click()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="test-source-sends receipt"]')?.textContent).toContain('Source not found')
  })
})

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
    expect(api.startCoverageJob).toHaveBeenCalledWith('checkout', 'summary')
  })
})

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
