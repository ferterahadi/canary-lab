// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DisabledControlTooltip, Tooltip, TOOLTIP_ANCHOR_ATTR } from './Tooltip'

/** happy-dom reports every rect as zero, so a positioning test has to supply its
 *  own. Returns a rect whose `bottom`/`left` are what the assertions read. */
function stubRect(el: Element, rect: { top: number; bottom: number; left: number; width: number }) {
  el.getBoundingClientRect = () => ({
    ...rect, right: rect.left + rect.width, height: rect.bottom - rect.top, x: rect.left, y: rect.top,
    toJSON: () => ({}),
  }) as DOMRect
}

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

describe('Tooltip', () => {
  it('shows the label on hover (portaled) and hides on leave, without wrapping the child', () => {
    act(() => {
      root.render(
        <Tooltip label="Feature config">
          <button type="button" data-testid="trigger">x</button>
        </Tooltip>,
      )
    })
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!
    // No wrapper element — the trigger is a direct child of the container.
    expect(trigger.parentElement).toBe(container)
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()

    act(() => { trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const tip = document.body.querySelector('[role="tooltip"]')
    expect(tip?.textContent).toBe('Feature config')

    act(() => { trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
  })

  // A tall trigger that hovers as one piece (a stage fact tile) still wants the
  // tip beside the small mark that advertised it, not a tile-height below.
  it('positions from the marked sub-element while the whole child stays the hover target', () => {
    act(() => {
      root.render(
        <Tooltip label="t">
          <div data-testid="trigger">
            <span data-testid="mark" {...{ [TOOLTIP_ANCHOR_ATTR]: '' }}>?</span>
          </div>
        </Tooltip>,
      )
    })
    const trigger = container.querySelector<HTMLDivElement>('[data-testid="trigger"]')!
    stubRect(trigger, { top: 100, bottom: 200, left: 0, width: 300 })
    stubRect(container.querySelector('[data-testid="mark"]')!, { top: 104, bottom: 116, left: 80, width: 12 })

    // Hovering anywhere on the tall child opens it…
    act(() => { trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const tip = document.body.querySelector<HTMLDivElement>('[role="tooltip"]')!
    // …but the tip hangs off the MARK's bottom (116 + 6 gap), not the child's 200.
    expect(tip.style.top).toBe('122px')
  })

  it("preserves the child's own onClick", () => {
    const onClick = vi.fn()
    act(() => {
      root.render(
        <Tooltip label="t">
          <button type="button" data-testid="trigger" onClick={onClick}>x</button>
        </Tooltip>,
      )
    })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')?.click() })
    expect(onClick).toHaveBeenCalled()
  })

  it('anchors a disabled control tooltip to a hoverable wrapper', () => {
    act(() => {
      root.render(
        <DisabledControlTooltip>
          <button type="button" data-testid="trigger" disabled title="Continue in the external agent">Continue</button>
        </DisabledControlTooltip>,
      )
    })
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!
    const wrapper = trigger.parentElement!
    expect(wrapper).not.toBe(container)
    expect(trigger.style.pointerEvents).toBe('none')

    act(() => { wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Continue in the external agent')
  })

  it('leaves an enabled control wrapper-free', () => {
    act(() => {
      root.render(
        <DisabledControlTooltip>
          <button type="button" data-testid="trigger" title="Continue">Continue</button>
        </DisabledControlTooltip>,
      )
    })
    expect(container.querySelector('[data-testid="trigger"]')?.parentElement).toBe(container)
  })
})
