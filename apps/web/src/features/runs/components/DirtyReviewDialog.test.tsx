// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirtySpecSummary, Feature, RunIndexEntry } from '@/shared/api/types'
import * as api from '@/shared/api/client'
import { DirtyReviewDialog } from './DirtyReviewDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('@/shared/api/client')
  return {
    ...actual,
    commitDirtySpecs: vi.fn(async () => ({ committed: true })),
    adoptSpecEdits: vi.fn(async () => ({ status: 'adopted', adopted: [], rerun: 'signalled' })),
    restoreSpecEdits: vi.fn(async () => ({ status: 'restored', restored: [] })),
    openWorkspace: vi.fn(async () => ({ opened: true })),
  }
})

vi.mock('../state/RunsContext', () => ({ useRun: () => ({ detail: undefined, error: null }) }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const WEAKER_SPEC: DirtySpecSummary = {
  file: 'e2e/checkout.spec.ts',
  affectedTests: ['applies voucher'],
  strength: {
    verdict: 'weaker',
    baseline: 'run-start',
    tests: [{
      kind: 'changed',
      name: 'applies voucher',
      verdict: 'weaker',
      requirements: ['checkout-1'],
      changes: [{
        kind: 'reshaped',
        verdict: 'weaker',
        before: { matcher: 'toHaveText', target: 'total', expected: 'literal', expectedArity: 1, negated: false, soft: false, poll: false, line: 3, source: "await expect(total).toHaveText('$148.50')" },
        after: { matcher: 'toBeVisible', target: 'total', expected: 'none', expectedArity: 0, negated: false, soft: false, poll: false, line: 3, source: 'await expect(total).toBeVisible()' },
      }],
    }],
  },
}

const EQUIVALENT_SPEC: DirtySpecSummary = {
  file: 'e2e/cart.spec.ts',
  affectedTests: ['adds item'],
  strength: {
    verdict: 'equivalent',
    baseline: 'head',
    tests: [{ kind: 'renamed', name: 'adds an item', wasNamed: 'adds item', verdict: 'equivalent', changes: [] }],
  },
}

const UNREADABLE_SPEC: DirtySpecSummary = {
  file: 'e2e/odd.spec.ts',
  affectedTests: ['odd'],
  strength: {
    verdict: 'unclassifiable',
    baseline: 'head',
    reasons: ['the live side does not parse'],
    tests: [{ kind: 'changed', name: 'odd', verdict: 'unclassifiable', reason: 'a live test with no readable assertion came or went', changes: [] }],
  },
}

function feature(name: string, specs: DirtySpecSummary[]): Feature {
  return { name, description: '', repos: [], envs: [], dirty: { status: 'dirty', specs } } as unknown as Feature
}

function run(feature: string, pendingSpecEdits: number): RunIndexEntry {
  return { runId: '2026-09-07T0100-z6kc', feature, startedAt: '', status: 'healing', pendingSpecEdits } as unknown as RunIndexEntry
}

function render(props: Partial<Parameters<typeof DirtyReviewDialog>[0]> = {}) {
  const onClose = vi.fn()
  act(() => {
    root.render(<DirtyReviewDialog features={[]} onClose={onClose} {...props} />)
  })
  return { onClose }
}

const card = (name: string) => document.querySelector(`[data-testid="dirty-review-card-${name}"]`)
const actionButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="dirty-review-actions"] button')]
const buttons = () => actionButtons().map((button) => button.textContent?.trim())

describe('DirtyReviewDialog', () => {
  it('names the predicate that changed — was → now — with its requirement tag and the file it is compared against', () => {
    render({ features: [feature('shop', [WEAKER_SPEC])] })
    const c = card('shop')!
    expect(c.textContent).toContain("was await expect(total).toHaveText('$148.50')")
    expect(c.textContent).toContain('now await expect(total).toBeVisible()')
    expect(c.textContent).toContain('@checkout-1')
    expect(c.textContent).toContain('reshaped')
    expect(c.textContent).toContain('vs run start')
  })

  it('a weaker reading gets danger tone, the word "hint", the false-positive rate and the disclosure', () => {
    render({ features: [feature('shop', [WEAKER_SPEC])] })
    // happy-dom drops a `color-mix()` inline value, so the tone is read off the
    // data attribute the card carries for exactly this reason (and for CSS hooks).
    expect(card('shop')?.getAttribute('data-tone')).toBe('weaker')
    expect(document.querySelector('[data-testid="dirty-review-tone-weaker"]')?.textContent).toContain('Weaker · hint')
    act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'About this hint')!.click())
    const copy = document.querySelector('[data-testid="dirty-review-hint-copy"]')?.textContent ?? ''
    expect(copy).toMatch(/^A hint, not a verdict/)
    expect(copy).toContain('2.4%')
    expect(copy).toMatch(/one AI labelled, a second AI checked blind, no human/)
  })

  it('an equivalent reading is neutral: no danger, no hint copy, a rename shown as was → now', () => {
    render({ features: [feature('cart', [EQUIVALENT_SPEC])] })
    expect(card('cart')?.getAttribute('data-tone')).toBe('changed')
    expect(document.querySelector('[data-testid="dirty-review-hint-copy"]')).toBeNull()
    expect(document.querySelector('[data-testid="dirty-review-tone-changed"]')?.textContent).toContain('Changed')
    expect(card('cart')?.textContent).toContain('adds item → adds an item')
    expect(card('cart')?.textContent).toContain('vs committed')
  })

  it('shows "cannot classify" as such — never folded into equivalent', () => {
    render({ features: [feature('odd', [UNREADABLE_SPEC])] })
    expect(card('odd')?.textContent).toContain('Cannot classify: the live side does not parse')
    expect(card('odd')?.textContent).toContain('a live test with no readable assertion came or went')
    expect(document.querySelector('[data-testid="dirty-review-tone-changed"]')).not.toBeNull()
  })

  it('falls back to the test-name list when a record has no readable verdict', () => {
    render({ features: [feature('legacy', [{ file: 'e2e/x.spec.ts', affectedTests: ['one', 'two'] }])] })
    expect(card('legacy')?.textContent).toContain('one')
    expect(card('legacy')?.textContent).toContain('two')
    expect(document.querySelector('[data-testid="dirty-review-change"]')).toBeNull()
  })

  it('sorts a suite with an edit pending against a live run first, and gives it Restore + Adopt beside Commit', () => {
    render({
      features: [feature('a-clean-name', [WEAKER_SPEC]), feature('z-pending', [EQUIVALENT_SPEC])],
      pendingRuns: [run('z-pending', 2)],
    })
    const names = [...document.querySelectorAll('[data-testid^="dirty-review-suite-"]')].map((el) => el.getAttribute('data-testid'))
    expect(names).toEqual(['dirty-review-suite-z-pending', 'dirty-review-suite-a-clean-name'])
    expect(document.querySelector('[data-testid="dirty-review-pending-z-pending"]')?.textContent)
      .toMatch(/Pending against run z6kc · 2 edits not executed — the verdict is from the run-start snapshot/)
    expect(buttons()).toEqual(['Commit changes', 'Restore original tests', 'Adopt & rerun'])
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="dirty-review-suite-a-clean-name"] button')!.click())
    expect(buttons()).toEqual(['Commit changes'])
  })

  it('shows the selected run pending files before feature-level dirty data catches up', () => {
    const entry = run('shop', 1)
    render({ pendingRuns: [entry], focusRunId: entry.runId, focusRunDetail: {
      manifest: { runId: entry.runId, specEdits: { pending: [{ file: 'e2e/new.spec.ts', affectedTests: ['merchant session check'], change: 'modified' }] } },
    } as unknown as import('@/shared/api/types').RunDetail })
    expect(card('shop')?.textContent).toContain('e2e/new.spec.ts')
    expect(card('shop')?.textContent).toContain('merchant session check')
  })

  it('opens the selected run first even when another run of that suite also has pending edits', () => {
    const first = { ...run('shop', 1), runId: 'newer' }
    const focused = { ...run('shop', 2), runId: 'selected' }
    render({ features: [feature('shop', [EQUIVALENT_SPEC])], pendingRuns: [first, focused], focusRunId: 'selected' })
    expect(document.querySelectorAll('[data-testid="dirty-review-card-shop"]')).toHaveLength(1)
    expect(document.querySelector('[data-testid="dirty-review-actions"]')?.textContent).toContain('2 edits not executed')
  })

  it('Restore and Adopt call the run-scoped levers with the run id; Commit calls the feature route', async () => {
    render({ features: [feature('shop', [WEAKER_SPEC])], pendingRuns: [run('shop', 1)] })
    const [commit, restore, adopt] = actionButtons()
    await act(async () => { restore.click() })
    expect(api.restoreSpecEdits).toHaveBeenCalledWith('2026-09-07T0100-z6kc')
    await act(async () => { adopt.click() })
    expect(api.adoptSpecEdits).toHaveBeenCalledWith('2026-09-07T0100-z6kc')
    await act(async () => { commit.click() })
    expect(api.commitDirtySpecs).toHaveBeenCalledWith('shop')
  })

  it('surfaces a lever failure on the card and re-enables the buttons', async () => {
    vi.mocked(api.adoptSpecEdits).mockRejectedValueOnce(new Error('tests-running'))
    render({ features: [feature('shop', [WEAKER_SPEC])], pendingRuns: [run('shop', 1)] })
    const adopt = actionButtons().find((button) => button.textContent === 'Adopt & rerun')!
    await act(async () => { adopt.click() })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('tests-running')
    expect(adopt.disabled).toBe(false)
  })

  it('renders a card from the run alone when the feature list does not flag the suite yet', () => {
    render({ pendingRuns: [run('fresh', 1)] })
    expect(card('fresh')?.getAttribute('data-pending')).toBe('true')
    expect(buttons()).toEqual(['Restore original tests', 'Adopt & rerun'])
  })

  it('closes itself once the last card leaves — but not on an empty mount, which a cold routed load is', () => {
    // A cold ?dialog=tests-review load renders before the feature list arrives.
    // Closing then dropped the route param before the data could fill the panel.
    const { onClose } = render({ features: [] })
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="dirty-review-empty"]')?.textContent).toContain('No changed test files')
    // The data arrives → cards; the last one clears → close.
    act(() => { root.render(<DirtyReviewDialog features={[feature('shop', [WEAKER_SPEC])]} onClose={onClose} />) })
    expect(document.querySelector('[data-testid="dirty-review-empty"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    act(() => { root.render(<DirtyReviewDialog features={[]} onClose={onClose} />) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has a neutral header — the danger belongs to the weaker card, not the panel', () => {
    render({ features: [feature('shop', [WEAKER_SPEC])] })
    const h2 = document.querySelector('h2')
    expect(h2?.textContent).toBe('Tests changed')
    expect(h2?.getAttribute('style')).not.toContain('--danger')
    expect(document.querySelector('[aria-label="Changed test files"]')).not.toBeNull()
  })
})

