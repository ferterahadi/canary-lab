// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeaturesColumn } from './FeaturesColumn'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const gatePromo = vi.fn((_action: string, continueAction: () => void) => continueAction())

vi.mock('./McpPromoContext', () => ({
  useMcpPromo: () => ({ gatePromo }),
}))

vi.mock('@/features/config/components/FeatureConfigEditor', () => ({
  FeatureConfigEditor: () => <div>feature config</div>,
}))

vi.mock('@/features/config/components/SettingsModal', () => ({
  SettingsModal: () => <div>settings</div>,
}))

vi.mock('../ui/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">theme</button>,
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  gatePromo.mockReset()
  gatePromo.mockImplementation((_action: string, continueAction: () => void) => continueAction())
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('FeaturesColumn MCP promo gate', () => {
  it('gates the "+ New" flight launcher behind the promo (R40: New starts a flight)', () => {
    const onStartNewFlight = vi.fn()
    gatePromo.mockImplementationOnce(() => {})

    act(() => {
      root.render(
        <FeaturesColumn
          features={[]}
          selectedFeature={null}
          onSelectFeature={() => {}}
          onStartNewFlight={onStartNewFlight}
        />,
      )
    })

    act(() => {
      clickButton('+ New')
    })

    expect(gatePromo).toHaveBeenCalledWith('create-feature', expect.any(Function))
    expect(onStartNewFlight).not.toHaveBeenCalled()

    act(() => {
      const continueAction = gatePromo.mock.calls[0][1] as () => void
      continueAction()
    })

    expect(onStartNewFlight).toHaveBeenCalledTimes(1)
  })
})

describe('FeaturesColumn active-run highlight', () => {
  const feature = (name: string) => ({ name, repos: [], envs: [] })

  it('highlights the active row when healing and drops the visible chip', () => {
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('alpha'), feature('beta')]}
          selectedFeature="alpha"
          activeRunFeature="beta"
          activeRunStatus="healing"
          onSelectFeature={() => {}}
        />,
      )
    })

    const beta = featureRow('beta')
    expect(beta.classList.contains('cl-list-row-healing')).toBe(true)
    expect(beta.classList.contains('cl-list-row-running')).toBe(false)
    // The selected-but-idle row carries no run-state class.
    expect(featureRow('alpha').classList.contains('cl-list-row-healing')).toBe(false)
    // The chip is gone, but the status stays available to screen readers.
    expect(container.querySelector('.cl-run-chip')).toBeNull()
    expect(beta.querySelector('.sr-only')?.textContent).toBe('Healing')
  })

  it('uses the running class for a non-healing active run', () => {
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('alpha')]}
          selectedFeature="alpha"
          activeRunFeature="alpha"
          activeRunStatus="running"
          onSelectFeature={() => {}}
        />,
      )
    })

    const row = featureRow('alpha')
    expect(row.classList.contains('cl-list-row-running')).toBe(true)
    expect(row.querySelector('.sr-only')?.textContent).toBe('Running')
  })
})

describe('FeaturesColumn coverage action (R8)', () => {
  const feature = (name: string) => ({ name, repos: [], envs: [] })

  it('opens coverage for the row and selects the feature', () => {
    const onOpenCoverage = vi.fn()
    const onSelectFeature = vi.fn()
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('alpha')]}
          selectedFeature={null}
          onSelectFeature={onSelectFeature}
          onOpenCoverage={onOpenCoverage}
        />,
      )
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="coverage-action-alpha"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelectFeature).toHaveBeenCalledWith('alpha')
    expect(onOpenCoverage).toHaveBeenCalledWith('alpha')
  })

  it('omits the coverage action when no handler is provided', () => {
    act(() => {
      root.render(
        <FeaturesColumn features={[feature('alpha')]} selectedFeature={null} onSelectFeature={() => {}} />,
      )
    })
    expect(container.querySelector('[data-testid="coverage-action-alpha"]')).toBeNull()
  })
})

describe('FeaturesColumn flight action (R40: per-row action removed)', () => {
  const feature = (name: string) => ({ name, repos: [], envs: [] })

  it('renders no per-row flight action — the pill picker and "+ New" own flight entry', () => {
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('alpha')]}
          selectedFeature={null}
          onSelectFeature={() => {}}
          onStartNewFlight={() => {}}
        />,
      )
    })
    expect(container.querySelector('[data-testid="flight-action-alpha"]')).toBeNull()
  })

  it('omits the flight action when no handler is provided', () => {
    act(() => {
      root.render(
        <FeaturesColumn features={[feature('alpha')]} selectedFeature={null} onSelectFeature={() => {}} />,
      )
    })
    expect(container.querySelector('[data-testid="flight-action-alpha"]')).toBeNull()
  })
})

