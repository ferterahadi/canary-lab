// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkeletonBar, SkeletonLines, SkeletonPanel, SkeletonRows, awaitingFor } from './Skeleton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('awaitingFor — a settled stage never promises more', () => {
  it('is undefined once the stage has produced everything it will', () => {
    expect(awaitingFor('done', false)).toBeUndefined()
    expect(awaitingFor('skipped', false)).toBeUndefined()
    // Even a `live` flag cannot resurrect a placeholder on a settled stage —
    // the merged run/heal row can read `running` while its primary is done, and
    // a skeleton there would claim a second set of results is coming.
    expect(awaitingFor('done', true)).toBeUndefined()
  })

  it('separates the three reasons a slot is empty (R86)', () => {
    expect(awaitingFor('running', true)).toBe('live')
    // Parked: nothing is coming until the user acts.
    expect(awaitingFor('pending', false)).toBe('idle')
    expect(awaitingFor('waiting-for-approval', false)).toBe('idle')
    // Stopped short: these slots stay empty until a retry, which is a different
    // thing to say than "not yet" — and the only state that used to be
    // indistinguishable from a parked one.
    expect(awaitingFor('failed', false)).toBe('failed')
  })
})

describe('Skeleton primitives', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('the FILL says why the slot is empty, so the three states differ with motion off', () => {
    const bar = () => container.querySelector<HTMLElement>('[data-testid="skeleton-bar"]')!
    // Live: the only FILLED bar — a bar is the promise of a value.
    act(() => root.render(<SkeletonBar awaiting="live" />))
    expect(bar().className).toContain('cl-skeleton')
    expect(bar().style.background).toBe('var(--border-strong)')
    // Idle: an outline holding the slot open, with nothing inside it. (happy-dom
    // drops the colour from a border shorthand, so the hue is not assertable
    // here — the state attribute below is what a caller reads it back by.)
    act(() => root.render(<SkeletonBar awaiting="idle" />))
    expect(bar().className).not.toContain('cl-skeleton')
    expect(bar().style.border).toContain('solid')
    expect(bar().style.background).toBe('')
    expect(bar().dataset.awaiting).toBe('idle')
    // Failed: the same held-open outline, hued danger and struck through — never
    // a fill that could be mistaken for a value about to land.
    act(() => root.render(<SkeletonBar awaiting="failed" />))
    expect(bar().className).toContain('cl-skeleton-void')
    // The sweep is `live`'s alone — a struck slot is not being worked on.
    expect(bar().className).not.toMatch(/cl-skeleton(?!-)/)
    expect(bar().style.background).toBe('')
    // Same held-open outline as idle — the class carries the strike and the hue.
    expect(bar().style.border).toContain('solid')
    expect(bar().dataset.awaiting).toBe('failed')
  })

  it('the row bead reddens on a failed stage — the dot a retry is scanned by', () => {
    const bead = () => container.querySelector<HTMLElement>('[data-testid="skeleton-row"] span')!
    act(() => root.render(<SkeletonRows awaiting="failed" rows={1} />))
    expect(bead().style.borderColor).toBe('var(--danger)')
    act(() => root.render(<SkeletonRows awaiting="idle" rows={1} />))
    expect(bead().style.borderColor).toBe('var(--border-strong)')
  })

  it('line widths repeat deterministically, so a re-render never reshuffles the card', () => {
    const widths = (): string[] =>
      [...container.querySelectorAll<HTMLElement>('[data-testid="skeleton-bar"]')].map((el) => el.style.width)
    act(() => root.render(<SkeletonLines awaiting="idle" rows={5} />))
    const first = widths()
    expect(first).toHaveLength(5)
    // The cycle wraps rather than running out of widths.
    expect(first[4]).toBe(first[0])
    act(() => root.render(<SkeletonLines awaiting="idle" rows={5} />))
    expect(widths()).toEqual(first)
  })

  it('a row is an indicator plus a title, with the sub-line optional', () => {
    act(() => root.render(<SkeletonRows awaiting="idle" rows={2} />))
    expect(container.querySelectorAll('[data-testid="skeleton-row"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-testid="skeleton-bar"]')).toHaveLength(4)
    act(() => root.render(<SkeletonRows awaiting="idle" rows={2} sub={false} />))
    expect(container.querySelectorAll('[data-testid="skeleton-bar"]')).toHaveLength(2)
  })

  it('the panel keeps the REAL kicker — naming what is coming is the point', () => {
    act(() => root.render(<SkeletonPanel kicker="Boot check" awaiting="live" testId="boot-skeleton" variant="rows" rows={3} />))
    const card = container.querySelector('[data-testid="boot-skeleton"]')
    expect(card?.textContent).toContain('Boot check')
    expect(card?.querySelectorAll('[data-testid="skeleton-row"]')).toHaveLength(3)
    act(() => root.render(<SkeletonPanel kicker="Composition" awaiting="idle" rows={2} />))
    expect(container.querySelector('[data-testid="skeleton-panel"]')?.textContent).toContain('Composition')
    expect(container.querySelectorAll('[data-testid="skeleton-lines"]')).toHaveLength(1)
  })
})
