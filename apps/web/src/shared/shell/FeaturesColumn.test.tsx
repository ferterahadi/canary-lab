// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeaturesColumn } from './FeaturesColumn'
import type { FeatureFlightAction } from '@/features/flights'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const gatePromo = vi.fn((_action: string, continueAction: () => void) => continueAction())

// Hoisted so the factory below can close over it without re-importing the mocked
// module (that shape deadlocks vitest collection).
const { listCoverageStates } = vi.hoisted(() => ({ listCoverageStates: vi.fn() }))

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  listCoverageStates,
}))

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
  listCoverageStates.mockReset()
  listCoverageStates.mockResolvedValue([])
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

// R40 removed the per-row flight LAUNCHER; the hover shortcut below is the
// opposite direction (open the flight this suite already has), so both hold:
// nothing on a row starts a flight, and a row can still jump to one.
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
    expect(row?.textContent).toContain('Queued')
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

  it('floats a group with a real question above one whose step runs in the user\'s agent', () => {
    // Both flights wear `waiting-for-approval`. Only the second asks anything of
    // this reader, so only it should pull its group to the top — otherwise the
    // column nags about work that is already under way somewhere else.
    const parked = (name: string, group: string, checkpointKind: 'external-work' | 'missing-env') => ({
      ...pendingFeature(name, group),
      pending: { flightId: `fl_${name}`, status: 'waiting-for-approval' as const, currentStage: null, checkpointKind },
    })
    act(() => {
      root.render(
        <FeaturesColumn
          features={[parked('scan', 'Alpha', 'external-work'), parked('keys', 'Beta', 'missing-env')]}
          selectedFeature={null}
          onSelectFeature={() => {}}
        />,
      )
    })
    const sections = [...container.querySelectorAll('[data-testid^="feature-group-toggle-"]')]
      .map((el) => el.getAttribute('data-testid'))
    expect(sections).toEqual(['feature-group-toggle-Beta', 'feature-group-toggle-Alpha'])
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

describe('FeaturesColumn flight shortcut (open the suite\'s existing flight)', () => {
  const feature = (name: string) => ({ name, repos: [], envs: [] })
  // A settled flight: shortcut present, but nothing live — so no row cue.
  const action = { flightId: 'fl_7', tone: 'var(--success)', label: 'done', title: 'flight done', live: false, attention: false }

  it('opens the resolved flight and aligns the workspace selection with it', () => {
    const onOpenFlight = vi.fn()
    const onSelectFeature = vi.fn()
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('alpha')]}
          selectedFeature={null}
          onSelectFeature={onSelectFeature}
          onOpenFlight={onOpenFlight}
          flightAction={() => action}
        />,
      )
    })
    const button = container.querySelector<HTMLButtonElement>('[data-testid="flight-shortcut-alpha"]')
    expect(button?.getAttribute('data-flight-id')).toBe('fl_7')
    // The status hue rides on the icon — the state is the point of the jump.
    expect(button?.style.color).toBe('var(--success)')
    act(() => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onSelectFeature).toHaveBeenCalledWith('alpha')
    expect(onOpenFlight).toHaveBeenCalledWith('fl_7')
  })

  it('omits the shortcut when the suite has no flight to open', () => {
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('alpha')]}
          selectedFeature={null}
          onSelectFeature={() => {}}
          onOpenFlight={() => {}}
          flightAction={() => null}
        />,
      )
    })
    expect(container.querySelector('[data-testid="flight-shortcut-alpha"]')).toBeNull()
  })

  it('omits the shortcut when no resolver or no destination handler is wired', () => {
    act(() => {
      root.render(
        <FeaturesColumn features={[feature('alpha')]} selectedFeature={null} onSelectFeature={() => {}} />,
      )
    })
    expect(container.querySelector('[data-testid="flight-shortcut-alpha"]')).toBeNull()
    // Resolver present, nowhere to send the click → still nothing to click.
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('alpha')]}
          selectedFeature={null}
          onSelectFeature={() => {}}
          flightAction={() => action}
        />,
      )
    })
    expect(container.querySelector('[data-testid="flight-shortcut-alpha"]')).toBeNull()
  })

  it('reserves only the visible actions\' width, so the suite name yields no more than it must', () => {
    // The floating cluster is off-flow; the name makes room on hover via this
    // per-row width. One action (config) → 40px; all three → 100px.
    const render = (props: Record<string, unknown>) => {
      act(() => {
        root.render(
          <FeaturesColumn features={[feature('alpha')]} selectedFeature={null} onSelectFeature={() => {}} {...props} />,
        )
      })
      return container.querySelector<HTMLElement>('li.feature-row')?.style.getPropertyValue('--feature-row-actions')
    }
    expect(render({})).toBe('40px')
    expect(render({ onOpenFlight: () => {}, flightAction: () => action, onOpenCoverage: () => {} })).toBe('100px')
  })

  it('keeps the shortcut on grouped rows too', () => {
    localStorage.clear()
    act(() => {
      root.render(
        <FeaturesColumn
          features={[{ name: 'beta', repos: [], envs: [], group: 'CNS' }]}
          selectedFeature={null}
          onSelectFeature={() => {}}
          onOpenFlight={() => {}}
          flightAction={() => action}
        />,
      )
    })
    expect(container.querySelector('[data-testid="flight-shortcut-beta"]')).toBeTruthy()
  })
})

