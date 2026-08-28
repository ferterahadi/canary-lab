// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeatureConfigEditor } from './FeatureConfigEditor'

// The tabs each fetch their own document; this suite is about which tab is
// SHOWN, so every body is stubbed down to a marker.
vi.mock('./GeneralTab', () => ({ GeneralTab: () => <div data-testid="body-general" /> }))
vi.mock('./ReposTab', () => ({ ReposTab: () => <div data-testid="body-repos" /> }))
vi.mock('./PortsTab', () => ({ PortsTab: () => <div data-testid="body-ports" /> }))
vi.mock('./EnvsetsTab', () => ({ EnvsetsTab: () => <div data-testid="body-envsets" /> }))
vi.mock('./PlaywrightTab', () => ({ PlaywrightTab: () => <div data-testid="body-playwright" /> }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

/** Which body marker is mounted — the tab the dialog is actually showing. */
function shownTab(): string | null {
  const el = document.querySelector('[data-testid^="body-"]')
  return el?.getAttribute('data-testid')?.replace('body-', '') ?? null
}

function clickTab(label: string): void {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  act(() => { btn?.click() })
}

describe('FeatureConfigEditor tab ownership', () => {
  it('uses the suite vocabulary in the visible dialog heading', () => {
    act(() => { root.render(<FeatureConfigEditor feature="checkout" onClose={vi.fn()} />) })

    expect(container.textContent).toContain('Suite configuration')
    expect(container.textContent).not.toContain('Feature configuration')
  })

  // The unrouted mount (the features-list gear) owns its own tab state.
  it('uncontrolled: opens on initialTab and switches tabs by itself', () => {
    act(() => { root.render(<FeatureConfigEditor feature="checkout" onClose={vi.fn()} />) })
    expect(shownTab()).toBe('general')

    clickTab('Ports')
    expect(shownTab()).toBe('ports')
  })

  it('uncontrolled: initialTab picks the opening tab', () => {
    act(() => { root.render(<FeatureConfigEditor feature="checkout" initialTab="playwright" onClose={vi.fn()} />) })
    expect(shownTab()).toBe('playwright')
  })

  // The routed mount (App) owns the tab so it can live in the URL — the flight's
  // Parallel-readiness drill-through opens straight onto Ports this way.
  it('controlled: renders the tab prop and reports switches instead of self-navigating', () => {
    const onTabChange = vi.fn()
    act(() => {
      root.render(<FeatureConfigEditor feature="checkout" tab="ports" onTabChange={onTabChange} onClose={vi.fn()} />)
    })
    expect(shownTab()).toBe('ports')

    clickTab('Envsets')
    expect(onTabChange).toHaveBeenCalledWith('envsets')
    // The owner hasn't pushed a new tab yet, so the shown tab must not move on
    // its own — otherwise the URL and the dialog could disagree.
    expect(shownTab()).toBe('ports')

    act(() => {
      root.render(<FeatureConfigEditor feature="checkout" tab="envsets" onTabChange={onTabChange} onClose={vi.fn()} />)
    })
    expect(shownTab()).toBe('envsets')
  })

  it('controlled: the tab prop wins over initialTab', () => {
    act(() => {
      root.render(<FeatureConfigEditor feature="checkout" initialTab="general" tab="ports" onClose={vi.fn()} />)
    })
    expect(shownTab()).toBe('ports')
  })
})
