// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../../shared/api/client'
import type { CoverageLedger } from '../../../shared/api/types'
import { CoverageLedgerPage } from './CoverageLedgerPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  }
})

const LEDGER: CoverageLedger = {
  feature: 'checkout',
  requirements: [
    {
      requirement: { id: 'R1', title: 'Add to cart', text: 'user can add an item', pathTypes: ['happy', 'sad'] },
      annotatedTestNames: ['adds item'],
      verifiedTestNames: ['adds item'],
      pathCoverage: [{ path: 'happy', verified: true }, { path: 'sad', verified: false }],
      gapType: 'path-incomplete',
      coverageStatus: 'partial',
      lastPassingRun: { testName: 'adds item', runId: 'r1', env: 'local', at: '2026-01-01' },
    },
    {
      requirement: { id: 'R2', title: 'Send receipt', text: 'send a receipt email', pathTypes: ['happy'], strictnessLadder: [{ tier: 1, description: 'log' }, { tier: 4, description: 'browser at mailbox' }] },
      annotatedTestNames: ['sends receipt'],
      verifiedTestNames: ['sends receipt'],
      pathCoverage: [{ path: 'happy', verified: true }],
      gapType: 'shallow-verified',
      coverageStatus: 'partial',
      lastPassingRun: { testName: 'sends receipt', runId: 'r2', at: '2026-01-02' },
      rigor: { tierReached: 1, tierAvailable: 4, strictness: 0.25, weakestAssertion: "fs.readFileSync('app.log')", suggestedStrongerCheck: 'browser at mailbox' },
    },
    {
      requirement: { id: 'R3', title: 'Apply coupon', text: 'coupon reduces total', pathTypes: ['happy'] },
      annotatedTestNames: [],
      verifiedTestNames: [],
      pathCoverage: [{ path: 'happy', verified: false }],
      gapType: 'untested',
      coverageStatus: 'uncovered',
    },
  ],
  tests: [
    { name: 'adds item', requirements: ['R1'], pathTypes: ['happy'], verified: true, lastPassingRun: { testName: 'adds item', runId: 'r1', at: '2026-01-01' }, file: 'e2e/cart.spec.ts', line: 10 },
    { name: 'sends receipt', requirements: ['R2'], pathTypes: ['happy'], verified: true, file: 'e2e/receipt.spec.ts', line: 5 },
  ],
  totals: { total: 3, verified: 2, untested: 1, unverified: 0, pathIncomplete: 1, shallowVerified: 1, orphanTests: 0 },
  coveragePct: 66.7,
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
  it('renders requirements, tests, and the coverage %', async () => {
    await mount()
    expect(container.querySelector('[data-testid="req-R1"]')?.textContent).toContain('Add to cart')
    expect(container.querySelector('[data-testid="test-adds item"]')?.textContent).toContain('adds item')
    expect(container.querySelector('[data-testid="coverage-ring"]')?.getAttribute('aria-label')).toBe('66.7% verified')
  })

  it('shows gap badges with counts and the drift indicator (in the docs rail)', async () => {
    await mount()
    expect(container.querySelector('[data-testid="gap-badge-untested"]')?.textContent).toContain('1')
    expect(container.querySelector('[data-testid="gap-badge-path-incomplete"]')?.textContent).toContain('1')
    expect(container.querySelector('[data-testid="gap-badge-shallow-verified"]')?.textContent).toContain('1')
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

  it('shows a strictness badge for a shallow-verified requirement', async () => {
    await mount()
    const badge = container.querySelector('[data-testid="strictness-R2"]')
    expect(badge?.textContent).toContain('tier 1/4')
    expect(badge?.getAttribute('title')).toContain('browser at mailbox')
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

  it('Regenerate summary starts an async job (which chains coverage)', async () => {
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

  it('puts the Tests pane (3rd column) in a loading state while generating — skeleton mapping, not stale chips', async () => {
    let resolveJob: ((m: import('../../../shared/api/types').CoverageJobManifest) => void) | null = null
    vi.mocked(api.startCoverageJob).mockResolvedValue({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'running', startedAt: 'now', log: 'summarizing…' })
    vi.mocked(api.getCoverageJob).mockImplementation(() => new Promise((res) => { resolveJob = res }))
    await mount()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="generate-summary"]')?.click()
      await Promise.resolve()
    })
    // Tests pane stays mounted (the test SET doesn't change)…
    expect(container.querySelector('[data-testid="tests-pane"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="test-adds item"]')).toBeTruthy()
    // …but the mapping it shows is being recomputed: skeleton chips + a remapping
    // note, NOT the stale @req chips that would read as "already done".
    expect(container.querySelector('[data-testid="tests-remapping-note"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="test-mapping-loading-adds item"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="test-adds item"]')?.textContent).not.toContain('@req-R1')
    expect(container.querySelector('[data-testid="orphan-tests-note"]')).toBeNull()
    // Avoid leaking the pending getCoverageJob promise.
    resolveJob?.({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'now', log: 'done' })
  })

  it('re-lists the rail docs when generation completes so the generated PRD doc appears (items 1+2)', async () => {
    // A summary job that completes and chains a coverage job, which also completes.
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
})

const EMPTY_LEDGER: CoverageLedger = {
  feature: 'checkout',
  requirements: [],
  tests: [],
  totals: { total: 0, verified: 0, untested: 0, unverified: 0, pathIncomplete: 0, shallowVerified: 0, orphanTests: 0 },
  coveragePct: 0,
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
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [{ relPath: 'spec.md', generated: false, sizeBytes: 9 }], hasPrdSummary: false, sourceDocCount: 1, docsDrift: false })
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
