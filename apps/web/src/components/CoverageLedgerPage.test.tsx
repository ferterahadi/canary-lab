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
  return { ...actual, getFeatureCoverage: vi.fn(), listFeatureDocs: vi.fn(), regeneratePrdSummary: vi.fn() }
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
      lastPassingRun: { testName: 'adds item', runId: 'r1', env: 'local', at: '2026-01-01' },
    },
    {
      requirement: { id: 'R2', title: 'Send receipt', text: 'send a receipt email', pathTypes: ['happy'], strictnessLadder: [{ tier: 1, description: 'log' }, { tier: 4, description: 'browser at mailbox' }] },
      annotatedTestNames: ['sends receipt'],
      verifiedTestNames: ['sends receipt'],
      pathCoverage: [{ path: 'happy', verified: true }],
      gapType: 'shallow-verified',
      lastPassingRun: { testName: 'sends receipt', runId: 'r2', at: '2026-01-02' },
      rigor: { tierReached: 1, tierAvailable: 4, strictness: 0.25, weakestAssertion: "fs.readFileSync('app.log')", suggestedStrongerCheck: 'browser at mailbox' },
    },
    {
      requirement: { id: 'R3', title: 'Apply coupon', text: 'coupon reduces total', pathTypes: ['happy'] },
      annotatedTestNames: [],
      verifiedTestNames: [],
      pathCoverage: [{ path: 'happy', verified: false }],
      gapType: 'untested',
    },
  ],
  tests: [
    { name: 'adds item', requirements: ['R1'], pathTypes: ['happy'], verified: true, lastPassingRun: { testName: 'adds item', runId: 'r1', at: '2026-01-01' }, file: 'e2e/cart.spec.ts', line: 10 },
    { name: 'sends receipt', requirements: ['R2'], pathTypes: ['happy'], verified: true, file: 'e2e/receipt.spec.ts', line: 5 },
  ],
  totals: { total: 3, verified: 2, untested: 1, unverified: 0, pathIncomplete: 1, shallowVerified: 1 },
  coveragePct: 66.7,
  orphanRequirementIds: [],
  docsDrift: true,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(LEDGER))
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

  it('shows a strictness badge for a shallow-verified requirement', async () => {
    await mount()
    const badge = container.querySelector('[data-testid="strictness-R2"]')
    expect(badge?.textContent).toContain('tier 1/4')
    expect(badge?.getAttribute('title')).toContain('browser at mailbox')
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
})
