// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import { CoverageLedgerPage } from './CoverageLedgerPage'
import { FOLLOW_PREF_KEY } from './CoverageHeader'
import { LEDGER, fire } from './__fixtures__/CoverageLedgerPage.part2-fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Follow mode: an opt-in chip beside the strength filter. While it is on,
// resting the pointer on a row in one ledger scrolls the OTHER ledger so the
// related row is in view — and only when it is not already fully visible, so a
// hover never jitters a pane that already shows the answer. Off by default,
// remembered across visits.

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    getFeatureCoverage: vi.fn(),
    listFeatureDocs: vi.fn(),
    getProjectConfig: vi.fn(),
    listCoverageJobs: vi.fn(),
    getFeatureTests: vi.fn(),
    openEditor: vi.fn(),
    acceptRequirementWording: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

// happy-dom lays nothing out, so the panes and rows get the geometry the test
// needs: both panes show 0–300px; R1 and test #1 sit below the fold, R2 and
// test #2 are already in view.
const RECTS: Record<string, { top: number; bottom: number }> = {
  'prd-pane': { top: 0, bottom: 300 },
  'tests-pane': { top: 0, bottom: 300 },
  'req-R1': { top: 500, bottom: 530 },
  'req-R2': { top: 40, bottom: 70 },
  'test-adds item': { top: 600, bottom: 630 },
  'test-sends receipt': { top: 10, bottom: 40 },
}

const scrolled: string[] = []
const realRect = Element.prototype.getBoundingClientRect

beforeEach(() => {
  scrolled.length = 0
  localStorage.clear()
  vi.mocked(api.getProjectConfig).mockResolvedValue({ healAgent: 'claude', editor: 'auto', personalWikiPath: null })
  vi.mocked(api.getFeatureCoverage).mockResolvedValue(structuredClone(LEDGER))
  vi.mocked(api.listFeatureDocs).mockResolvedValue({ feature: 'checkout', docs: [], hasPrdSummary: true, sourceDocCount: 1, docsDrift: false })
  vi.mocked(api.listCoverageJobs).mockResolvedValue([])
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const r = RECTS[this.getAttribute('data-testid') ?? ''] ?? { top: 0, bottom: 0 }
    return { ...r, left: 0, right: 0, width: 0, height: r.bottom - r.top, x: 0, y: r.top, toJSON: () => ({}) } as DOMRect
  }
  ;(Element.prototype as unknown as { scrollIntoView: (this: Element) => void }).scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute('data-testid') ?? '?')
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  vi.useRealTimers()
  act(() => { root.unmount() })
  container.remove()
  Element.prototype.getBoundingClientRect = realRect
  vi.clearAllMocks()
})

async function mount(): Promise<void> {
  await act(async () => { root.render(<CoverageLedgerPage feature="checkout" onClose={() => {}} />) })
  await act(async () => { await Promise.resolve() })
  // The debounce is the only timer under test; arm fake timers after the
  // mount so the data fetches above settle on real ones.
  vi.useFakeTimers()
}

const chip = () => container.querySelector<HTMLButtonElement>('[data-testid="follow-toggle"]')
const turnOn = () => act(() => { chip()?.click() })
const settle = () => act(() => { vi.advanceTimersByTime(200) })
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)

describe('CoverageLedgerPage — Follow chip', () => {
  it('sits at the end of the strength-chip row, off by default', async () => {
    await mount()
    const c = chip()
    expect(c?.textContent).toContain('Follow')
    expect(c?.getAttribute('data-on')).toBe('false')
    expect(c?.closest('[data-testid="strength-filter"]')).toBeTruthy()
  })

  it('toggles on click and remembers the choice', async () => {
    await mount()
    turnOn()
    expect(chip()?.getAttribute('data-on')).toBe('true')
    expect(localStorage.getItem(FOLLOW_PREF_KEY)).toBe('on')
    turnOn()
    expect(chip()?.getAttribute('data-on')).toBe('false')
    expect(localStorage.getItem(FOLLOW_PREF_KEY)).toBe('off')
  })

  it('comes back on when the last visit left it on', async () => {
    localStorage.setItem(FOLLOW_PREF_KEY, 'on')
    await mount()
    expect(chip()?.getAttribute('data-on')).toBe('true')
  })
})

describe('CoverageLedgerPage — follow scrolling', () => {
  it('does nothing while off — hover only highlights', async () => {
    await mount()
    fire(q('test-adds item'), 'enter')
    settle()
    expect(q('req-R1')?.getAttribute('data-active')).toBe('true')
    expect(scrolled).toEqual([])
  })

  it('hovering a test scrolls the requirements ledger to the requirement it claims', async () => {
    await mount()
    turnOn()
    fire(q('test-adds item'), 'enter')
    expect(scrolled).toEqual([]) // not before the pointer has rested
    settle()
    expect(scrolled).toEqual(['req-R1'])
  })

  it('hovering a requirement scrolls the tests ledger to its first test', async () => {
    await mount()
    turnOn()
    fire(q('req-R1'), 'enter')
    settle()
    expect(scrolled).toEqual(['test-adds item'])
  })

  it('leaves a pane alone when the related row is already fully in view', async () => {
    await mount()
    turnOn()
    fire(q('test-sends receipt'), 'enter') // → R2, already visible
    settle()
    fire(q('req-R2'), 'enter') // → test #2, already visible
    settle()
    expect(scrolled).toEqual([])
  })

  it('a pointer that moves on before resting scrolls only for where it stopped', async () => {
    await mount()
    turnOn()
    fire(q('test-sends receipt'), 'enter')
    act(() => { vi.advanceTimersByTime(60) })
    fire(q('test-adds item'), 'enter')
    settle()
    expect(scrolled).toEqual(['req-R1'])
  })

  it('a pointer that leaves before resting scrolls nothing', async () => {
    await mount()
    turnOn()
    fire(q('test-adds item'), 'enter')
    fire(q('test-adds item'), 'leave')
    settle()
    expect(scrolled).toEqual([])
  })

  it('a requirement with no test scrolls nothing', async () => {
    await mount()
    turnOn()
    fire(q('req-R3'), 'enter')
    settle()
    expect(scrolled).toEqual([])
  })
})
