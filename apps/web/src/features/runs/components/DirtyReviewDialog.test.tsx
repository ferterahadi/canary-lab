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
    expect(c.textContent).toContain('Assertion changed')
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

  it('an equivalent reading keeps a neutral hint and shows the rename in before/after columns', () => {
    render({ features: [feature('cart', [EQUIVALENT_SPEC])] })
    expect(card('cart')?.getAttribute('data-tone')).toBe('changed')
    expect(document.querySelector('[data-testid="dirty-review-hint-copy"]')).toBeNull()
    expect(document.querySelector('[data-testid="dirty-review-tone-changed"]')?.textContent).toContain('Changed')
    expect(card('cart')?.querySelector('[data-side="before"]')?.textContent).toBe('was adds item')
    expect(card('cart')?.querySelector('[data-side="after"]')?.textContent).toBe('now adds an item')
    expect(card('cart')?.querySelector('ins')?.textContent).toBe('an ')
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
    expect(buttons()).toEqual(['Restore original tests', 'Adopt & rerun', 'Commit suite · 1 file'])
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="dirty-review-suite-a-clean-name"] button')!.click())
    expect(buttons()).toEqual(['Commit suite · 1 file'])
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
    const [restore, adopt, commit] = actionButtons()
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

it('keeps every assessment in one table, with weaker changes first and an optional filter', () => {
  const spec: DirtySpecSummary = { ...WEAKER_SPEC, strength: { ...WEAKER_SPEC.strength!, tests: [...EQUIVALENT_SPEC.strength!.tests, ...WEAKER_SPEC.strength!.tests] } }
  render({ features: [feature('shop', [spec])] })
  const table = card('shop')!.querySelector('table')!
  expect(card('shop')!.querySelectorAll('table')).toHaveLength(1)
  expect([...table.querySelectorAll('thead th')].map((node) => node.textContent)).toEqual(['Change', 'Assessment', 'Before · Run start', 'After · Current test'])
  expect([...table.querySelectorAll('[data-assessment]')].map((node) => node.getAttribute('data-assessment'))).toEqual(['weaker', 'equivalent'])
  expect(table.querySelector('[data-side="before"]')?.textContent).toBe("was await expect(total).toHaveText('$148.50')")
  expect(table.querySelector('[data-side="after"]')?.textContent).toBe('now await expect(total).toBeVisible()')
  expect(table.textContent).toContain('adds an item')
  const select = card('shop')!.querySelector('select')!
  act(() => { select.value = 'equivalent'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(table.textContent).not.toContain('applies voucher')
  expect(table.querySelector('[data-side="before"]')?.textContent).toBe('was adds item')
  expect(table.querySelector('[data-side="after"]')?.textContent).toBe('now adds an item')
  act(() => { select.value = 'all'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(table.textContent).toContain('applies voucher')
  expect(table.textContent).toContain('adds an item')
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

it('keeps duplicate new names as distinct rows in one rename table across refreshes', () => {
  const spec: DirtySpecSummary = { ...EQUIVALENT_SPEC, strength: { ...EQUIVALENT_SPEC.strength!, tests: [
    { kind: 'renamed', name: 'same title', wasNamed: '@variant-a old title', verdict: 'equivalent', changes: [] },
    { kind: 'renamed', name: 'same title', wasNamed: '@variant-b old title', verdict: 'equivalent', changes: [] },
  ] } }
  render({ features: [feature('shop', [spec])] })
  render({ features: [feature('shop', [structuredClone(spec)])] })
  expect(card('shop')?.querySelectorAll('table')).toHaveLength(1)
  expect([...card('shop')!.querySelectorAll('[data-side="before"]')].map((cell) => cell.textContent))
    .toEqual(['was @variant-a old title', 'was @variant-b old title'])
  expect([...card('shop')!.querySelectorAll('[data-side="after"]')].map((cell) => cell.textContent))
    .toEqual(['now same title', 'now same title'])
})

it('shows added, deleted, disabled and enabled tests without inventing assertion source', () => {
  const spec: DirtySpecSummary = { ...EQUIVALENT_SPEC, strength: { ...EQUIVALENT_SPEC.strength!, tests: [
    { kind: 'added', name: 'new test', verdict: 'unclassifiable', reason: 'No readable assertion', changes: [] },
    { kind: 'deleted', name: 'old test', verdict: 'equivalent', changes: [] },
    { kind: 'disabled', name: 'paused test', verdict: 'equivalent', changes: [] },
    { kind: 'enabled', name: 'resumed test', verdict: 'equivalent', changes: [] },
  ] } }
  render({ features: [feature('shop', [spec])] })
  expect(card('shop')?.textContent).toContain('Cannot classify')
  expect(card('shop')?.textContent).toContain('No readable assertion')
  expect([...card('shop')!.querySelectorAll('[data-side="before"]')].map((cell) => cell.textContent))
    .toEqual(['Not present', 'was old test', 'was Enabled', 'was Disabled'])
  expect([...card('shop')!.querySelectorAll('[data-side="after"]')].map((cell) => cell.textContent))
    .toEqual(['now new test', 'Not present', 'now Disabled', 'now Enabled'])
  expect(card('shop')?.querySelector('[data-testid="dirty-review-change"]')).toBeNull()
})

it('shows every tracked suite file in the commit scope even when the run displays fewer files', async () => {
  const entry = run('shop', 1)
  render({ features: [feature('shop', [WEAKER_SPEC, EQUIVALENT_SPEC])], pendingRuns: [entry], focusRunDetail: {
    manifest: { runId: entry.runId, specEdits: { pending: [WEAKER_SPEC] } },
  } as unknown as import('@/shared/api/types').RunDetail })
  const commit = actionButtons().find((button) => button.textContent === 'Commit suite · 2 files')!
  expect(commit.title).toContain('all 2 changed spec files in shop')
  expect(commit.title).toContain('including files not opened here')
  await act(async () => commit.click())
  expect(api.commitDirtySpecs).toHaveBeenCalledWith('shop')
  expect(api.adoptSpecEdits).not.toHaveBeenCalled()
})

it('reports a no-op commit response rather than implying the suite was committed', async () => {
  vi.mocked(api.commitDirtySpecs).mockResolvedValueOnce({ committed: false, reason: 'no modified specs' })
  render({ features: [feature('shop', [WEAKER_SPEC])] })
  await act(async () => actionButtons()[0].click())
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('no modified specs')
  expect(actionButtons()[0].disabled).toBe(false)
})

it('restores scroll position per file and leaves a new file at the top', () => {
  render({ features: [feature('shop', [WEAKER_SPEC, EQUIVALENT_SPEC])] })
  const chooseFile = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.cl-review-file')].find((button) => button.textContent?.includes(name))!
  const scroller = () => card('shop')!.querySelector<HTMLDivElement>('.cl-comparison-review')!
  act(() => { scroller().scrollTop = 140; scroller().scrollLeft = 90; scroller().dispatchEvent(new Event('scroll')) })
  act(() => chooseFile('cart.spec.ts').click())
  expect(scroller().scrollTop).toBe(0)
  expect(scroller().scrollLeft).toBe(0)
  act(() => chooseFile('checkout.spec.ts').click())
  expect(scroller().scrollTop).toBe(140)
  expect(scroller().scrollLeft).toBe(90)
})

it('preserves the four-column structure for loading, missing source, and an empty filter', () => {
  render({ pendingRuns: [run('loading', 1)] })
  const headers = () => [...document.querySelectorAll('.cl-comparison thead th')].map((node) => node.textContent)
  expect(headers()).toEqual(['Change', 'Assessment', 'Before · Unavailable', 'After · Current test'])
  expect(card('loading')?.textContent).toContain('Loading changed test files')
  render({ features: [feature('legacy', [{ file: 'old.spec.ts', affectedTests: ['named test'] }])] })
  expect(headers()).toEqual(['Change', 'Assessment', 'Before · Unavailable', 'After · Current test'])
  expect(card('legacy')?.querySelector('tbody')?.textContent).toContain('Unavailable')
  expect(card('legacy')?.querySelector('tbody')?.textContent).not.toContain('Not present')
  const filter = card('legacy')!.querySelector('select')!
  act(() => { filter.value = 'stronger'; filter.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(headers()).toHaveLength(4)
  expect(card('legacy')?.textContent).toContain('No changes match this assessment')
})

it('filters by each assertion assessment without relabelling it with the test verdict', () => {
  const weak = WEAKER_SPEC.strength!.tests[0]
  const spec: DirtySpecSummary = { ...WEAKER_SPEC, strength: { ...WEAKER_SPEC.strength!, tests: [{ ...weak, changes: [
    { ...weak.changes[0], verdict: 'stronger' },
    { kind: 'removed', verdict: 'unclassifiable', before: { line: 5, source: 'customCheck()', reason: 'Unknown helper' }, reason: 'Unknown helper' },
  ] }] } }
  render({ features: [feature('mixed', [spec])] })
  const filter = card('mixed')!.querySelector('select')!
  act(() => { filter.value = 'stronger'; filter.dispatchEvent(new Event('change', { bubbles: true })) })
  expect([...card('mixed')!.querySelectorAll('tbody [data-assessment]')].map((node) => node.getAttribute('data-assessment'))).toEqual(['stronger'])
  expect(card('mixed')?.querySelector('tbody')?.textContent).toContain('applies voucher')
  expect(card('mixed')?.querySelector('tbody')?.textContent).not.toContain('customCheck()')
  act(() => { filter.value = 'unclassifiable'; filter.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(card('mixed')?.querySelector('tbody')?.textContent).toContain('Cannot classify: Unknown helper')
  expect(card('mixed')?.querySelector('tbody')?.textContent).toContain('customCheck()')
})
