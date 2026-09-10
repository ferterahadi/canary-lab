// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { readableTest } from '@/shared/api/__fixtures__/readable-test'
import { CoverageLedgerPage } from './CoverageLedgerPage'

;
import { ABSENT_LEDGER, LEDGER, fire } from './__fixtures__/CoverageLedgerPage.part2-fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// TestCard expands to the shared ShikiCode block, which lazily imports Shiki.
// Mock the modules (same as TestCasesColumn.test) so the highlighter resolves
// deterministically with line spans instead of loading the real wasm.
vi.mock('shiki/core', () => ({
  createHighlighterCore: async () => ({
    getTheme: () => ({}),
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
    acceptRequirementWording: vi.fn(),
  }
})

let container: HTMLDivElement

export let root: Root

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
    {
      file: '/repo/features/checkout/e2e/cart.spec.ts',
      tests: [{
        name: 'adds item',
        line: 10,
        bodySource: 'await page.goto("/cart")\nexpect(items).toHaveLength(1)',
        steps: [],
        readable: readableTest('adds item', [{
          id: 'open-cart',
          kind: 'leaf',
          role: 'action',
          text: 'Open “/cart”',
          fidelity: 'derived',
          source: {
            file: '/repo/features/checkout/e2e/cart.spec.ts',
            startLine: 10,
            endLine: 10,
            snippet: 'await page.goto("/cart")',
          },
        }]),
      }],
    },
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

  it('shows the gap as segments + a fraction at rest, and names the missing path via the chips once expanded', async () => {
    await mount()
    // R1: happy claimed, sad declared but unclaimed. At rest that is two segments
    // (one filled) and "1/2"; the gap class is the tooltip, not a chip.
    const cov = container.querySelector('[data-testid="cov-R1"]')
    expect([...cov!.querySelectorAll('[data-seg]')].map((el) => el.getAttribute('data-seg'))).toEqual(['on', 'off'])
    expect(cov?.textContent).toContain('1/2')
    expect(cov?.getAttribute('title')).toContain('Path gap')
    expect(container.querySelector('[data-testid="gap-R1"]')).toBeNull()
    // The path chips live in the detail: covered shows a ✓, uncovered just the name.
    expect(container.querySelector('[data-testid="path-R1-happy"]')).toBeNull()
    act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R1"]')?.click() })
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

  it('shows a per-test strength dot whose tooltip names the tier', async () => {
    await mount()
    const solid = container.querySelector<HTMLElement>('[data-testid="strength-adds item"]')
    const shallow = container.querySelector<HTMLElement>('[data-testid="strength-sends receipt"]')
    expect(solid?.title).toContain('Solid')
    expect(shallow?.title).toContain('Shallow')
    expect(solid?.textContent).toBe('')
    expect(solid?.style.background).toBe('var(--accent)')
    expect(shallow?.style.background).toBe('var(--danger)')
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

  it('surfaces the requirement + path a test claims as one mono strip, without the @ annotation syntax (R9)', async () => {
    await mount()
    const row = container.querySelector('[data-testid="test-adds item"]')
    expect(row?.querySelector('[data-testid="reqtag-adds item-R1"]')?.textContent).toBe('R1')
    expect(row?.textContent).toContain('happy')
    expect(row?.textContent).not.toContain('@req-')
    expect(row?.textContent).not.toContain('@path-')
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
    expect(api.startCoverageJob).toHaveBeenCalledWith('checkout', 'summary', undefined)
  })

  it('shows the dedicated Generating screen while a job runs, not the ledger (R13)', async () => {
    let resolveJob: (m: import('@/shared/api/types').CoverageJobManifest) => void = () => {}
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
    resolveJob({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'now', log: 'done' })
  })

  it('puts the Tests pane (3rd column) in a loading state while generating — skeleton cards, no real test cases', async () => {
    let resolveJob: (m: import('@/shared/api/types').CoverageJobManifest) => void = () => {}
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
    resolveJob({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'now', log: 'done' })
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
    let resolveJob: (m: import('@/shared/api/types').CoverageJobManifest) => void = () => {}
    vi.mocked(api.getCoverageJob).mockImplementation(() => new Promise((res) => { resolveJob = res }))
    await mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // Without any click, the Generating screen is restored from the running job.
    expect(api.listCoverageJobs).toHaveBeenCalledWith('checkout')
    expect(container.querySelector('[data-testid="coverage-generating"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="prd-pane"]')).toBeNull()
    resolveJob({ jobId: 'jX', feature: 'checkout', kind: 'coverage', status: 'done', startedAt: '2026-01-01T00:00:01Z', log: 'done' })
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

  it('spends no word on a functional requirement — only Non-functional earns a tag', async () => {
    const led = structuredClone(LEDGER)
    led.requirements[1].requirement.kind = 'non-functional'
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(led)
    await mount()
    expect(container.querySelector('[data-testid="kind-R1"]')).toBeNull()
    expect(container.querySelector('[data-testid="kind-R2"]')?.textContent).toBe('Non-functional')
  })

  it('expands a requirement to reveal its happy/unhappy paths', async () => {
    await mount()
    // Collapsed: the detail block is absent.
    expect(container.querySelector('[data-testid="req-detail-R1"]')).toBeNull()
    act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R1"]')?.click() })
    const detail = container.querySelector('[data-testid="req-detail-R1"]')
    expect(detail?.textContent).toContain('item appears in the cart')
    expect(detail?.textContent).toContain('out-of-stock item is rejected')
    // The detail also carries the requirement text the row keeps behind the caret.
    expect(detail?.textContent).toContain(LEDGER.requirements[0].requirement.text)
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

  it('renders neither prose block when every path prose is N/A — the detail is just text + paths', async () => {
    const led = structuredClone(LEDGER)
    led.requirements[0].requirement.happyPath = 'N/A'
    led.requirements[0].requirement.unhappyPath = 'n/a — nothing to assert'
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(led)
    await mount()
    act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R1"]')?.click() })
    const detail = container.querySelector('[data-testid="req-detail-R1"]')
    expect(detail?.textContent).toContain(led.requirements[0].requirement.text)
    expect(detail?.textContent).not.toContain('N/A')
    expect(detail?.textContent).not.toContain('Happy path')
    expect(detail?.textContent).not.toContain('Unhappy path')
  })

  it('shows every discovered channel title at one declaration and keeps its requirement link', async () => {
    const ledger = structuredClone(LEDGER)
    const template = '${channel}: a new app can read its own empty conversation scope'
    ledger.tests = [{ ...ledger.tests[0], name: template, line: 75 }]
    ledger.requirements[0].annotatedTestNames = [template]
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(ledger)
    const title = (channel: string) => `${channel}: a new app can read its own empty conversation scope`
    vi.mocked(api.getFeatureTests).mockResolvedValue([{
      file: '/repo/features/checkout/e2e/cart.spec.ts',
      tests: ['whatsapp', 'line'].map((channel) => ({
        name: title(channel), line: 75, bodyLine: 75,
        bodySource: '{ expect(response.status()).toBe(200) }', steps: [],
        readable: readableTest(title(channel), []),
      })),
    }])
    await mount()
    expect(api.getFeatureTests).toHaveBeenCalledOnce()
    const pane = container.querySelector('[data-testid="tests-pane"]')!
    expect(pane.textContent).not.toContain('${channel}')
    for (const channel of ['whatsapp', 'line']) {
      const card = pane.querySelector(`[data-testid="test-${title(channel)}"]`)!
      expect(card).toBeTruthy()
      expect(card.querySelector('.clcov-reqtag')?.textContent).toBe('R1')
      await act(async () => { card.querySelector<HTMLElement>('[role="button"]')!.click() })
      expect(card.querySelector('[data-testid="test-presentation"]')).toBeTruthy()
      act(() => { card.querySelector<HTMLButtonElement>('.clcov-reqtag')!.click() })
      expect(container.querySelector('[data-testid="req-R1"]')?.getAttribute('data-focus')).toBe('true')
    }
  })

  it('every requirement expands — its text and path chips always wait behind the caret', async () => {
    await mount()
    // R3 has no kind/happyPath/unhappyPath, but its text and paths still live in the detail.
    act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R3"]')?.click() })
    const detail = container.querySelector('[data-testid="req-detail-R3"]')
    expect(detail?.textContent).toContain(LEDGER.requirements[2].requirement.text)
    expect(detail?.querySelector('[data-testid^="path-R3-"]')).toBeTruthy()
  })

  it('expands a test to fetch its shared English presentation lazily, with Code one action away', async () => {
    await mount()
    // Not fetched until first expand.
    expect(api.getFeatureTests).not.toHaveBeenCalled()
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="test-toggle-adds item"]')?.click()
      await Promise.resolve()
    })
    expect(api.getFeatureTests).toHaveBeenCalledWith('checkout')
    const src = container.querySelector('[data-testid="test-source-adds item"]')
    expect(src?.querySelector('[data-testid="test-presentation-english"]')).not.toBeNull()
    expect(src?.textContent).toContain('Open “/cart”')
    expect(src?.querySelector('[data-testid="test-presentation-code"]')).toBeNull()
    await act(async () => {
      ;(src?.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(src?.textContent).toContain('await page.goto("/cart")')
    expect(src?.textContent).toContain('expect(items).toHaveLength(1)')
  })

  it('places the shared editor action inside both presentation modes and opens the source location', async () => {
    await mount()
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="test-toggle-adds item"]')?.click()
      await Promise.resolve()
    })
    const source = container.querySelector('[data-testid="test-source-adds item"]')
    const english = source?.querySelector('[data-testid="test-presentation-english"]')
    const englishOpenButton = english?.querySelector<HTMLButtonElement>('button[aria-label="Open in editor"]')
    expect(englishOpenButton).not.toBeNull()
    expect(englishOpenButton?.parentElement?.querySelector('.cl-code-shell')).not.toBeNull()
    await act(async () => {
      englishOpenButton?.click()
      await Promise.resolve()
    })
    expect(api.openEditor).toHaveBeenCalledWith({
      file: '/repo/features/checkout/e2e/cart.spec.ts',
      line: 10,
      column: 1,
    })
    vi.mocked(api.openEditor).mockClear()

    await act(async () => {
      ;(source?.querySelector('[data-testid="test-presentation-code-tab"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    const code = source?.querySelector('[data-testid="test-presentation-code"]')
    const openButton = code?.querySelector<HTMLButtonElement>('button[aria-label="Open in editor"]')
    expect(openButton).not.toBeNull()
    expect(openButton?.parentElement?.querySelector('.cl-code-shell')).not.toBeNull()
    await act(async () => {
      openButton?.click()
      await Promise.resolve()
    })
    expect(api.openEditor).toHaveBeenCalledWith({
      file: '/repo/features/checkout/e2e/cart.spec.ts',
      line: 10,
      column: 1,
    })
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

  // --- The time axis (D11) on the page: worst-first sort + the human-only Accept lever. ---

  it('sorts a requirement whose tests were weakened since the proof above every other row', async () => {
    const led = structuredClone(LEDGER)
    led.requirements[1].enforcement = { state: 'tests-weakened', provenAt: { runId: 'run-1', at: '2026-09-02T00:00:00.000Z' }, testsChangedAt: { at: '2026-09-03T00:00:00.000Z', tests: ['sends receipt'], verdict: 'weaker' }, wordingChangedAt: '2026-09-01T00:00:00.000Z', accepted: 'none' }
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(led)
    await mount()
    const ids = [...container.querySelectorAll('[data-testid^="req-R"]')].map((el) => el.getAttribute('data-testid'))
    // R2 is covered — it would sink to the bottom on claim status alone.
    expect(ids[0]).toBe('req-R2')
  })

  it('Accept wording posts the acceptance for that requirement and re-pulls the ledger', async () => {
    const led = structuredClone(LEDGER)
    led.requirements[1].enforcement = { state: 'proven-unchanged', provenAt: { runId: 'run-1', at: '2026-09-02T00:00:00.000Z' }, wordingChangedAt: '2026-09-01T00:00:00.000Z', accepted: 'none' }
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(led)
    vi.mocked(api.acceptRequirementWording).mockResolvedValue({ feature: 'checkout', requirementId: 'R2', acceptedAt: '2026-09-07T00:00:00.000Z', acceptedFingerprint: 'fp' })
    await mount()
    const pulls = vi.mocked(api.getFeatureCoverage).mock.calls.length
    // The lever lives in the expanded detail.
    act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R2"]')?.click() })
    const button = container.querySelector('[data-testid="accept-R2"]') as HTMLButtonElement
    expect(button).toBeTruthy()
    await act(async () => { button.click() })
    await act(async () => { await Promise.resolve() })
    expect(api.acceptRequirementWording).toHaveBeenCalledWith('checkout', 'R2')
    expect(vi.mocked(api.getFeatureCoverage).mock.calls.length).toBeGreaterThan(pulls)
  })

})
