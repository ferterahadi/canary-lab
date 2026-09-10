// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RequirementCoverage, RequirementEnforcement } from '@/shared/api/types'
import { RequirementCard, compareRequirements, verdictView } from './CoverageCards'

// The time axis on a requirement row (D11). The four `EnforcementState` ids are the
// derivation and stay verbatim on the agent surfaces; what a HUMAN reads is
// `verdictView` — one sentence saying what is true and what to do about it. On the
// row that sentence collapses to a dot (shown only when the proof is unhealthy);
// inside the detail it is a short verdict label under the coverage marks.

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function rc(enforcement: RequirementEnforcement | undefined, extra: Partial<RequirementCoverage['requirement']> = {}): RequirementCoverage {
  return {
    requirement: { id: 'R1', title: 'Totals', text: 'The total adds up.', pathTypes: ['happy'], ...extra },
    annotatedTestNames: ['totals add up'],
    pathCoverage: [{ path: 'happy', covered: true, proven: true }],
    gapType: 'covered',
    coverageStatus: 'covered',
    ...(enforcement ? { enforcement } : {}),
  }
}

function render(item: RequirementCoverage): void {
  act(() => {
    root.render(<RequirementCard rc={item} active={false} focused={false} dimmed={false} onHover={() => {}} />)
  })
}

// The verdict line lives in the expanded detail.
function expand(): void {
  act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R1"]')?.click() })
}

const PROVEN: RequirementEnforcement = {
  state: 'proven-unchanged',
  provenAt: { runId: 'run-9', at: '2026-09-03T10:00:00.000Z' },
  testsChangedAt: { at: '2026-09-02T00:00:00.000Z', tests: ['totals add up'], verdict: 'changed', runId: 'run-8' },
  wordingChangedAt: '2026-09-01T00:00:00.000Z',
}

describe('RequirementCard — proof-health dot', () => {
  it.each([
    ['tests-weakened', 'A test was weakened after the proof', 'var(--danger)'],
    ['wording-ahead', 'R1 was rewritten after the proof', 'var(--warning)'],
    ['proof-stale', 'Proof out of date', 'var(--warning)'],
  ] as const)('%s renders as a wordless dot whose tooltip leads with "%s"', (state, label, color) => {
    render(rc({ ...PROVEN, state }))
    const dot = container.querySelector('[data-testid="enf-R1"]') as HTMLElement
    expect(dot.textContent).toBe('')
    expect(dot.style.background).toBe(color)
    expect(dot.title.split('\n')[0]).toBe(label)
  })

  it('a healthy proof renders no dot at all — absence is the good state', () => {
    render(rc(PROVEN))
    expect(container.querySelector('[data-testid="enf-R1"]')).toBeNull()
  })

  // The bug this pins: `wording-ahead` is the default state for a requirement that
  // has never been proven (never-proven reads as −∞), so a suite that has simply
  // never run earned an amber dot on every row — 41 of 41 on cns-wa-merchant —
  // next to hollow squares that already said the same thing.
  it('an unclaimed requirement gets no dot — its hollow squares already are the gap', () => {
    render({ ...rc({ ...PROVEN, state: 'wording-ahead', provenAt: undefined }), gapType: 'untested', coverageStatus: 'uncovered', pathCoverage: [{ path: 'happy', covered: false }] })
    expect(container.querySelector('[data-testid="enf-R1"]')).toBeNull()
  })

  // A weakened test is the one state that outranks the claim status: the assertion
  // that used to hold is gone, and no amount of "it was never covered" excuses it.
  it('a weakened test still shows its dot on an unclaimed requirement', () => {
    render({ ...rc({ ...PROVEN, state: 'tests-weakened' }), gapType: 'path-incomplete', coverageStatus: 'partial' })
    expect(container.querySelector('[data-testid="enf-R1"]')).not.toBeNull()
  })

  it('the tooltip carries the three dates behind the verdict, so the dot is the whole story on hover', () => {
    render(rc({ ...PROVEN, state: 'proof-stale' }))
    const title = (container.querySelector('[data-testid="enf-R1"]') as HTMLElement).title
    expect(title).toContain('Proven in run run-9 · 2026-09-03')
    expect(title).toContain('Tests changed 2026-09-02 (changed)')
    expect(title).toContain('Wording changed 2026-09-01')
  })

  it('a ledger without the axis (an older server) renders no dot and no verdict line', () => {
    render(rc(undefined))
    expand()
    expect(container.querySelector('[data-testid="enf-R1"]')).toBeNull()
    expect(container.querySelector('[data-testid="proof-verdict-R1"]')).toBeNull()
  })
})

