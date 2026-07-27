// @vitest-environment happy-dom

import { act } from 'react'
import type { CoverageLedger } from '@/shared/api/types'
import { root } from '../CoverageLedgerPage.part2.test'

export const LEDGER: CoverageLedger = {
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
export const ABSENT_LEDGER: CoverageLedger = {
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

// React synthesizes onMouseEnter/onMouseLeave from the delegated native
// mouseover/mouseout events, so dispatch those (bubbling) rather than raw
// mouseenter/mouseleave (which React's root listener never sees).
export function fire(el: Element | null | undefined, kind: 'enter' | 'leave') {
  if (!el) throw new Error('element not found')
  const type = kind === 'enter' ? 'mouseover' : 'mouseout'
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true })) })
}