describe('FeaturesColumn in-flight row cue', () => {
  const feature = (name: string) => ({ name, repos: [], envs: [] })
  const renderRow = (action: FeatureFlightAction | null) => {
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('alpha')]}
          selectedFeature={null}
          onSelectFeature={() => {}}
          onOpenFlight={() => {}}
          flightAction={() => action}
        />,
      )
    })
    return container.querySelector<HTMLElement>('li.feature-row')
  }
  const flight = (over: Partial<FeatureFlightAction>): FeatureFlightAction => ({
    flightId: 'fl_1', tone: 'var(--running)', label: 'authoring', title: 'Specs + coverage', live: false, attention: false, ...over,
  })

  it('washes the row and brightens the name while a flight is live', () => {
    const row = renderRow(flight({ live: true }))
    expect(row?.className).toContain('cl-list-row-inflight')
    expect(row?.className).not.toContain('cl-list-row-inflight-attention')
    expect(row?.style.color).toBe('var(--text-primary)')
    // The chip is the load-bearing half of the cue — the wash alone is faint.
    expect(container.querySelector('[data-testid="flight-chip-alpha"]')).toBeTruthy()
  })

  it('takes the heavier attention wash when the flight is parked on a checkpoint', () => {
    const row = renderRow(flight({ attention: true, tone: 'var(--warning)', label: 'to approve' }))
    expect(row?.className).toContain('cl-list-row-inflight-attention')
  })

  it('leaves a settled flight uncued, so a column of flown suites stays calm', () => {
    const row = renderRow(flight({ label: 'done', tone: 'var(--success)' }))
    expect(row?.className).not.toContain('cl-list-row-inflight')
    expect(row?.style.color).toBe('var(--text-secondary)')
    expect(container.querySelector('[data-testid="flight-chip-alpha"]')).toBeNull()
  })

  it('does not reserve the action width twice when the chip already holds that space', () => {
    // Regression: the chip sits in flow at the same right edge the cluster floats
    // over. Reserving the full 100px on top of the 72px chip left a 204px row with
    // ~18px of readable suite name on hover.
    const width = (action: FeatureFlightAction) => {
      act(() => {
        root.render(
          <FeaturesColumn
            features={[feature('alpha')]}
            selectedFeature={null}
            onSelectFeature={() => {}}
            onOpenFlight={() => {}}
            onOpenCoverage={() => {}}
            flightAction={() => action}
          />,
        )
      })
      return container.querySelector<HTMLElement>('li.feature-row')?.style.getPropertyValue('--feature-row-actions')
    }
    expect(width(flight({ live: false }))).toBe('100px')
    expect(width(flight({ live: true }))).toBe('22px')
  })

  it('lets a live test run outrank the in-flight wash on the same row', () => {
    // Both classes land; styles.css declares inflight FIRST so the running fill
    // wins at equal specificity. Asserting order here keeps that contract honest.
    act(() => {
      root.render(
        <FeaturesColumn
          features={[feature('alpha')]}
          selectedFeature={null}
          activeRunFeature="alpha"
          activeRunStatus="running"
          onSelectFeature={() => {}}
          onOpenFlight={() => {}}
          flightAction={() => flight({ live: true })}
        />,
      )
    })
    const row = container.querySelector<HTMLElement>('li.feature-row')
    expect(row?.className).toContain('cl-list-row-inflight')
    expect(row?.className).toContain('cl-list-row-running')
  })
})

describe('FeaturesColumn coverage-headline fetching', () => {
  const feature = (name: string) => ({ name, repos: [], envs: [] })

  // `/api/coverage/states` recomputes every feature's ledger server-side, so the
  // column must ask once per feature set — not once per render. App passes
  // `onOpenCoverage` as a fresh arrow every render; depending on it turned each
  // re-render into a full workspace-wide recompute (38 requests on one page load).
  const renderWith = async (features: ReturnType<typeof feature>[]) => {
    await act(async () => {
      root.render(
        <FeaturesColumn
          features={features}
          selectedFeature={null}
          onSelectFeature={() => {}}
          onOpenCoverage={(f) => void f}
        />,
      )
    })
  }

  it('does not refetch when only the onOpenCoverage identity changes', async () => {
    await renderWith([feature('alpha')])
    expect(listCoverageStates).toHaveBeenCalledTimes(1)

    // Same feature set, brand-new callback instance — what every App render does.
    await renderWith([feature('alpha')])
    await renderWith([feature('alpha')])
    expect(listCoverageStates).toHaveBeenCalledTimes(1)
  })

  it('still refetches when the feature set changes', async () => {
    await renderWith([feature('alpha')])
    expect(listCoverageStates).toHaveBeenCalledTimes(1)

    await renderWith([feature('alpha'), feature('beta')])
    expect(listCoverageStates).toHaveBeenCalledTimes(2)
  })

  it('does not fetch at all when coverage is not reachable', async () => {
    await act(async () => {
      root.render(
        <FeaturesColumn features={[feature('alpha')]} selectedFeature={null} onSelectFeature={() => {}} />,
      )
    })
    expect(listCoverageStates).not.toHaveBeenCalled()
  })
})
