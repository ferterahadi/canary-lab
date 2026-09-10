// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverageLedger } from '@/shared/api/types'
import { CoverageHeader } from './CoverageHeader'
import { LEDGER } from './__fixtures__/CoverageLedgerPage.part2-fixtures'

// The stat bar reads as a sentence, then two labelled groups. Headline block:
// a small ring, the big percentage, "n of N covered"; the ratio line waits in
// the headline's hover card. Groups: Requirements and Test depth, each a thin stacked bar
// with number-first figures (the filters) spread across the strip.

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

function render(ledger: CoverageLedger, extra: Partial<Parameters<typeof CoverageHeader>[0]> = {}): void {
  act(() => {
    root.render(
      <CoverageHeader
        ledger={ledger}
        gapFilter={null}
        onToggleGap={() => {}}
        strengthFilter={null}
        onToggleStrength={() => {}}
        {...extra}
      />,
    )
  })
}

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe('CoverageHeader — headline block', () => {
  it('states the percentage and the plain sentence beside a small ring', () => {
    render(LEDGER)
    expect(q('coverage-pct')?.textContent).toBe('33%')
    expect(q('coverage-sentence')?.textContent).toBe('1 of 3 covered')
    expect(q('coverage-ring')?.getAttribute('aria-label')).toBe('33.3% covered')
    // The ring no longer carries a label of its own — the sentence does.
    expect(q('coverage-ring')?.textContent).toBe('')
  })

  it("keeps the ratios in the headline's hover card, with an amber dot at rest for stale tags", () => {
    const led = structuredClone(LEDGER)
    led.enforcement = { runId: 'run-9', provenUnchanged: 1, total: 3, states: { 'proven-unchanged': 1, 'tests-weakened': 0, 'wording-ahead': 1, 'proof-stale': 1 } }
    led.orphanRequirementIds = ['R9']
    render(led)
    const sub = q('coverage-sub')
    expect(sub?.textContent).toContain('2/3 mapped')
    expect(sub?.textContent).toContain('1/3 proven in run run-9')
    expect(sub?.querySelector('[data-testid="orphan-note"]')?.textContent).toContain('1 stale tag')
    expect(sub?.classList.contains('clcov-card')).toBe(true)
    expect(q('coverage-hero')?.contains(sub!)).toBe(true)
    expect(q('orphan-dot')?.getAttribute('aria-label')).toBe('1 stale tag')
  })

  it('shows no stale-tag dot when every tag resolves', () => {
    render(LEDGER)
    expect(q('orphan-dot')).toBeNull()
  })

  it('an empty ledger still reads as a sentence, not a blank', () => {
    const led = structuredClone(LEDGER)
    led.requirements = []
    led.tests = []
    led.totals = { total: 0, covered: 0, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 }
    led.coveragePct = 0
    render(led)
    expect(q('coverage-pct')?.textContent).toBe('0%')
    expect(q('coverage-sentence')?.textContent).toBe('0 of 0 covered')
    expect(q('coverage-breakdown')).toBeTruthy()
  })
})

