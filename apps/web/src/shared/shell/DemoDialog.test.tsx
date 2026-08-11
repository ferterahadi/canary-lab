// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DemoDialog } from './DemoDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

interface Overrides {
  open?: boolean
  suite?: string | null
  flightRepoAvailable?: boolean
  showDemo?: boolean | null
  onClose?: () => void
  onRunSuite?: () => void
  onStartFlight?: () => void
  onShowDemoChange?: (next: boolean) => void
}

function render(over: Overrides = {}): void {
  act(() => {
    root.render(
      <DemoDialog
        open={over.open ?? true}
        onClose={over.onClose ?? (() => {})}
        suite={over.suite === undefined ? 'storefront_journey' : over.suite}
        flightRepoAvailable={over.flightRepoAvailable ?? true}
        showDemo={over.showDemo === undefined ? true : over.showDemo}
        onRunSuite={over.onRunSuite ?? (() => {})}
        onStartFlight={over.onStartFlight ?? (() => {})}
        onShowDemoChange={over.onShowDemoChange ?? (() => {})}
      />,
    )
  })
}

const q = (testId: string): HTMLElement | null => document.querySelector(`[data-testid="${testId}"]`)

function click(el: Element | null): void {
  if (!el) throw new Error('nothing to click')
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('DemoDialog', () => {
  it('renders nothing while closed', () => {
    render({ open: false })
    expect(q('demo-dialog')).toBeNull()
  })

  it('offers both routes at once — neither is hidden behind the other', () => {
    render()
    expect(q('demo-option-repair')).not.toBeNull()
    expect(q('demo-option-flight')).not.toBeNull()
  })

  it('marks the repair route as the recommendation and gives it the only accent', () => {
    render()
    const repair = q('demo-option-repair')
    const flight = q('demo-option-flight')
    expect(repair?.textContent).toContain('Recommended')
    expect(flight?.textContent).not.toContain('Recommended')
    // One accent per view: the recommended card carries the accent wash, and
    // nothing else in the dialog is accented on top of it.
    expect(repair?.className).toContain('cl-branch-option-rec')
    expect(flight?.className).not.toContain('cl-branch-option-rec')
    expect(document.querySelectorAll('.cl-button-primary')).toHaveLength(0)
  })

  it('makes the whole option the action — no button nested inside a card', () => {
    render()
    expect(q('demo-option-repair')?.tagName).toBe('BUTTON')
    expect(q('demo-option-flight')?.querySelector('button')).toBeNull()
  })

  it('names the suite to watch, so a first-timer knows which row to follow', () => {
    render({ suite: 'storefront_journey' })
    expect(q('demo-option-repair')?.textContent).toContain('storefront_journey')
  })

  it('names the REPO for the flight, never a suite name it cannot promise', () => {
    // The flight's plan agent names the suite it authors, so the card points at
    // the repo it onboards instead of asserting a name that varies per run.
    render()
    expect(q('demo-option-flight')?.textContent).toContain('flight-app')
  })

  it('says what to watch for — the harness disagreeing is the whole point', () => {
    render()
    expect(q('demo-option-repair')?.textContent).toContain('disagree')
  })

  it('states each route\'s cost so the choice is honest', () => {
    render()
    expect(q('demo-option-repair')?.textContent).toContain('~4 min')
    expect(q('demo-option-flight')?.textContent).toContain('~25 min')
  })

  it('drops the repair route once the sample suite is deleted', () => {
    render({ suite: null })
    expect(q('demo-option-repair')).toBeNull()
    expect(q('demo-option-flight')).not.toBeNull()
  })

  it('drops the flight route once the bare repo is deleted', () => {
    render({ flightRepoAvailable: false })
    expect(q('demo-option-flight')).toBeNull()
    expect(q('demo-option-repair')).not.toBeNull()
  })

  it('starts the suite run', () => {
    const onRunSuite = vi.fn()
    render({ onRunSuite })
    click(q('demo-option-repair'))
    expect(onRunSuite).toHaveBeenCalledOnce()
  })

  it('starts the flight', () => {
    const onStartFlight = vi.fn()
    render({ onStartFlight })
    click(q('demo-option-flight'))
    expect(onStartFlight).toHaveBeenCalledOnce()
  })

  describe('the status-bar toggle', () => {
    it('is checked while the workspace shows demos', () => {
      render({ showDemo: true })
      expect((q('demo-show-toggle') as HTMLInputElement).checked).toBe(true)
    })

    it('reads as on while the config is still loading', () => {
      // Absent means on everywhere else (`!== false`); the box must not flicker
      // to unchecked for the moment before the config lands.
      render({ showDemo: null })
      expect((q('demo-show-toggle') as HTMLInputElement).checked).toBe(true)
    })

    it('is unchecked once the workspace turned demos off', () => {
      render({ showDemo: false })
      expect((q('demo-show-toggle') as HTMLInputElement).checked).toBe(false)
    })

    it('reports the change so it reaches canary-lab.config.json', () => {
      const onShowDemoChange = vi.fn()
      render({ showDemo: true, onShowDemoChange })
      // A click, not a dispatched `change`: React's synthetic onChange for a
      // checkbox rides the click, so a bare change event never reaches it.
      click(q('demo-show-toggle'))
      expect(onShowDemoChange).toHaveBeenCalledWith(false)
    })
  })
})
