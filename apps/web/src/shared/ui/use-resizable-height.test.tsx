// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useResizableHeight } from './use-resizable-height'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'test-panel-height'

/** Renders the hook onto a handle + a height readout, and OWNS the collapsed
 *  flag the way the real consumer does — so every assertion reads what a reader
 *  would see after the controlled round trip, not the hook's internals. */
function Harness({ defaultPx = 200, minPx = 100, maxPx = 500, collapsePx = 68, startCollapsed = false }: {
  defaultPx?: number
  minPx?: number
  maxPx?: number
  collapsePx?: number
  startCollapsed?: boolean
}) {
  const [collapsed, setCollapsed] = useState(startCollapsed)
  const { height, dragging, handleProps } = useResizableHeight({
    storageKey: KEY, defaultPx, minPx, maxPx, collapsePx, collapsed, onCollapsedChange: setCollapsed,
  })
  return (
    <div>
      <div {...handleProps} data-testid="handle" className={dragging ? 'dragging' : ''} />
      <div data-testid="panel" data-collapsed={collapsed} style={{ height: collapsed ? 0 : height }}>{height}</div>
    </div>
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const render = (props: Parameters<typeof Harness>[0] = {}): void => {
  act(() => { root.render(<Harness {...props} />) })
}
const panel = (): HTMLElement => container.querySelector<HTMLElement>('[data-testid="panel"]')!
const height = (): number => Number(panel().textContent)
const collapsed = (): boolean => panel().dataset.collapsed === 'true'
const handle = (): HTMLElement => container.querySelector<HTMLElement>('[data-testid="handle"]')!

function press(key: string, opts: { shiftKey?: boolean } = {}): void {
  act(() => {
    handle().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }))
  })
}

function grab(atY: number): void {
  act(() => {
    handle().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientY: atY }))
  })
}
function moveTo(y: number): void {
  act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientY: y, buttons: 1 })) })
}
function drag(fromY: number, toY: number): void {
  grab(fromY)
  moveTo(toY)
}

