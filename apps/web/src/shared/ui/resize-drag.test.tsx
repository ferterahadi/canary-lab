// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ResizablePanels } from './ResizablePanels'
import { VerticalSplit } from './VerticalSplit'
import { mountRoot } from '@/test-helpers/mount-root'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
mountRoot({ attach: true, onMount: (mounted) => ({ container, root } = mounted) })

it('tracks horizontal dragging immediately and saves the final widths once', () => {
  const setItem = vi.spyOn(window.localStorage, 'setItem')
  act(() => root.render(<ResizablePanels
    panels={[
      { id: 'left', minWidth: 100, defaultWidth: 200, collapsible: true },
      { id: 'right', minWidth: 100, defaultWidth: 200, collapsible: false },
    ]}
    contentByPanel={{ left: 'Left', right: 'Right' }}
  />))

  const handle = container.querySelector<HTMLElement>('.resize-handle')!
  const pane = container.querySelector<HTMLElement>('.cl-panel')!.parentElement!
  act(() => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 })))
  expect(pane.className).not.toContain('transition-[width]')

  act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientX: 130, buttons: 1 })))
  expect(pane.style.width).toBe('230px')
  expect(setItem).not.toHaveBeenCalled()

  act(() => document.dispatchEvent(new MouseEvent('mouseup')))
  expect(pane.className).toContain('transition-[width]')
  expect(setItem).toHaveBeenCalledOnce()
  expect(JSON.parse(window.localStorage.getItem('canary-lab.panel-widths')!)).toEqual({ left: 230, right: 170 })
})

it('tracks vertical dragging immediately and saves the final height once', () => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
  const setItem = vi.spyOn(window.localStorage, 'setItem')
  act(() => root.render(<VerticalSplit
    storageKey="test.vertical-height"
    defaultTopPercent={25}
    minTopPx={120}
    minBottomPx={320}
    top="Top"
    bottom="Bottom"
  />))

  const handle = container.querySelector<HTMLElement>('.vertical-resize-handle')!
  const pane = handle.previousElementSibling as HTMLElement
  act(() => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 100 })))
  expect(pane.className).not.toContain('transition-[height]')

  act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientY: 130, buttons: 1 })))
  expect(pane.style.height).toBe('205px')
  expect(setItem).not.toHaveBeenCalled()

  act(() => document.dispatchEvent(new MouseEvent('mouseup')))
  expect(pane.className).toContain('transition-[height]')
  expect(setItem).toHaveBeenCalledOnce()
  expect(window.localStorage.getItem('test.vertical-height')).toBe('205')
})

function mountSplitter(kind: 'horizontal' | 'vertical') {
  if (kind === 'horizontal') {
    act(() => root.render(<ResizablePanels
      panels={[
        { id: 'left', minWidth: 100, defaultWidth: 200, collapsible: true },
        { id: 'right', minWidth: 100, defaultWidth: 200, collapsible: false },
      ]}
      contentByPanel={{ left: 'Left', right: 'Right' }}
    />))
  } else {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
    act(() => root.render(<VerticalSplit storageKey="test.vertical-height" defaultTopPercent={25} minTopPx={120} minBottomPx={320} top="Top" bottom="Bottom" collapsible />))
  }
  const handle = container.querySelector<HTMLElement>(kind === 'horizontal' ? '.resize-handle' : '.vertical-resize-handle')!
  const pane = handle.previousElementSibling as HTMLElement
  const coords = (position: number) => kind === 'horizontal' ? { clientX: position } : { clientY: position }
  return {
    handle,
    size: () => kind === 'horizontal' ? pane.style.width : pane.style.height,
    grab: () => act(() => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...coords(100) }))),
    move: (position: number, buttons = 1) => act(() => document.dispatchEvent(new MouseEvent('mousemove', { ...coords(position), buttons }))),
  }
}

it.each(['horizontal', 'vertical'] as const)('releases a %s splitter after missed mouseup and saves only its last held position', (kind) => {
  const setItem = vi.spyOn(window.localStorage, 'setItem')
  const split = mountSplitter(kind)
  split.grab()
  expect(split.handle.classList.contains('dragging')).toBe(true)
  split.move(130)
  const size = split.size()
  expect(setItem).not.toHaveBeenCalled()
  split.move(900, 0)
  expect(split.size()).toBe(size)
  expect(split.handle.classList.contains('dragging')).toBe(false)
  expect(setItem).toHaveBeenCalledOnce()
  split.move(800)
  expect(split.size()).toBe(size)
  split.grab()
  split.move(120)
  expect(parseFloat(split.size())).toBe(parseFloat(size) + 20)
  act(() => document.dispatchEvent(new MouseEvent('mouseup')))
  expect(setItem).toHaveBeenCalledTimes(2)
})

it.each(['horizontal', 'vertical'] as const)('clamps a %s splitter and measures subsequent moves from the same origin', (kind) => {
  const split = mountSplitter(kind)
  split.grab()
  split.move(-1000)
  expect(split.size()).toBe(kind === 'horizontal' ? '100px' : '120px')
  split.move(1000)
  expect(split.size()).toBe(kind === 'horizontal' ? '300px' : '380px')
  split.move(120)
  expect(split.size()).toBe(kind === 'horizontal' ? '220px' : '195px')
})

it.each(['horizontal', 'vertical'] as const)('does not persist a %s click without movement or an unmounted drag', (kind) => {
  const setItem = vi.spyOn(window.localStorage, 'setItem')
  const split = mountSplitter(kind)
  split.grab()
  act(() => document.dispatchEvent(new MouseEvent('mouseup')))
  expect(setItem).not.toHaveBeenCalled()
  split.grab()
  split.move(130)
  act(() => root.render(null))
  split.move(160)
  act(() => document.dispatchEvent(new MouseEvent('mouseup')))
  expect(setItem).not.toHaveBeenCalled()
})
