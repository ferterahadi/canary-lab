// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoverageLedger } from '@/shared/api/types'
import { CoverageHeader, CoverageRing } from './CoverageHeader'
import { LEDGER } from './__fixtures__/CoverageLedgerPage.part2-fixtures'

// The header's plain-language ratios gain the time axis roll-up (D11):
// "n/N proven in run <id>" beside covered and mapped.

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

function render(
  ledger: CoverageLedger,
  freshness: Partial<NonNullable<CoverageLedger['freshness']>> = {},
): void {
  act(() => {
    root.render(<CoverageHeader ledger={{ ...ledger, freshness: { ...LEDGER.freshness!, state: 'current', reasons: [], ...freshness } }} gapFilter={null} onToggleGap={() => {}} strengthFilter={null} onToggleStrength={() => {}} />)
  })
}

describe('CoverageHeader — proven in run', () => {
  it('states how many requirements are proven unchanged, and by which run', () => {
    const led = structuredClone(LEDGER)
    led.enforcement = { runId: 'run-9', provenUnchanged: 1, total: 3, states: { 'proven-unchanged': 1, 'tests-weakened': 0, 'wording-ahead': 1, 'proof-stale': 1 } }
    render(led)
    const stat = container.querySelector('[data-testid="proven-stat"]')
    expect(stat?.textContent).toContain('1/3 proven in run run-9')
  })

  it('a feature with no run yet says so rather than inventing a run', () => {
    const led = structuredClone(LEDGER)
    // A historical count without a current proof run must not leak into the card.
    led.enforcement = { provenUnchanged: 3, total: 3, states: { 'proven-unchanged': 3, 'tests-weakened': 0, 'wording-ahead': 0, 'proof-stale': 0 } }
    render(led)
    expect(container.querySelector('[data-testid="proven-stat"]')?.textContent).toContain('0/3 proven · no run yet')
  })

  it('an in-progress run uses the same pending proof count and status everywhere', () => {
    const led = structuredClone(LEDGER)
    led.enforcement = { provenUnchanged: 3, total: 3, states: { 'proven-unchanged': 3, 'tests-weakened': 0, 'wording-ahead': 0, 'proof-stale': 0 } }
    render(led, { proofNeedsRun: true, latestRunId: 'run-10', latestRunStatus: 'running' })

    expect(container.querySelector('[data-testid="coverage-proof"]')?.textContent).toBe('run in progress — nothing proven yet')
    expect(container.querySelector('[data-testid="proven-stat"]')?.textContent).toContain('0/3 proven · run in progress')
    expect(container.querySelector('[data-testid="coverage-ring"]')?.getAttribute('aria-label')).toBe('33.3% covered, 0% proven')
  })

  it('an older server without the axis shows no proven stat', () => {
    const led = structuredClone(LEDGER)
    delete led.enforcement
    render(led)
    expect(container.querySelector('[data-testid="proven-stat"]')).toBeNull()
  })
})

