// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAnchoredPosition } from './use-anchored-position'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function Probe({ open, reposition }: { open: boolean; reposition: () => void }) {
  useAnchoredPosition(open, reposition)
  return <div data-testid="scroller" />
}

describe('useAnchoredPosition', () => {
  it('measures on open and on resize or any scroll, and stops once closed', () => {
    const reposition = vi.fn()
    act(() => { root.render(<Probe open={false} reposition={reposition} />) })
    expect(reposition).not.toHaveBeenCalled()

    act(() => { root.render(<Probe open reposition={reposition} />) })
    expect(reposition).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('resize'))
    // A scrolling ancestor's scroll does not bubble to window; only the capture
    // listener hears it.
    container.querySelector('[data-testid="scroller"]')!.dispatchEvent(new Event('scroll'))
    expect(reposition).toHaveBeenCalledTimes(3)

    act(() => { root.render(<Probe open={false} reposition={reposition} />) })
    window.dispatchEvent(new Event('resize'))
    container.querySelector('[data-testid="scroller"]')!.dispatchEvent(new Event('scroll'))
    expect(reposition).toHaveBeenCalledTimes(3)
  })
})
