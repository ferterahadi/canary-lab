// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequirementCoverage, RequirementEnforcement, TestCoverage } from '@/shared/api/types'
import { RequirementCard, TestCard } from './CoverageCards'

// Both ledgers are one-line rows at rest. A requirement row is id · title · how
// much is covered (one segment per path, or per path×variant cell) · a dot only
// when the proof is unhealthy. A test row is id · name · the requirement and path
// it claims · a dot in the strength hue. Everything else waits behind the caret.

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

const PROVEN: RequirementEnforcement = {
  state: 'proven-unchanged',
  provenAt: { runId: 'run-9', at: '2026-09-03T10:00:00.000Z' },
  wordingChangedAt: '2026-09-01T00:00:00.000Z',
  accepted: 'none',
}

function req(over: Partial<RequirementCoverage> = {}): RequirementCoverage {
  return {
    requirement: { id: 'R1', title: 'Totals', text: 'The total adds up.', pathTypes: ['happy', 'sad'], kind: 'functional' },
    annotatedTestNames: ['totals add up'],
    pathCoverage: [{ path: 'happy', covered: true }, { path: 'sad', covered: false }],
    gapType: 'path-incomplete',
    coverageStatus: 'partial',
    ...over,
  }
}

function renderReq(item: RequirementCoverage): void {
  act(() => {
    root.render(<RequirementCard rc={item} active={false} focused={false} dimmed={false} onHover={() => {}} onAccept={() => {}} />)
  })
}

const segs = () => [...container.querySelectorAll('[data-testid="cov-R1"] [data-seg]')].map((s) => s.getAttribute('data-seg'))

describe('RequirementCard — the resting row', () => {
  it('shows one segment per declared path, filled when a test claims it, plus the fraction', () => {
    renderReq(req())
    expect(segs()).toEqual(['on', 'off'])
    expect(container.querySelector('[data-testid="cov-R1"]')?.textContent).toContain('1/2')
    // The gap class is the tooltip, not a chip — the segments already show it.
    expect(container.querySelector('[data-testid="cov-R1"]')?.getAttribute('title')).toContain('Path gap')
    expect(container.querySelector('[data-testid="gap-R1"]')).toBeNull()
  })

  it('a variant requirement counts applicable path×variant cells, never the N/A ones', () => {
    renderReq(req({
      requirement: { id: 'R1', title: 'Totals', text: 't', pathTypes: ['happy'], variants: ['email', 'line'] },
      variantCoverage: [
        { path: 'happy', variant: 'email', covered: true },
        { path: 'happy', variant: 'whatsapp', covered: false },
        { path: 'happy', variant: 'line', covered: false, applicable: false, reason: 'no endpoint' },
      ],
      gapType: 'variant-incomplete',
    }))
    expect(segs()).toEqual(['on', 'off'])
    expect(container.querySelector('[data-testid="cov-R1"]')?.textContent).toContain('1/2')
  })

  it('keeps the requirement text, the path detail and the history behind the caret', () => {
    renderReq(req({ enforcement: PROVEN }))
    const row = container.querySelector('[data-testid="req-R1"]') as HTMLElement
    expect(row.textContent).not.toContain('The total adds up.')
    expect(container.querySelector('[data-testid="req-detail-R1"]')).toBeNull()
    act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R1"]')?.click() })
    const detail = container.querySelector('[data-testid="req-detail-R1"]') as HTMLElement
    expect(detail.textContent).toContain('The total adds up.')
    expect(container.querySelector('[data-testid="path-R1-sad"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="enf-strip-R1"]')?.textContent).toContain('proven in run run-9')
  })

  it('drops the Functional tag; only Non-functional is worth a word', () => {
    renderReq(req())
    expect(container.querySelector('[data-testid="kind-R1"]')).toBeNull()
    renderReq(req({ requirement: { id: 'R1', title: 'Totals', text: 't', pathTypes: ['happy'], kind: 'non-functional' } }))
    expect(container.querySelector('[data-testid="kind-R1"]')?.textContent).toBe('Non-functional')
  })
})