it('puts suspected weakening before renamed tests and shows the other changes on demand', () => {
  const spec: DirtySpecSummary = { ...WEAKER_SPEC, strength: { ...WEAKER_SPEC.strength!, tests: [...EQUIVALENT_SPEC.strength!.tests, ...WEAKER_SPEC.strength!.tests] } }
  render({ features: [feature('shop', [spec])] })
  expect(card('shop')?.textContent).toContain('applies voucher')
  expect(card('shop')?.textContent).not.toContain('adds an item')
  const toggle = [...card('shop')!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Other changes'))!
  act(() => toggle.click())
  expect(card('shop')?.textContent).toContain('adds item → adds an item')
  expect(card('shop')?.querySelectorAll('pre')).toHaveLength(2)
  expect(card('shop')?.querySelector('pre')?.className).not.toContain('truncate')
})

it('opens the requested suite and keeps its file selection when live data refreshes', () => {
  const a = feature('a', [WEAKER_SPEC])
  const b = feature('b', [EQUIVALENT_SPEC, WEAKER_SPEC])
  render({ features: [a, b], focusFeature: 'b' })
  expect(card('b')).not.toBeNull()
  const file = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="dirty-review-suite-b"] button')].find((button) => button.textContent?.includes('cart.spec'))!
  act(() => file.click())
  expect(card('b')?.textContent).toContain('adds an item')
  act(() => root.render(<DirtyReviewDialog features={[a, { ...b }]} focusFeature="b" onClose={vi.fn()} />))
  expect(card('b')?.textContent).toContain('adds an item')
  expect(card('b')?.textContent).not.toContain('applies voucher')
})
