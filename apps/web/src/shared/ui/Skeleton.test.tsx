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

  it('sweeps only while the stage is actually working', () => {
    expect(awaitingFor('running', true)).toBe('live')
    expect(awaitingFor('pending', false)).toBe('idle')
    expect(awaitingFor('failed', false)).toBe('idle')
    expect(awaitingFor('waiting-for-approval', false)).toBe('idle')
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

  it('the bar carries the sweep only when live — the shape alone must read as a placeholder', () => {
    act(() => root.render(<SkeletonBar awaiting="live" />))
    expect(container.querySelector('[data-testid="skeleton-bar"]')?.className).toContain('cl-skeleton')
    act(() => root.render(<SkeletonBar awaiting="idle" />))
    expect(container.querySelector('[data-testid="skeleton-bar"]')?.className).not.toContain('cl-skeleton')
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
