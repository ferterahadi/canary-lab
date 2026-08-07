// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FirstRunGuide } from './FirstRunGuide'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function click(selector: string): void {
  const el = container.querySelector<HTMLButtonElement>(selector)
  if (!el) throw new Error(`no element for ${selector}`)
  act(() => { el.click() })
}

describe('FirstRunGuide', () => {
  it('names what Run is about to do on the first step', () => {
    act(() => { root.render(<FirstRunGuide step="run-suite" onDismiss={() => {}} />) })
    expect(container.querySelector('[data-testid="first-run-guide-run-suite"]')).toBeTruthy()
    expect(container.textContent).toContain('Press Run to watch a repair')
  })

  // Step 1's action IS the Run button beside it — a second button here would be
  // two ways to start the same run, and only one of them would carry the cue.
  it('step one offers no button of its own', () => {
    act(() => { root.render(<FirstRunGuide step="run-suite" onDismiss={() => {}} onAction={() => {}} />) })
    expect(container.querySelectorAll('.cl-button-primary')).toHaveLength(0)
  })

  it('step two launches the flight', () => {
    const onAction = vi.fn()
    act(() => { root.render(<FirstRunGuide step="start-flight" onDismiss={() => {}} onAction={onAction} />) })
    expect(container.textContent).toContain('flight-app')
    click('.cl-button-primary')
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('reports a dismissal', () => {
    const onDismiss = vi.fn()
    act(() => { root.render(<FirstRunGuide step="start-flight" onDismiss={onDismiss} />) })
    click('[aria-label="Dismiss this tip"]')
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  // Without an action handler the button would be a dead control; the card still
  // has something to say, so it renders as prose only.
  it('omits step two\'s button when no handler is wired', () => {
    act(() => { root.render(<FirstRunGuide step="start-flight" onDismiss={() => {}} />) })
    expect(container.querySelectorAll('.cl-button-primary')).toHaveLength(0)
  })
})