describe('RequirementCard — the verdict line', () => {
  const verdict = () => (container.querySelector('[data-testid="proof-verdict-R1"]') as HTMLElement).textContent ?? ''

  it('shows only the conclusion without the trailing explanation', () => {
    render(rc(PROVEN))
    expand()
    expect(verdict()).toBe('Proven')
    expect(container.querySelector('.clcov-verdict-help')).toBeNull()
  })

  it('keeps all three dates on the mark, where they are one hover away', () => {
    render(rc(PROVEN))
    expand()
    const dot = container.querySelector('[data-testid="proof-verdict-R1"] .clcov-verdict-dot') as HTMLElement
    expect(dot.title).toContain('Last proved 2026-09-03 · run run-9')
    expect(dot.title).toContain('Tests changed 2026-09-02 (changed)')
    expect(dot.title).toContain('Wording last written 2026-09-01')
  })

  // Never proven is not "the wording ran ahead" — there is nothing for it to be
  // ahead OF. The state id stays `wording-ahead` for the agents; the human reads why.
  it('a never-proven requirement says so, rather than blaming a wording change that never happened', () => {
    render(rc({ state: 'wording-ahead', wordingChangedAt: '2026-09-01T00:00:00.000Z' }))
    expand()
    expect(verdict()).toBe('Not proven yet')
    expect(verdict()).not.toContain('rewritten')
  })

  it('an unclaimed requirement keeps its short verdict and hollow mark', () => {
    render({
      ...rc({ ...PROVEN, state: 'wording-ahead' }),
      gapType: 'path-incomplete',
      coverageStatus: 'partial',
      pathCoverage: [{ path: 'happy', covered: true, proven: true }, { path: 'sad', covered: false }],
    })
    expand()
    expect(verdict()).toBe('Not provable yet')
    expect((container.querySelector('[data-testid="proof-verdict-R1"] .clcov-verdict-dot') as HTMLElement).dataset.hollow).toBe('true')
  })

  it('a weakened test keeps its warning, with the explanation on the row dot', () => {
    render(rc({ ...PROVEN, state: 'tests-weakened' }))
    expand()
    expect(verdict()).toBe('A test was weakened after the proof')
    const tooltip = (container.querySelector('[data-testid="enf-R1"]') as HTMLElement).title
    expect(tooltip).toContain('totals add up changed 2026-09-02')
    expect(tooltip).toContain("Restore the assertion — rerunning won't fix this.")
  })

  it('a stale proof keeps its label, with the explanation on the row dot', () => {
    render(rc({ ...PROVEN, state: 'proof-stale' }))
    expand()
    expect(verdict()).toBe('Proof out of date')
    expect((container.querySelector('[data-testid="enf-R1"]') as HTMLElement).title).toContain('totals add up changed 2026-09-02, after run run-9 (2026-09-03) proved this. Rerun to re-prove.')
  })

  it('falls back to a testless sentence when the ledger records no test change', () => {
    const v = verdictView(rc({ ...PROVEN, state: 'proof-stale', testsChangedAt: undefined }), { ...PROVEN, state: 'proof-stale', testsChangedAt: undefined })
    expect(v.detail).toBe('run run-9 (2026-09-03) no longer covers the current tests. Rerun to re-prove.')
  })

  it('names every uncovered case when several are missing, and falls back when it can name none', () => {
    const bare: RequirementCoverage = { ...rc(PROVEN), gapType: 'untested', coverageStatus: 'uncovered', pathCoverage: [] }
    expect(verdictView(bare, PROVEN).detail).toBe('No test maps to this requirement.')
    const two: RequirementCoverage = {
      ...bare,
      pathCoverage: [{ path: 'happy', covered: false }, { path: 'sad', covered: false }],
    }
    expect(verdictView(two, PROVEN).detail).toBe('happy and sad have no test.')
  })

  it('a weakened test with no recorded change still reads as the state it is in', () => {
    const e: RequirementEnforcement = { ...PROVEN, state: 'tests-weakened', testsChangedAt: undefined }
    expect(verdictView(rc(e), e).label).toBe('Proof out of date')
  })

  it('a weakened test that was never proven says so without inventing a run', () => {
    const e: RequirementEnforcement = { ...PROVEN, state: 'tests-weakened', provenAt: undefined }
    expect(verdictView(rc(e), e).detail).toBe("totals add up changed 2026-09-02. Restore the assertion — rerunning won't fix this.")
  })
})

