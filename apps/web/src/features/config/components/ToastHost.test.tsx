// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastHost, type ToastItem } from './atoms'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

const toast = (over: Partial<ToastItem> = {}): ToastItem => ({
  id: 'fl_1',
  title: 'checkout needs input',
  body: 'Requirements is waiting for you',
  ...over,
})

describe('ToastHost (R51)', () => {
  it('renders nothing without toasts, a card per toast otherwise', () => {
    act(() => { root.render(<ToastHost toasts={[]} onDismiss={vi.fn()} />) })
    expect(container.querySelector('[data-testid="toast-host"]')).toBeNull()

    act(() => { root.render(<ToastHost toasts={[toast()]} onDismiss={vi.fn()} />) })
    const card = container.querySelector('[data-testid="toast-fl_1"]')
    expect(card?.textContent).toContain('checkout needs input')
    expect(card?.textContent).toContain('Requirements is waiting for you')
  })

  it('clicking the card navigates AND dismisses; the ✕ only dismisses', () => {
    const onClick = vi.fn()
    const onDismiss = vi.fn()
    act(() => { root.render(<ToastHost toasts={[toast({ onClick })]} onDismiss={onDismiss} />) })
    act(() => {
      container.querySelector<HTMLElement>('[data-testid="toast-fl_1"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith('fl_1')

    onClick.mockClear()
    onDismiss.mockClear()
    act(() => { root.render(<ToastHost toasts={[toast({ onClick })]} onDismiss={onDismiss} />) })
    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClick).not.toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalledWith('fl_1')
  })

  it('auto-dismisses after the timeout', () => {
    const onDismiss = vi.fn()
    act(() => { root.render(<ToastHost toasts={[toast()]} onDismiss={onDismiss} />) })
    act(() => { vi.advanceTimersByTime(8000) })
    expect(onDismiss).toHaveBeenCalledWith('fl_1')
  })
})
