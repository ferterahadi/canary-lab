// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import type { CoverageLedger } from '../api/types'
import { CoverageLedgerPage } from './CoverageLedgerPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getFeatureCoverage: vi.fn(),
    listFeatureDocs: vi.fn(),
    regeneratePrdSummary: vi.fn(),
    startCoverageJob: vi.fn(),
    getCoverageJob: vi.fn(),
    acceptCoverageMapping: vi.fn(),
    rejectCoverageMapping: vi.fn(),
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

  it('shows gap badges with counts and the drift banner', async () => {
    await mount()
    expect(container.querySelector('[data-testid="gap-badge-untested"]')?.textContent).toContain('1')
    expect(container.querySelector('[data-testid="gap-badge-path-incomplete"]')?.textContent).toContain('1')
    expect(container.querySelector('[data-testid="gap-badge-shallow-verified"]')?.textContent).toContain('1')
    expect(container.querySelector('[data-testid="drift-banner"]')).toBeTruthy()
  })

  it('shows the derived state headline and names the changed docs', async () => {
    await mount()
    expect(container.querySelector('[data-testid="coverage-state-headline"]')?.textContent).toBe('Stale')
    expect(container.querySelector('[data-testid="drift-banner"]')?.textContent).toContain('prd.md changed')
    expect(container.querySelector('[data-testid="drift-banner"]')?.textContent).toContain('PRD summary + coverage ledger')
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

  it('Generate summary starts an async job', async () => {
    vi.mocked(api.startCoverageJob).mockResolvedValue({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'now', log: '' })
    vi.mocked(api.getCoverageJob).mockResolvedValue({ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'now', log: 'done' })
    await mount()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="generate-summary"]')?.click()
      await Promise.resolve()
    })
    expect(api.startCoverageJob).toHaveBeenCalledWith('checkout', 'summary', { reviewMode: undefined })
  })

  it('renders proposed mappings and accepting one calls the API', async () => {
    const withProposals = structuredClone(LEDGER)
    withProposals.proposedMappings = [{ testName: 'sends receipt', requirements: ['R2'], source: 'agent', confidence: 0.9 }]
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(withProposals)
    vi.mocked(api.acceptCoverageMapping).mockResolvedValue({ ledger: structuredClone(LEDGER) })
    await mount()
    expect(container.querySelector('[data-testid="proposed-mappings"]')).toBeTruthy()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="accept-sends receipt"]')?.click()
      await Promise.resolve()
    })
    expect(api.acceptCoverageMapping).toHaveBeenCalledWith('checkout', 'sends receipt')
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

describe('CoverageLedgerPage — setup guide (ABSENT summary)', () => {
  it('shows the two-step guide and locks step ② until a doc exists', async () => {
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(EMPTY_LEDGER))
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: false, sourceDocCount: 0, docsDrift: false })
    await mount()
    expect(container.querySelector('[data-testid="coverage-setup-guide"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="setup-step-1"]')?.getAttribute('data-active')).toBe('true')
    expect(container.querySelector<HTMLButtonElement>('[data-testid="setup-generate-summary"]')?.disabled).toBe(true)
  })

  it('unlocks Generate summary once docs exist and starts the job', async () => {
    vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(EMPTY_LEDGER))
    vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [{ relPath: 'spec.md', generated: false, sizeBytes: 9 }], hasPrdSummary: false, sourceDocCount: 1, docsDrift: false })
    vi.mocked(api.startCoverageJob).mockResolvedValue({ jobId: 'j', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'n', log: '' })
    vi.mocked(api.getCoverageJob).mockResolvedValue({ jobId: 'j', feature: 'checkout', kind: 'summary', status: 'done', startedAt: 'n', log: 'done' })
    await mount()
    expect(container.querySelector('[data-testid="setup-step-2"]')?.getAttribute('data-active')).toBe('true')
    const gen = container.querySelector<HTMLButtonElement>('[data-testid="setup-generate-summary"]')
    expect(gen?.disabled).toBe(false)
    await act(async () => { gen?.click(); await Promise.resolve() })
    expect(api.startCoverageJob).toHaveBeenCalledWith('checkout', 'summary', { reviewMode: undefined })
  })
})
