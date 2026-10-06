import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteIconButton, RetestIconButton } from './RunActionsKebab'

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

describe.each(['retest', 'delete'] as const)('%s icon interaction', (kind) => {
  function render(disabled: boolean, stopClick = false) {
    const parentClick = vi.fn()
    const parentKey = vi.fn()
    const activate = vi.fn((event: React.MouseEvent) => { if (stopClick) event.stopPropagation() })
    act(() => root.render(
      <button onClick={parentClick} onKeyDown={parentKey}>
        {kind === 'retest'
          ? <RetestIconButton disabled={disabled} spinning={false} onClick={activate} />
          : <DeleteIconButton disabled={disabled} onClick={activate} />}
      </button>,
    ))
    return { icon: container.querySelector<HTMLElement>('[role="button"]')!, activate, parentClick, parentKey }
  }

  it('preserves enabled clicks and lets the caller control bubbling', () => {
    const first = render(false)
    expect(first.icon.tagName).toBe('SPAN')
    expect(first.icon.tabIndex).toBe(0)
    expect(first.icon.getAttribute('aria-disabled')).toBe('false')
    act(() => first.icon.click())
    expect(first.activate).toHaveBeenCalledTimes(1)
    expect(first.parentClick).toHaveBeenCalledTimes(1)
    const second = render(false, true)
    act(() => second.icon.click())
    expect(second.activate).toHaveBeenCalledTimes(1)
    expect(second.parentClick).not.toHaveBeenCalled()
  })

  it.each(['Enter', ' '])('activates exactly once on %j and stops the row handling that key', (key) => {
    const { icon, activate, parentKey } = render(false)
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    act(() => icon.dispatchEvent(event))
    expect(activate).toHaveBeenCalledTimes(1)
    expect(parentKey).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves unrelated keys to the row', () => {
    const { icon, activate, parentKey } = render(false)
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    act(() => icon.dispatchEvent(event))
    expect(activate).not.toHaveBeenCalled()
    expect(parentKey).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
  })

  it('removes disabled icons from the tab order and suppresses clicks without swallowing keys', () => {
    const { icon, activate, parentClick, parentKey } = render(true)
    expect(icon.tabIndex).toBe(-1)
    expect(icon.getAttribute('aria-disabled')).toBe('true')
    act(() => icon.click())
    expect(parentClick).not.toHaveBeenCalled()
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      act(() => icon.dispatchEvent(event))
      expect(event.defaultPrevented).toBe(false)
    }
    expect(activate).not.toHaveBeenCalled()
    expect(parentKey).toHaveBeenCalledTimes(2)
  })
})

it('preserves the spinning retest state and unavailable-delete explanation', () => {
  act(() => root.render(<>
    <RetestIconButton disabled spinning onClick={vi.fn()} />
    <DeleteIconButton disabled disabledReason="Run is active" onClick={vi.fn()} />
  </>))
  const [retest, remove] = container.querySelectorAll<HTMLElement>('[role="button"]')
  expect(retest.title).toBe('Retesting remaining tests…')
  expect(retest.getAttribute('aria-label')).toBe(retest.title)
  expect(retest.className).toContain('cursor-wait')
  expect(retest.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
  expect(remove.title).toBe('Run is active')
  expect(remove.getAttribute('aria-label')).toBe(remove.title)
  expect(remove.className).toContain('cursor-not-allowed')
})
