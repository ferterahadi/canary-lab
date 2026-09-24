// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ResizablePanels } from './ResizablePanels'
import { VerticalSplit } from './VerticalSplit'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

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

  act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientX: 130 })))
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

  act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientY: 130 })))
  expect(pane.style.height).toBe('205px')
  expect(setItem).not.toHaveBeenCalled()

  act(() => document.dispatchEvent(new MouseEvent('mouseup')))
  expect(pane.className).toContain('transition-[height]')
  expect(setItem).toHaveBeenCalledOnce()
  expect(window.localStorage.getItem('test.vertical-height')).toBe('205')
})
