import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { mountRoot } from '@/test-helpers/mount-root'
import { Tab } from './Tab'

let container: HTMLDivElement
let root: Root
mountRoot({ attach: true, onMount: (m) => { container = m.container; root = m.root } })

// happy-dom lays nothing out, so geometry comes from each element's
// `data-layout`: its box, and for the row its scroll and client widths.
type Layout = { left: number; right: number; scrollWidth?: number; clientWidth?: number }
const layoutOf = (el: Element): Layout | undefined => {
  const raw = (el as HTMLElement).dataset?.layout
  return raw ? JSON.parse(raw) as Layout : undefined
}
const scrolled = new WeakMap<Element, number>()

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const { left, right } = layoutOf(this) ?? { left: 0, right: 0 }
    return { left, right, top: 0, bottom: 0, width: right - left, height: 0, x: left, y: 0, toJSON: () => ({}) } as DOMRect
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) { return layoutOf(this)?.scrollWidth ?? 0 })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) { return layoutOf(this)?.clientWidth ?? 0 })
  vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'get').mockImplementation(function (this: Element) { return scrolled.get(this) ?? 0 })
  vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'set').mockImplementation(function (this: Element, v: number) { scrolled.set(this, v) })
})
afterEach(() => vi.restoreAllMocks())

const ROW = { left: 0, right: 100, scrollWidth: 200, clientWidth: 100 }

function renderRow(active: 'a' | 'b' | null, tab: Layout, row: Layout = ROW, startScroll = 0) {
  act(() => {
    root.render(
      <nav data-layout={JSON.stringify(row)} ref={(el) => { if (el && !scrolled.has(el)) scrolled.set(el, startScroll) }}>
        <Tab active={active === 'a'} data-layout={JSON.stringify({ left: 0, right: 40 })}>A</Tab>
        <Tab active={active === 'b'} data-layout={JSON.stringify(tab)}>B</Tab>
      </nav>,
    )
  })
  return container.querySelector('nav')!
}

describe('Tab in a row that scrolls sideways', () => {
  it('scrolls the row, not the page, until an active tab past its right edge is whole', () => {
    expect(renderRow('b', { left: 90, right: 140 }).scrollLeft).toBe(40)
  })

  it('scrolls back for an active tab cut off at the left edge', () => {
    expect(renderRow('b', { left: -20, right: 30 }, ROW, 50).scrollLeft).toBe(30)
  })

  it('reveals a tab when it becomes active, not only on mount', () => {
    const row = renderRow('a', { left: 90, right: 140 })
    expect(row.scrollLeft).toBe(0)
    renderRow('b', { left: 90, right: 140 })
    expect(row.scrollLeft).toBe(40)
  })

  it('leaves the row alone when the active tab is already whole, or nothing overflows', () => {
    expect(renderRow('b', { left: 50, right: 90 }).scrollLeft).toBe(0)
    act(() => root.render(<></>))
    expect(renderRow('b', { left: 90, right: 140 }, { left: 0, right: 100, scrollWidth: 100, clientWidth: 100 }).scrollLeft).toBe(0)
  })
})