describe('RequirementCard — no wording byline', () => {
  it.each([
    { doc: 'checkout.md', heading: 'Totals', line: 12 },
    { doc: 'checkout.md' },
    undefined,
  ])('omits the source byline for %j while retaining the requirement text', (source) => {
    render(rc(PROVEN, { source }))
    expand()
    const detail = container.querySelector('[data-testid="req-detail-R1"]') as HTMLElement
    expect(detail.children[0].textContent).toBe('The total adds up.')
    expect(container.querySelector('[data-testid="byline-R1"]')).toBeNull()
    expect(detail.textContent).not.toContain('checkout.md')
    expect(detail.textContent).not.toContain('Drafted by an agent')
  })

  it('ignores old confirmation metadata while retaining the proof verdict', () => {
    const item = rc(PROVEN, { source: { doc: 'checkout.md', heading: 'Totals' } })
    // Older persisted summaries can carry these retired fields during an upgrade.
    Object.assign(item.requirement, { acceptedAt: '2026-09-02T00:00:00.000Z', acceptedFingerprint: 'old' })
    Object.assign(item.enforcement!, { accepted: 'outdated' })
    render(item)
    expand()
    expect(container.textContent).not.toContain('confirmed')
    expect(container.textContent).not.toContain('checkout.md')
    expect(container.querySelector('[data-testid="accept-R1"]')).toBeNull()
    expect(container.querySelector('[data-testid="proof-verdict-R1"]')?.textContent).toBe('Proven')
  })

  it('also omits the byline and confirmation control without the axis', () => {
    render(rc(undefined, { source: { doc: 'checkout.md' } }))
    expand()
    expect(container.querySelector('[data-testid="byline-R1"]')).toBeNull()
    expect(container.textContent).not.toContain('checkout.md')
    expect(container.querySelector('[data-testid="accept-R1"]')).toBeNull()
  })
})

describe('compareRequirements — worst-first', () => {
  const at = (state: RequirementEnforcement['state'], gap: RequirementCoverage['gapType'], status: RequirementCoverage['coverageStatus'], id: string): RequirementCoverage => ({
    ...rc({ ...PROVEN, state }),
    requirement: { id, title: id, text: id, pathTypes: ['happy'] },
    gapType: gap,
    coverageStatus: status,
  })

  it('a weakened test outranks every claim status; then claim status; then the remaining states worst-first', () => {
    const items = [
      at('proven-unchanged', 'covered', 'covered', 'A'),
      at('wording-ahead', 'covered', 'covered', 'B'),
      at('proof-stale', 'covered', 'covered', 'C'),
      at('proven-unchanged', 'untested', 'uncovered', 'D'),
      at('tests-weakened', 'covered', 'covered', 'E'),
      at('wording-ahead', 'path-incomplete', 'partial', 'F'),
    ]
    expect([...items].sort(compareRequirements).map((r) => r.requirement.id)).toEqual(['E', 'D', 'F', 'C', 'B', 'A'])
  })

  it('without the axis the order is the claim-status order, stable within a rank', () => {
    const plain = (gap: RequirementCoverage['gapType'], status: RequirementCoverage['coverageStatus'], id: string): RequirementCoverage => ({
      ...rc(undefined), requirement: { id, title: id, text: id, pathTypes: ['happy'] }, gapType: gap, coverageStatus: status,
    })
    const items = [plain('covered', 'covered', 'A'), plain('untested', 'uncovered', 'B'), plain('covered', 'covered', 'C')]
    expect([...items].sort(compareRequirements).map((r) => r.requirement.id)).toEqual(['B', 'A', 'C'])
  })
})
