// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequirementCoverage, RequirementEnforcement } from '@/shared/api/types'
import { ENFORCEMENT_META, RequirementCard, compareRequirements } from './CoverageCards'

// The time axis on a requirement card (D11): one state chip (dot + label + a
// tooltip carrying the dates) beside the gap chip, and a strip under the text
// that names the proof run, the last test change with its verdict, the last
// wording change, where the wording came from, and the human-only Accept lever.

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
    pathCoverage: [{ path: 'happy', covered: true }],
    gapType: 'covered',
    coverageStatus: 'covered',
    ...(enforcement ? { enforcement } : {}),
  }
}

function render(item: RequirementCoverage, onAccept?: () => void): void {
  act(() => {
    root.render(<RequirementCard rc={item} colors={[]} active={false} focused={false} dimmed={false} onHover={() => {}} onAccept={onAccept} />)
  })
}

const PROVEN: RequirementEnforcement = {
  state: 'proven-unchanged',
  provenAt: { runId: 'run-9', at: '2026-09-03T10:00:00.000Z' },
  testsChangedAt: { at: '2026-09-02T00:00:00.000Z', tests: ['totals add up'], verdict: 'changed', runId: 'run-8' },
  wordingChangedAt: '2026-09-01T00:00:00.000Z',
  accepted: 'none',
}

describe('RequirementCard — enforcement chip', () => {
  it.each([
    ['proven-unchanged', 'Proven, unchanged', 'var(--success)'],
    ['tests-weakened', 'Tests weakened since proof', 'var(--danger)'],
    ['wording-ahead', 'Wording ahead of tests', 'var(--warning)'],
    ['proof-stale', 'Proof stale', 'var(--warning)'],
  ] as const)('%s renders as a dot + "%s" in the %s hue', (state, label, color) => {
    render(rc({ ...PROVEN, state }))
    const chip = container.querySelector('[data-testid="enf-R1"]') as HTMLElement
    expect(chip.textContent).toContain(label)
    expect(chip.style.color).toBe(color)
    expect(ENFORCEMENT_META[state].label).toBe(label)
  })

  it('the tooltip carries the three dates and the verdict, so the chip is the whole story on hover', () => {
    render(rc(PROVEN))
    const title = (container.querySelector('[data-testid="enf-R1"]') as HTMLElement).title
    expect(title).toContain('Proven in run run-9 · 2026-09-03')
    expect(title).toContain('Tests changed 2026-09-02 (changed)')
    expect(title).toContain('Wording changed 2026-09-01')
  })

  it('a ledger without the axis (an older server) renders no chip and no strip', () => {
    render(rc(undefined))
    expect(container.querySelector('[data-testid="enf-R1"]')).toBeNull()
    expect(container.querySelector('[data-testid="enf-strip-R1"]')).toBeNull()
  })
})

describe('RequirementCard — enforcement strip', () => {
  it('names the proof run, the last test change with its verdict, the wording change and the source', () => {
    render(rc(PROVEN, { source: { doc: 'checkout.md', heading: 'Totals', line: 12 } }))
    const strip = container.querySelector('[data-testid="enf-strip-R1"]') as HTMLElement
    expect(strip.textContent).toContain('proven in run run-9')
    expect(strip.textContent).toContain('tests changed 2026-09-02 (changed)')
    expect(strip.textContent).toContain('wording changed 2026-09-01')
    expect(strip.textContent).toContain('checkout.md § Totals')
  })

  it('a never-proven requirement says so instead of showing an empty slot; no test change, no source → those slots are absent', () => {
    render(rc({ state: 'wording-ahead', wordingChangedAt: '2026-09-01T00:00:00.000Z', accepted: 'none' }))
    const strip = container.querySelector('[data-testid="enf-strip-R1"]') as HTMLElement
    expect(strip.textContent).toContain('never proven')
    expect(strip.textContent).not.toContain('tests changed')
    expect(strip.textContent).not.toContain('§')
  })

  it('a source without a heading names just the doc', () => {
    render(rc(PROVEN, { source: { doc: 'checkout.md' } }))
    expect((container.querySelector('[data-testid="enf-strip-R1"]') as HTMLElement).textContent).toContain('checkout.md')
    expect((container.querySelector('[data-testid="enf-strip-R1"]') as HTMLElement).textContent).not.toContain('§')
  })
})

describe('RequirementCard — Accept wording (human-only lever)', () => {
  it('offers Accept when the wording was never accepted, and calls back on click', () => {
    const onAccept = vi.fn()
    render(rc(PROVEN), onAccept)
    const button = container.querySelector('[data-testid="accept-R1"]') as HTMLButtonElement
    expect(button.textContent).toBe('Accept wording')
    act(() => { button.click() })
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it('an accepted wording shows the acceptance date and no button', () => {
    render(rc({ ...PROVEN, accepted: 'current' }, { acceptedAt: '2026-09-04T00:00:00.000Z' }), vi.fn())
    expect(container.querySelector('[data-testid="accept-R1"]')).toBeNull()
    expect((container.querySelector('[data-testid="enf-strip-R1"]') as HTMLElement).textContent).toContain('accepted 2026-09-04')
  })

  it('an acceptance the wording has since moved past offers Re-accept and says when the old one was', () => {
    render(rc({ ...PROVEN, accepted: 'outdated' }, { acceptedAt: '2026-08-20T00:00:00.000Z' }), vi.fn())
    const button = container.querySelector('[data-testid="accept-R1"]') as HTMLButtonElement
    expect(button.textContent).toBe('Re-accept wording')
    expect(button.title).toContain('2026-08-20')
  })

  it('renders no button at all when the surface has no accept handler (read-only embeds)', () => {
    render(rc(PROVEN))
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
