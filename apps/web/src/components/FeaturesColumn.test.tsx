// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeaturesColumn } from './FeaturesColumn'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const startNewWizard = vi.fn()
const gatePromo = vi.fn((_action: string, continueAction: () => void) => continueAction())

vi.mock('../features/wizard/state/WizardDraftContext', () => ({
  useWizardDrafts: () => ({ startNewWizard }),
}))

vi.mock('../state/McpPromoContext', () => ({
  useMcpPromo: () => ({ gatePromo }),
}))

vi.mock('../features/config/components/FeatureConfigEditor', () => ({
  FeatureConfigEditor: () => <div>feature config</div>,
}))

vi.mock('../features/config/components/SettingsModal', () => ({
  SettingsModal: () => <div>settings</div>,
}))

vi.mock('./ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">theme</button>,
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  startNewWizard.mockReset()
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
  it('gates creating a new feature before opening the wizard', () => {
    gatePromo.mockImplementationOnce(() => {})

    act(() => {
      root.render(
        <FeaturesColumn
          features={[]}
          selectedFeature={null}
          onSelectFeature={() => {}}
        />,
      )
    })

    act(() => {
      clickButton('+ New')
    })

    expect(gatePromo).toHaveBeenCalledWith('create-feature', expect.any(Function))
    expect(startNewWizard).not.toHaveBeenCalled()

    act(() => {
      const continueAction = gatePromo.mock.calls[0][1] as () => void
      continueAction()
    })

    expect(startNewWizard).toHaveBeenCalledTimes(1)
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