describe('RequirementCard — the proof-health dot', () => {
  it.each([
    ['tests-weakened', 'var(--danger)', 'Tests weakened since proof'],
    ['proof-stale', 'var(--warning)', 'Proof stale'],
    ['wording-ahead', 'var(--warning)', 'Wording ahead of tests'],
  ] as const)('%s is a %s dot whose tooltip carries the label and the dates', (state, color, label) => {
    renderReq(req({ enforcement: { ...PROVEN, state } }))
    const dot = container.querySelector('[data-testid="enf-R1"]') as HTMLElement
    expect(dot.style.background).toBe(color)
    expect(dot.title).toContain(label)
    expect(dot.title).toContain('Wording changed 2026-09-01')
    expect(dot.textContent).toBe('')
  })

  it('a healthy proof shows nothing — absence is the good state', () => {
    renderReq(req({ enforcement: PROVEN }))
    expect(container.querySelector('[data-testid="enf-R1"]')).toBeNull()
  })
})

const TEST: TestCoverage = { name: 'adds item', requirements: ['R1'], pathTypes: ['happy'], strength: 'solid', file: 'e2e/cart.spec.ts', line: 10 }

function renderTest(test: TestCoverage, onReqClick = vi.fn()): ReturnType<typeof vi.fn> {
  act(() => {
    root.render(<TestCard test={test} testNumber={1} active={false} dimmed={false} onHover={() => {}} onExpand={() => {}} source={null} sourceLoading={false} sourceError={null} onReqClick={onReqClick} />)
  })
  return onReqClick
}

describe('TestCard — the resting row', () => {
  it('names the requirement and path it claims in one mono strip; the requirement is a jump link', () => {
    const onReqClick = renderTest(TEST)
    const row = container.querySelector('[data-testid="test-adds item"]') as HTMLElement
    expect(row.textContent).toContain('#1')
    expect(row.textContent).toContain('adds item')
    expect(row.textContent).not.toContain('@req-')
    expect(row.textContent).not.toContain('@path-')
    const link = container.querySelector<HTMLButtonElement>('[data-testid="reqtag-adds item-R1"]')
    expect(link?.textContent).toBe('R1')
    expect(row.textContent).toContain('happy')
    act(() => { link?.click() })
    expect(onReqClick).toHaveBeenCalledWith('R1')
  })

  it('carries the strength as a dot in its hue with the four-word gloss on hover', () => {
    renderTest(TEST)
    const dot = container.querySelector('[data-testid="strength-adds item"]') as HTMLElement
    expect(dot.textContent).toBe('')
    expect(dot.style.background).toBe('var(--accent)')
    expect(dot.title).toContain('Solid')
  })

  it('folds requirement tags past the second into a "+N" that unfolds in place, and names the paths as a count', () => {
    const onReqClick = renderTest({ ...TEST, requirements: ['R1', 'R2', 'R3', 'R4'], pathTypes: ['happy', 'sad'] })
    const facts = container.querySelector('[data-testid="test-adds item"] .clcov-rowfacts') as HTMLElement
    expect(facts.getAttribute('data-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="reqtag-adds item-R3"]')).toBeNull()
    const more = container.querySelector<HTMLButtonElement>('[data-testid="reqtag-more-adds item"]')
    expect(more?.textContent).toBe('+2')
    expect(more?.title).toContain('R3, R4')
    expect(container.querySelector('[data-testid="paths-adds item"]')?.textContent).toBe('2 paths')
    act(() => { more?.click() })
    // Unfolding is a row-local disclosure: no jump, no expand.
    expect(onReqClick).not.toHaveBeenCalled()
    expect(facts.getAttribute('data-expanded')).toBe('true')
    expect(container.querySelector('[data-testid="reqtag-more-adds item"]')).toBeNull()
    expect(container.querySelector('[data-testid="reqtag-adds item-R4"]')?.textContent).toBe('R4')
  })

  it('keeps the full name reachable as a tooltip once the two-line clamp cuts it', () => {
    renderTest(TEST)
    const title = container.querySelector('[data-testid="test-adds item"] .clcov-rowtitle') as HTMLElement
    expect(title.title).toBe('adds item')
  })

  it('an orphan says so in the warning hue instead of a requirement link', () => {
    renderTest({ ...TEST, requirements: [] })
    const orphan = container.querySelector('[data-testid="orphan-adds item"]') as HTMLElement
    expect(orphan.textContent).toBe('orphan')
    expect(container.querySelector('[data-testid^="reqtag-"]')).toBeNull()
  })
})