// The ring carries the same axis as a PARTITION: grey track = not covered, dimmed
// arc = claimed but unproven, solid arc = proven. The three shares sum to the whole
// circle, which is only sound because `provenUnchanged` can never land on a
// requirement that is not covered.
describe('CoverageRing — one ring, three slices', () => {
  const arcs = () => [...container.querySelectorAll('circle')].slice(1)

  function partitioned(proven: number, covered: number, runId?: string): CoverageLedger {
    const led = structuredClone(LEDGER)
    led.totals.covered = covered
    led.coveragePct = (covered / led.totals.total) * 100
    led.enforcement = {
      ...(runId ? { runId } : {}),
      provenUnchanged: proven,
      total: led.totals.total,
      states: { 'proven-unchanged': proven, 'tests-weakened': 0, 'wording-ahead': 0, 'proof-stale': 0 },
    }
    return led
  }

  it('draws the claimed-only arc behind the solid proven one, so their caps do not clash', () => {
    render(partitioned(1, 2, 'run-9'))
    const [claimed, proof] = arcs()
    expect(claimed.getAttribute('stroke-opacity')).toBe('0.3')
    expect(proof.getAttribute('stroke-opacity')).toBe('1')
    // The proof starts at 12 o'clock; the claim picks up exactly where it ends (1 of 3).
    expect(proof.getAttribute('transform')).toBe('rotate(-90 20 20)')
    expect(claimed.getAttribute('transform')).toBe('rotate(30 20 20)')
  })

  it('names both shares in the label, so the dial never has to be decoded', () => {
    render(partitioned(1, 2, 'run-9'))
    const ring = container.querySelector('[data-testid="coverage-ring"]')
    expect(ring?.getAttribute('aria-label')).toBe('66.66666666666666% covered, 33.3% proven')
  })

  it('a fully proven suite is one solid ring, with no dimmed remainder', () => {
    render(partitioned(2, 2, 'run-9'))
    expect(arcs().length).toBe(1)
    expect(arcs()[0].getAttribute('stroke-opacity')).toBe('1')
  })

  it('a suite that has never run is one pale ring — written, unproven, not in trouble', () => {
    render(partitioned(0, 2))
    expect(arcs().length).toBe(1)
    expect(arcs()[0].getAttribute('stroke-opacity')).toBe('0.3')
  })

  it('a ledger with no time axis keeps the single solid arc it always had', () => {
    const led = structuredClone(LEDGER)
    delete led.enforcement
    render(led)
    expect(arcs().length).toBe(1)
    expect(arcs()[0].getAttribute('stroke-opacity')).toBe('1')
    expect(container.querySelector('[data-testid="coverage-ring"]')?.getAttribute('aria-label')).toBe('33.3% covered')
  })

  it('a proof share can never outrun the covered sweep it sits inside', () => {
    act(() => { root.render(<CoverageRing pct={40} provenPct={90} />) })
    const [claimed] = [...container.querySelectorAll('circle')].slice(1)
    // Clamped to the sweep: one solid arc at 40%, no dimmed remainder to draw.
    expect(container.querySelectorAll('circle').length).toBe(2)
    expect(claimed.getAttribute('stroke-opacity')).toBe('1')
    expect(container.querySelector('[data-testid="coverage-ring"]')?.getAttribute('aria-label')).toBe('40% covered, 40% proven')
  })
})

describe('CoverageHeader — the proof readout at rest', () => {
  const line = () => container.querySelector('[data-testid="coverage-proof"]')

  it("names the ring's two coloured slices in words", () => {
    const led = structuredClone(LEDGER)
    led.totals.covered = 2
    led.enforcement = { runId: 'run-9', provenUnchanged: 1, total: 3, states: { 'proven-unchanged': 1, 'tests-weakened': 0, 'wording-ahead': 1, 'proof-stale': 1 } }
    render(led)
    expect(line()?.textContent).toBe('1 proven · 1 unproven')
  })

  it('drops the second clause when every covered requirement is proven', () => {
    const led = structuredClone(LEDGER)
    led.totals.covered = 1
    led.enforcement = { runId: 'run-9', provenUnchanged: 1, total: 3, states: { 'proven-unchanged': 1, 'tests-weakened': 0, 'wording-ahead': 2, 'proof-stale': 0 } }
    render(led)
    expect(line()?.textContent).toBe('1 proven')
  })

  it('says a suite has not run rather than reporting nought proven as a result', () => {
    const led = structuredClone(LEDGER)
    led.enforcement = { provenUnchanged: 0, total: 3, states: { 'proven-unchanged': 0, 'tests-weakened': 0, 'wording-ahead': 3, 'proof-stale': 0 } }
    render(led)
    expect(line()?.textContent).toBe('no run yet — nothing proven')
    expect(line()?.getAttribute('title')).toContain('every covered requirement is a claim')
  })

  it('glosses "claimed only" on hover, and leaves the run id to the card below', () => {
    const led = structuredClone(LEDGER)
    led.enforcement = { runId: 'run-9', provenUnchanged: 1, total: 3, states: { 'proven-unchanged': 1, 'tests-weakened': 0, 'wording-ahead': 1, 'proof-stale': 1 } }
    render(led)
    expect(line()?.getAttribute('title')).toContain('Unproven')
    expect(line()?.textContent).not.toContain('run-9')
  })

  it('stays silent on an older server with no time axis', () => {
    const led = structuredClone(LEDGER)
    delete led.enforcement
    render(led)
    expect(line()).toBeNull()
  })

  it('stays silent on an empty ledger, where there is no share to report', () => {
    const led = structuredClone(LEDGER)
    led.requirements = []
    led.tests = []
    led.totals = { total: 0, covered: 0, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 }
    led.coveragePct = 0
    led.enforcement = { provenUnchanged: 0, total: 0, states: { 'proven-unchanged': 0, 'tests-weakened': 0, 'wording-ahead': 0, 'proof-stale': 0 } }
    render(led)
    expect(line()).toBeNull()
    expect(container.querySelector('[data-testid="coverage-ring"]')?.getAttribute('aria-label')).toBe('0% covered')
  })
})
