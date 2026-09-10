// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequirementCoverage, RequirementEnforcement, TestCoverage } from '@/shared/api/types'
import { GAP_META, RequirementCard, TestCard } from './CoverageCards'

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
    root.render(<RequirementCard rc={item} active={false} focused={false} dimmed={false} onHover={() => {}} />)
  })
}

const segs = () => [...container.querySelectorAll('[data-testid="cov-R1"] [data-seg]')].map((s) => s.getAttribute('data-seg'))

/** The segment strip's hover label, through the shared Tooltip (portaled to body). */
const segTip = (): string => {
  act(() => { container.querySelector('[data-testid="cov-R1"]')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  return document.body.querySelector('[role="tooltip"]')?.textContent ?? ''
}

describe('RequirementCard — the resting row', () => {
  it('shows one segment per declared path, filled when a test claims it, plus the fraction', () => {
    renderReq(req())
    expect(segs()).toEqual(['claimed', 'off'])
    expect(container.querySelector('[data-testid="cov-R1"]')?.textContent).toContain('1/2')
    // The gap class is the tooltip, not a chip — the segments already show it.
    expect(segTip()).toContain('Path gap — 1 of 2 mapped')
    expect(container.querySelector('[data-testid="gap-R1"]')).toBeNull()
  })

  // A square has THREE states, not two, and the third is the whole product: a test
  // pointing at a case is a claim, and only a run that passed it is evidence. The
  // strip painted both in `--success` until the per-cell `proven` flag was read here.
  it('separates a claimed case from a proven one — shape says tested, green says passed', () => {
    renderReq(req({
      pathCoverage: [{ path: 'happy', covered: true, proven: true }, { path: 'sad', covered: true }],
      gapType: 'covered',
      coverageStatus: 'covered',
    }))
    expect(segs()).toEqual(['proven', 'claimed'])
    expect(segTip()).toContain('2 of 2 mapped, 1 proven')
  })

  it('keys the strip on hover: one line per square, naming the case it stands for', () => {
    renderReq(req())
    // Declared order, and the mark mirrors that square's own fill — so the reader
    // maps line to square by position. Each line ends in the WORD for that state,
    // because the mark alone cannot say the difference between claimed and passed.
    expect(segTip()).toBe('Path gap — 1 of 2 mapped, 0 proven\n■ happy — has a test · not yet passed\n□ sad — no test')
  })

  it('names the path AND the variant once a variant dimension is in play', () => {
    renderReq(req({
      requirement: { id: 'R1', title: 'Totals', text: 't', pathTypes: ['happy'], variants: ['email', 'whatsapp'] },
      variantCoverage: [
        { path: 'happy', variant: 'email', covered: true },
        { path: 'happy', variant: 'whatsapp', covered: false },
      ],
      gapType: 'variant-incomplete',
    }))
    expect(segTip()).toBe('Variant gap — 1 of 2 mapped, 0 proven\n■ happy · email — has a test · not yet passed\n□ happy · whatsapp — no test')
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
    expect(segs()).toEqual(['claimed', 'off'])
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
    expect(container.querySelector('[data-testid="behaviour-unhappy-R1"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="byline-R1"]')).toBeNull()
    expect(container.querySelector('[data-testid="proof-verdict-R1"]')).toBeTruthy()
  })

  it('drops the Functional tag; only Non-functional is worth a word', () => {
    renderReq(req())
    expect(container.querySelector('[data-testid="kind-R1"]')).toBeNull()
    renderReq(req({ requirement: { id: 'R1', title: 'Totals', text: 't', pathTypes: ['happy'], kind: 'non-functional' } }))
    expect(container.querySelector('[data-testid="kind-R1"]')?.textContent).toBe('Non-functional')
  })
})

// The disclosed detail is a stack of NAMED bands: one band per PROMISE (its
// sentence and its coverage together), then the proof. Behaviour and coverage used
// to be two bands split on the same axis, so the reader carried "Unhappy path"
// across a section break to match it against a pill called `sad`.
describe('RequirementCard — the disclosed detail', () => {
  const withPaths = { id: 'R1', title: 'Totals', text: 'The total adds up.', pathTypes: ['happy', 'sad'], happyPath: 'The total matches the cart.', unhappyPath: 'A missing price is refused.' }
  const expand = () => act(() => { container.querySelector<HTMLElement>('[data-testid="req-toggle-R1"]')?.click() })
  const detail = () => (container.querySelector('[data-testid="req-detail-R1"]') as HTMLElement).textContent ?? ''

  it('pairs each promise with the marks for its own cases and the word they add up to', () => {
    renderReq(req({ enforcement: PROVEN, requirement: withPaths }))
    expand()
    const happy = container.querySelector('[data-testid="behaviour-happy-R1"]') as HTMLElement
    expect(happy.textContent).toContain('Happy path')
    expect(happy.textContent).toContain('The total matches the cart.')
    // A fraction of one is not a reading — "1/1 tested" made the reader divide to
    // learn a fact the single square already showed. The word is the reading.
    expect(happy.textContent).toContain('has a test · not yet passed')
    expect([...happy.querySelectorAll('[data-seg]')].map((el) => el.getAttribute('data-seg'))).toEqual(['claimed'])
    const unhappy = container.querySelector('[data-testid="behaviour-unhappy-R1"]') as HTMLElement
    expect(unhappy.textContent).toContain('A missing price is refused.')
    expect(unhappy.textContent).toContain('no test')
    expect([...unhappy.querySelectorAll('[data-seg]')].map((el) => el.getAttribute('data-seg'))).toEqual(['off'])
  })

  // One bad cell makes the whole promise unproven, so the summary word is the
  // WORST of the row — never the majority, and never the first square.
  it('summarises a promise by its worst case, not its best', () => {
    renderReq(req({
      enforcement: PROVEN,
      requirement: { ...withPaths, pathTypes: ['sad', 'edge'] },
      pathCoverage: [{ path: 'sad', covered: true, proven: true }, { path: 'edge', covered: true }],
      gapType: 'covered',
      coverageStatus: 'covered',
    }))
    expand()
    const unhappy = container.querySelector('[data-testid="behaviour-unhappy-R1"]') as HTMLElement
    expect(unhappy.textContent).toContain('has a test · not yet passed')
    expect(unhappy.textContent).not.toContain('passed\u00a0')
  })

  it('closes with the verdict the marks add up to, under the marks themselves', () => {
    renderReq(req({ enforcement: PROVEN, requirement: withPaths }))
    expand()
    const detailEl = container.querySelector('[data-testid="req-detail-R1"]') as HTMLElement
    const verdict = container.querySelector('[data-testid="proof-verdict-R1"]') as HTMLElement
    expect(verdict.textContent).toBe('Not provable yet')
    // Last, because it is the conclusion — the panel used to open with the audit
    // trail and bury the prose that explains the requirement.
    expect(detailEl.lastElementChild).toBe(verdict)
  })

  // A promise with no stated prose still earns its band: the fraction underneath it
  // is anonymous without a name, and dropping the band would hide the coverage.
  it('keeps a band with coverage but no prose, and drops the stack when there is neither', () => {
    renderReq(req({ enforcement: PROVEN }))
    expand()
    expect(container.querySelector('[data-testid="behaviour-happy-R1"]')?.textContent).toContain('Happy path')
    expect(detail()).not.toContain('The total matches the cart.')
    renderReq(req({ enforcement: PROVEN, requirement: { id: 'R1', title: 'Totals', text: 'The total adds up.', pathTypes: [] }, pathCoverage: [] }))
    expand()
    expect(container.querySelector('[data-testid="behaviour-R1"]')).toBeNull()
  })

  it('omits the provenance byline and confirmation control', () => {
    renderReq(req({ enforcement: PROVEN }))
    expand()
    expect(container.querySelector('[data-testid="byline-R1"]')).toBeNull()
    expect(detail()).not.toContain('Drafted by an agent')
    expect(container.querySelector('[data-testid="accept-R1"]')).toBeNull()
  })
})

describe('RequirementCard — the proof-health dot', () => {
  it.each([
    ['tests-weakened', 'var(--danger)', 'A test was weakened after the proof'],
    ['proof-stale', 'var(--warning)', 'Proof out of date'],
    ['wording-ahead', 'var(--warning)', 'R1 was rewritten after the proof'],
  ] as const)('%s is a %s dot whose tooltip carries the label and the dates', (state, color, label) => {
    const enforcement: RequirementEnforcement = {
      ...PROVEN,
      state,
      testsChangedAt: { at: '2026-09-02T00:00:00.000Z', tests: ['totals add up'], verdict: 'weakened', runId: 'run-8' },
    }
    renderReq(req({ enforcement, gapType: 'covered', coverageStatus: 'covered', pathCoverage: [{ path: 'happy', covered: true, proven: true }] }))
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

  it('folds every requirement past the first into a "+N" label and names the paths as a count', () => {
    renderTest({ ...TEST, requirements: ['R1', 'R2', 'R3', 'R4'], pathTypes: ['happy', 'sad'] })
    expect(container.querySelector('[data-testid="reqtag-adds item-R2"]')).toBeNull()
    const more = container.querySelector<HTMLElement>('[data-testid="reqtag-more-adds item"]')
    expect(more?.textContent).toBe('+3')
    expect(more?.title).toContain('R2, R3, R4')
    // A label, not a control — hovering the cell is what opens the reveal, so a
    // click here must not become a second, competing way to unfold.
    expect(more?.tagName).toBe('SPAN')
    expect(container.querySelector('[data-testid="paths-adds item"]')?.textContent).toBe('2 paths')
  })

  it('keeps the folded cell inside its own column so a busy row cannot squeeze its title', () => {
    renderTest({ ...TEST, requirements: ['R1', 'R2', 'R3', 'R4'], pathTypes: ['happy', 'sad'] })
    const facts = container.querySelector('[data-testid="test-adds item"] .clcov-rowfacts') as HTMLElement
    // The cell never carries a width of its own: the fixed grid columns in the CSS do.
    expect(facts.getAttribute('style')).toBeNull()
    expect(facts.querySelector('.clcov-rowreqs')).not.toBeNull()
    expect(facts.querySelector('.clcov-rowpath')).not.toBeNull()
  })

  it('reveals every requirement and every path it folded, with the ids still jump links', () => {
    const onReqClick = renderTest({ ...TEST, requirements: ['R1', 'R2', 'R3', 'R4'], pathTypes: ['happy', 'sad'] })
    const pop = container.querySelector('[data-testid="facts-full-adds item"]') as HTMLElement
    expect(pop.textContent).toContain('R4')
    // The count is spelled back out into the path names it stood for.
    expect(pop.textContent).toContain('happy')
    expect(pop.textContent).toContain('sad')
    const folded = container.querySelector<HTMLButtonElement>('[data-testid="reqtag-full-adds item-R4"]')
    act(() => { folded?.click() })
    expect(onReqClick).toHaveBeenCalledWith('R4')
  })

  it('folds a second requirement the same way it folds a second path', () => {
    renderTest({ ...TEST, requirements: ['R1', 'R2'], pathTypes: ['happy'] })
    expect(container.querySelector('[data-testid="reqtag-adds item-R1"]')?.textContent).toBe('R1')
    expect(container.querySelector<HTMLElement>('[data-testid="reqtag-more-adds item"]')?.textContent).toBe('+1')
    expect(container.querySelector('[data-testid="facts-full-adds item"]')?.textContent).toContain('R2')
  })

  it('offers no reveal on a row that folds nothing', () => {
    renderTest({ ...TEST, requirements: ['R1'], pathTypes: ['happy'] })
    expect(container.querySelector('[data-testid="facts-full-adds item"]')).toBeNull()
    expect(container.querySelector('[data-testid="paths-adds item"]')?.textContent).toBe('happy')
  })

  it('floats the full name only once the two-line clamp cuts it', () => {
    renderTest(TEST)
    const title = container.querySelector('[data-testid="test-adds item"] .clcov-rowtitle') as HTMLElement
    // The slow native tooltip is gone: an uncut title only ever repeated itself.
    expect(title.title).toBe('')

    // happy-dom reports no box, so a title measures as "fits" and reveals nothing.
    act(() => { title.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()

    // Cut it, and the same hover floats the whole name over the pane.
    Object.defineProperty(title, 'scrollHeight', { value: 60, configurable: true })
    Object.defineProperty(title, 'clientHeight', { value: 32, configurable: true })
    act(() => { title.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('adds item')
    act(() => { title.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('an orphan says so in the warning hue instead of a requirement link', () => {
    renderTest({ ...TEST, requirements: [] })
    const orphan = container.querySelector('[data-testid="orphan-adds item"]') as HTMLElement
    expect(orphan.textContent).toBe('orphan')
    expect(container.querySelector('[data-testid^="reqtag-"]')).toBeNull()
  })
})

// The four requirement classes share one colour map, and the bar, the legend, the
// glossary and the flight card all read it. Two of them wore the identical amber
// once — the legend still named both kinds, but a lopsided suite (2 path gaps
// against 21 variant gaps) drew one undifferentiated amber run, so the shape could
// not say which kind dominated. Pairwise distinctness is the invariant that keeps
// the bar readable; re-unifying any two is the regression this catches.
describe('GAP_META hues', () => {
  it('gives every requirement class its own colour', () => {
    const colors = Object.values(GAP_META).map((m) => m.color)
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('keeps the two gap kinds apart while both stay in the warning family', () => {
    expect(GAP_META['path-incomplete'].color).not.toBe(GAP_META['variant-incomplete'].color)
    // Path gap is the worse gap — a declared behaviour with no test at all — so it
    // reads hotter, mixed toward danger rather than given a hue of its own.
    expect(GAP_META['path-incomplete'].color).toContain('var(--warning)')
    expect(GAP_META['path-incomplete'].color).toContain('var(--danger)')
    expect(GAP_META['variant-incomplete'].color).toBe('var(--warning)')
  })
})