describe('useResizableHeight', () => {
  it('starts at the default and exposes the handle as a keyboard separator', () => {
    render()
    expect(height()).toBe(200)
    expect(handle().getAttribute('role')).toBe('separator')
    expect(handle().getAttribute('aria-orientation')).toBe('horizontal')
    expect(handle().getAttribute('aria-valuenow')).toBe('200')
    expect(handle().getAttribute('aria-valuemin')).toBe('0')
    expect(handle().getAttribute('aria-valuemax')).toBe('500')
    expect(handle().getAttribute('aria-valuetext')).toBe('200 pixels tall')
    expect(handle().tabIndex).toBe(0)
  })

  it('drags UP to grow the panel: the handle is its top edge, so a rising pointer adds height', () => {
    render()
    drag(400, 340)
    expect(height()).toBe(260)
    expect(handle().className).toContain('dragging')
    act(() => { document.dispatchEvent(new MouseEvent('mouseup')) })
    expect(handle().className).not.toContain('dragging')
  })

  it('drags DOWN to shrink, and clamps at the floor before the fold point', () => {
    render()
    drag(400, 460)
    expect(height()).toBe(140)
    // 100 → 68 is the fold gap: asked for 80, the edge parks on the floor
    // rather than folding — overshooting the floor is not yet a fold.
    drag(400, 460)
    expect(height()).toBe(100)
    expect(collapsed()).toBe(false)
  })

  it('clamps at the ceiling on a throw past the top', () => {
    render()
    drag(400, -900)
    expect(height()).toBe(500)
  })

  it('FOLDS when the edge is pushed past the fold point, and keeps the height for the way back', () => {
    render()
    // 200 - 140 = 60, which is at or below the 68 fold point.
    drag(400, 540)
    expect(collapsed()).toBe(true)
    // The height the reader had chosen is untouched, so reopening restores it.
    expect(height()).toBe(200)
    expect(handle().getAttribute('aria-valuenow')).toBe('0')
    expect(handle().getAttribute('aria-valuetext')).toBe('collapsed')
  })

  it('UNFOLDS when the edge is pulled back over the floor, from the fold point', () => {
    render({ startCollapsed: true })
    // Folded, the origin is the fold point (68) — a 32px pull clears the 100 floor.
    grab(400)
    moveTo(368)
    expect(collapsed()).toBe(false)
    expect(height()).toBe(100)
  })

  it('stays folded while the pull is still short of the floor', () => {
    render({ startCollapsed: true })
    grab(400)
    moveTo(390)
    expect(collapsed()).toBe(true)
    expect(height()).toBe(200)
  })

  it('measures every move from the drag origin, so a fast drag lands where the pointer is', () => {
    render()
    grab(400)
    moveTo(380)
    moveTo(300)
    // 400 → 300 is +100 from the ORIGIN, not +20 then +80 accumulated twice.
    expect(height()).toBe(300)
  })

  it('ignores mouse moves once the drag is released', () => {
    render()
    drag(400, 380)
    act(() => { document.dispatchEvent(new MouseEvent('mouseup')) })
    moveTo(100)
    expect(height()).toBe(220)
  })

  it('releases a drag whose mouseup never arrived, instead of following a pointer that is not dragging', () => {
    // A fast click can release inside the same frame React needs to commit the
    // drag, so the listener attaches after the mouseup is gone. The next move
    // reports no button held — that is the release.
    render()
    grab(400)
    expect(handle().className).toContain('dragging')
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientY: 200, buttons: 0 })) })
    expect(handle().className).not.toContain('dragging')
    // And the stray move did NOT resize anything.
    expect(height()).toBe(200)
  })

  it('double-click folds, and folds back open — the fast path that replaces the old button', () => {
    render()
    act(() => { handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(collapsed()).toBe(true)
    act(() => { handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(collapsed()).toBe(false)
  })

  it('adjusts by keyboard: arrows step, shift triples, Home jumps to the ceiling', () => {
    render()
    press('ArrowUp')
    expect(height()).toBe(216)
    press('ArrowDown')
    expect(height()).toBe(200)
    press('ArrowUp', { shiftKey: true })
    expect(height()).toBe(248)
    press('Home')
    expect(height()).toBe(500)
    expect(collapsed()).toBe(false)
  })

  it('reaches the fold from the keyboard too: End folds, ArrowUp brings it back', () => {
    render()
    press('End')
    expect(collapsed()).toBe(true)
    press('ArrowUp')
    expect(collapsed()).toBe(false)
    expect(height()).toBe(200)
    press('ArrowDown')
    expect(height()).toBe(184)
  })

  it('folds when a downward step would fall through the floor', () => {
    render({ defaultPx: 108, minPx: 100, maxPx: 500 })
    press('ArrowDown')
    expect(collapsed()).toBe(true)
  })

  it('Home un-folds as well as maxing, and ArrowDown while folded does nothing', () => {
    render({ startCollapsed: true })
    press('ArrowDown')
    expect(collapsed()).toBe(true)
    expect(height()).toBe(200)
    press('Home')
    expect(collapsed()).toBe(false)
    expect(height()).toBe(500)
  })

  it('Enter and Space toggle the fold, so the separator needs no pointer', () => {
    render()
    press('Enter')
    expect(collapsed()).toBe(true)
    press(' ')
    expect(collapsed()).toBe(false)
  })

  it('leaves unrelated keys alone', () => {
    render()
    press('Escape')
    expect(height()).toBe(200)
    expect(collapsed()).toBe(false)
  })

  it('persists the chosen height and restores it on the next mount', () => {
    render()
    press('ArrowUp')
    expect(localStorage.getItem(KEY)).toBe('216')
    act(() => { root.unmount() })
    root = createRoot(container)
    render()
    expect(height()).toBe(216)
  })

  it('re-clamps a stored height that no longer fits the range', () => {
    localStorage.setItem(KEY, '9000')
    render()
    expect(height()).toBe(500)
  })

  it('falls back to the default when the stored value is not a number', () => {
    localStorage.setItem(KEY, 'tall')
    render()
    expect(height()).toBe(200)
  })

  it('renders at the default when storage is unreadable, and keeps working when it is unwritable', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    render()
    expect(height()).toBe(200)
    press('ArrowUp')
    expect(height()).toBe(216)
    getItem.mockRestore()
    setItem.mockRestore()
  })

  it('clamps a default that sits outside its own range', () => {
    render({ defaultPx: 40, minPx: 100, maxPx: 500 })
    expect(height()).toBe(100)
  })
})
