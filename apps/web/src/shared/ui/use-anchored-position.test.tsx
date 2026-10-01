// @vitest-environment happy-dom

import { act, useLayoutEffect } from 'react'
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

function Probe({ open, reposition, timing }: { open: boolean; reposition: () => void; timing: 'effect' | 'layout' }) {
  useAnchoredPosition(open, reposition, timing)
  return <div data-testid="scroller" />
}

describe('useAnchoredPosition', () => {
  it.each(['effect', 'layout'] as const)('measures and releases scroll/resize listeners in %s mode', (timing) => {
    const reposition = vi.fn()
    act(() => { root.render(<Probe timing={timing} open={false} reposition={reposition} />) })
    expect(reposition).not.toHaveBeenCalled()

    act(() => { root.render(<Probe timing={timing} open reposition={reposition} />) })
    expect(reposition).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('resize'))
    // A scrolling ancestor's scroll does not bubble to window; only the capture
    // listener hears it.
    container.querySelector('[data-testid="scroller"]')!.dispatchEvent(new Event('scroll'))
    expect(reposition).toHaveBeenCalledTimes(3)

    act(() => { root.render(<Probe timing={timing} open={false} reposition={reposition} />) })
    window.dispatchEvent(new Event('resize'))
    container.querySelector('[data-testid="scroller"]')!.dispatchEvent(new Event('scroll'))
    expect(reposition).toHaveBeenCalledTimes(3)
  })
})

it('positions layout consumers before later layout effects without changing the default timing', () => {
  const order: string[] = []
  function TimingProbe() {
    useAnchoredPosition(true, () => { order.push('passive') })
    useAnchoredPosition(true, () => { order.push('position') }, 'layout')
    useLayoutEffect(() => { order.push('layout') }, [])
    return null
  }
  act(() => root.render(<TimingProbe />))
  expect(order).toEqual(['position', 'layout', 'passive'])
})