describe('CoverageHeader — Requirements group', () => {
  it('is labelled with its total and lists the legend number-first, in plain words', () => {
    render(LEDGER)
    const grp = q('requirements-group')
    const label = grp?.querySelector('[data-testid="requirements-group-label"]')
    expect(label?.querySelector('.clcov-grp-name')?.firstChild?.textContent).toBe('Requirements')
    expect(label?.querySelector('i')?.textContent).toBe('3')
    expect(grp?.querySelector('[data-testid="coverage-breakdown"]')).toBeTruthy()
    expect(grp?.querySelector('[data-testid="gap-badge-covered"]')?.textContent).toBe('1 covered')
    expect(grp?.querySelector('[data-testid="gap-badge-path-incomplete"]')?.textContent).toBe('1 path gap')
    expect(grp?.querySelector('[data-testid="gap-badge-variant-incomplete"]')?.textContent).toBe('0 variant gaps')
    expect(grp?.querySelector('[data-testid="gap-badge-untested"]')?.textContent).toBe('1 untested')
  })

  it('carries the glossary in its hover card, so the popover opens inside the bar, not off the screen edge', () => {
    render(LEDGER)
    const grp = q('requirements-group')
    expect(grp?.querySelector('.clcov-card [role="note"]')).toBeTruthy()
    expect(container.querySelectorAll('[role="note"]').length).toBe(1)
  })

  it('names an active filter at rest, in the eyebrow, and lights it in the card', () => {
    render(LEDGER, { gapFilter: 'path-incomplete' })
    expect(q('requirements-group-active')?.textContent).toBe('1 path gap')
    expect(q('gap-badge-path-incomplete')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('gap-badge-covered')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('a bar segment is a filter too, and resting on it dims the other figures', () => {
    const onToggleGap = vi.fn()
    render(LEDGER, { onToggleGap })
    const seg = q('coverage-breakdown')?.querySelector<HTMLButtonElement>('[data-seg="covered"]')
    expect(seg?.getAttribute('aria-label')).toBe('1 covered')
    // React derives onMouseEnter/Leave from delegated mouseover/mouseout — drive those.
    act(() => { seg?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(q('gap-badge-covered')?.getAttribute('data-dim')).toBe('false')
    expect(q('gap-badge-untested')?.getAttribute('data-dim')).toBe('true')
    act(() => { seg?.click() })
    expect(onToggleGap).toHaveBeenCalledWith('covered')
    act(() => { q('requirements-group')?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
    expect(q('gap-badge-untested')?.getAttribute('data-dim')).toBe('false')
  })

  it('a legend item is the filter: pressed state and click-through', () => {
    const onToggleGap = vi.fn()
    render(LEDGER, { gapFilter: 'untested', onToggleGap })
    const on = q('gap-badge-untested')
    expect(on?.getAttribute('aria-pressed')).toBe('true')
    expect(q('gap-badge-covered')?.getAttribute('aria-pressed')).toBe('false')
    act(() => { q('gap-badge-covered')?.click() })
    expect(onToggleGap).toHaveBeenCalledWith('covered')
  })
})

describe('CoverageHeader — Test depth group', () => {
  it('has its own stacked bar and a number-first legend that filters', () => {
    const onToggleStrength = vi.fn()
    render(LEDGER, { onToggleStrength })
    const grp = q('strength-filter')
    const label = grp?.querySelector('[data-testid="strength-group-label"]')
    expect(label?.querySelector('.clcov-grp-name')?.textContent).toBe('Test depth')
    expect(label?.querySelector('i')?.textContent).toBe('2 tests')
    const bar = grp?.querySelector('[data-testid="strength-breakdown"]')
    expect(bar?.getAttribute('aria-label')).toBe('1 shallow, 0 basic, 1 solid, 0 strong of 2')
    expect(grp?.querySelector('[data-testid="strength-badge-shallow"]')?.textContent).toBe('1 shallow')
    expect(grp?.querySelector('[data-testid="strength-badge-solid"]')?.textContent).toBe('1 solid')
    act(() => { grp?.querySelector<HTMLButtonElement>('[data-testid="strength-badge-shallow"]')?.click() })
    expect(onToggleStrength).toHaveBeenCalledWith('shallow')
  })

  it('names orphan tests in the label only when there are some', () => {
    render(LEDGER)
    expect(q('orphan-tests-stat')).toBeNull()
    const led = structuredClone(LEDGER)
    led.totals.orphanTests = 3
    render(led)
    expect(q('orphan-tests-stat')?.textContent).toBe('3 orphan')
    expect(q('strength-group-label')?.querySelector('i')?.textContent).toBe('2 tests · 3 orphan')
  })

  it('a ledger with no tests renders no group at all', () => {
    const led = structuredClone(LEDGER)
    led.tests = []
    render(led)
    expect(q('strength-filter')).toBeNull()
  })
})
