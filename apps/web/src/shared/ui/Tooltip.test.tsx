// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tooltip } from './Tooltip'

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
})