describe('FeaturesColumn grouping (R55)', () => {
  const feature = (name: string, group?: string) => ({ name, repos: [], envs: [], group })

  beforeEach(() => localStorage.clear())

  it('renders grouped features under a collapsible accordion and leaves ungrouped rows flat', () => {
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('checkout', 'shop'), feature('cart', 'shop'), feature('admin')]}
          selectedFeature={null}
          onSelectFeature={() => {}}
        />,
      )
    })
    const section = container.querySelector('[data-testid="feature-group-shop"]')
    expect(section).toBeTruthy()
    // Both grouped rows live under the shop accordion; the ungrouped one does not.
    expect(section!.querySelector('li.feature-row')?.textContent).toContain('checkout')
    expect([...section!.querySelectorAll('li.feature-row')]).toHaveLength(2)
    const admin = featureRow('admin')
    expect(section!.contains(admin)).toBe(false)
    // The count chip reflects the group size.
    expect(container.querySelector('[data-testid="feature-group-toggle-shop"]')?.textContent).toContain('2')
  })

  it('collapses and re-expands a group, persisting the closed state to localStorage', () => {
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('checkout', 'shop'), feature('cart', 'shop')]}
          selectedFeature={null}
          onSelectFeature={() => {}}
        />,
      )
    })
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="feature-group-toggle-shop"]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(featureRow('checkout')).toBeTruthy()
    act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[data-testid="feature-group-toggle-shop"]')?.getAttribute('aria-expanded')).toBe('false')
    // Rows are gone while collapsed.
    expect([...container.querySelectorAll('li.feature-row')]).toHaveLength(0)
    // Closed state persisted so a remount stays collapsed.
    expect(JSON.parse(localStorage.getItem('cl-feature-groups-open')!)).toEqual({ shop: false })
    act(() => { root.unmount() })
    root = createRoot(container)
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('checkout', 'shop'), feature('cart', 'shop')]}
          selectedFeature={null}
          onSelectFeature={() => {}}
        />,
      )
    })
    expect(container.querySelector('[data-testid="feature-group-toggle-shop"]')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('orders groups worst-first — a group with an active run sorts above a calm one', () => {
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('calm', 'zzz-calm'), feature('busy', 'aaa-active')]}
          selectedFeature={null}
          activeRunFeature="busy"
          activeRunStatus="running"
          onSelectFeature={() => {}}
        />,
      )
    })
    const groups = [...container.querySelectorAll('[data-testid^="feature-group-toggle-"]')]
    // The active group floats above the calm one despite the reverse alphabetical names.
    expect(groups[0]?.getAttribute('data-testid')).toBe('feature-group-toggle-aaa-active')
    expect(groups[1]?.getAttribute('data-testid')).toBe('feature-group-toggle-zzz-calm')
  })
})

describe('FeaturesColumn pending placeholders (R69)', () => {
  const pendingFeature = (name: string, group?: string) => ({
    name,
    repos: [],
    envs: [],
    ...(group ? { group } : {}),
    pending: { flightId: `fl_${name}`, status: 'paused' as const, currentStage: null, pauseReason: 'queued' as const },
  })

  it('renders a cog-less placeholder row that opens the flight on click', () => {
    const onOpenFlight = vi.fn()
    const onSelectFeature = vi.fn()
    act(() => {
      root.render(
        <FeaturesColumn
          features={[pendingFeature('login')]}
          selectedFeature={null}
          onSelectFeature={onSelectFeature}
          onOpenFlight={onOpenFlight}
        />,
      )
    })
    const row = container.querySelector<HTMLLIElement>('[data-testid="pending-feature-login"]')
    expect(row).toBeTruthy()
    // Placeholder rows have no config/coverage cogs — there's nothing on disk yet.
    expect(row?.querySelector('[aria-label^="Configure"]')).toBeNull()
    // The queued flight's status chip rides along.
    expect(row?.textContent).toContain('queued')
    act(() => {
      row?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpenFlight).toHaveBeenCalledWith('fl_login')
    // Clicking a placeholder never selects a (non-existent) feature.
    expect(onSelectFeature).not.toHaveBeenCalled()
  })

  it('places placeholders inside their group section alongside real features', () => {
    act(() => {
      root.render(
        <FeaturesColumn
          features={[pendingFeature('signup', 'Auth'), pendingFeature('login', 'Auth')]}
          selectedFeature={null}
          onSelectFeature={() => {}}
        />,
      )
    })
    const section = container.querySelector('[data-testid="feature-group-Auth"]')
    expect(section).toBeTruthy()
    expect(section?.querySelector('[data-testid="pending-feature-login"]')).toBeTruthy()
    expect(section?.querySelector('[data-testid="pending-feature-signup"]')).toBeTruthy()
    // Count chip reflects the whole batch.
    expect(container.querySelector('[data-testid="feature-group-toggle-Auth"]')?.textContent).toContain('2')
  })
})

function featureRow(name: string): HTMLLIElement {
  const row = [...container.querySelectorAll('li.feature-row')]
    .find((li) => li.textContent?.includes(name))
  expect(row).toBeTruthy()
  return row as HTMLLIElement
}

function clickButton(label: string): void {
  const button = [...container.querySelectorAll('button')]
    .find((item) => item.textContent?.trim() === label)
  expect(button).toBeTruthy()
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
