// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getFeatureConfigDoc, getPlaywrightConfig, putFeatureConfigDoc, type ParsedConfigDoc } from '@/shared/api/client'
import { FeatureSetupPanel } from './FeatureSetupPanel'

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    getFeatureConfigDoc: vi.fn(),
    getPlaywrightConfig: vi.fn(),
    putFeatureConfigDoc: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(getFeatureConfigDoc).mockReset()
  vi.mocked(getPlaywrightConfig).mockReset()
  vi.mocked(putFeatureConfigDoc).mockReset()
  vi.mocked(putFeatureConfigDoc).mockResolvedValue(configDoc())
  vi.mocked(getPlaywrightConfig).mockRejectedValue(new Error('no playwright config'))
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('FeatureSetupPanel — heal behavior card', () => {
  it('reads an absent threshold as on at the default, and says what that costs', async () => {
    await mount()

    const card = container.querySelector('[data-testid="setup-heal-card"]')
    expect(card).toBeTruthy()
    expect(card?.textContent).toContain('Heal behavior')
    expect(card?.querySelector('[data-testid="setup-heal-toggle"]')?.getAttribute('aria-checked')).toBe('true')
    expect(threshold()?.value).toBe('2')
    expect(threshold()?.disabled).toBe(false)
    // The consequence line, not a restatement of the number above it.
    expect(card?.textContent).toContain('the rest of the suite doesn’t have to finish')
  })

  it('reads an explicit 0 as off — stepper parked at the default so the toggle can come back on', async () => {
    await mount({ healOnFailureThreshold: 0 })

    const card = container.querySelector('[data-testid="setup-heal-card"]')
    expect(card?.querySelector('[data-testid="setup-heal-toggle"]')?.getAttribute('aria-checked')).toBe('false')
    expect(threshold()?.disabled).toBe(true)
    expect(threshold()?.value).toBe('2')
    expect(card?.textContent).toContain('Playwright runs every test before the repair agent starts.')
  })

  it('shows an explicit threshold and writes an edit to the same config doc', async () => {
    await mount({ healOnFailureThreshold: 4 })
    expect(threshold()?.value).toBe('4')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Increment"]')?.click()
    })
    expect(putFeatureConfigDoc).toHaveBeenCalledTimes(1)
    const [feature, value] = vi.mocked(putFeatureConfigDoc).mock.calls[0] as [string, Record<string, unknown>]
    expect(feature).toBe('checkout')
    expect(value.healOnFailureThreshold).toBe(5)
    // The write carries the rest of the document, never just the edited key.
    expect(value.name).toBe('checkout')
  })

  it('turning the toggle off persists an explicit 0 rather than dropping the key', async () => {
    await mount({ healOnFailureThreshold: 3 })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="setup-heal-toggle"]')?.click()
    })
    const off = vi.mocked(putFeatureConfigDoc).mock.calls[0][1] as Record<string, unknown>
    expect(off.healOnFailureThreshold).toBe(0)
  })

  it('turning it back on restores the default count', async () => {
    await mount({ healOnFailureThreshold: 0 })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="setup-heal-toggle"]')?.click()
    })
    const on = vi.mocked(putFeatureConfigDoc).mock.calls[0][1] as Record<string, unknown>
    expect(on.healOnFailureThreshold).toBe(2)
  })

  it('mid-run (not editable) reads as text — no toggle to race the conductor with', async () => {
    await mount({ healOnFailureThreshold: 3 }, { editable: false })

    const card = container.querySelector('[data-testid="setup-heal-card"]')
    expect(card?.textContent).toContain('after 3 failure(s)')
    expect(card?.querySelector('[data-testid="setup-heal-toggle"]')).toBeNull()
    expect(threshold()).toBeNull()
  })

  it('mid-run with healing off reads "off"', async () => {
    await mount({ healOnFailureThreshold: 0 }, { editable: false })
    expect(container.querySelector('[data-testid="setup-heal-card"]')?.textContent).toContain('off')
  })

  it('is absent when the feature config could not be read (a playwright-only digest)', async () => {
    vi.mocked(getFeatureConfigDoc).mockRejectedValue(new Error('no feature config'))
    vi.mocked(getPlaywrightConfig).mockResolvedValue({
      path: '/ws/features/checkout/playwright.config.ts',
      format: 'ts',
      content: '',
      parsed: { value: { workers: 2 }, complexFields: [], source: '' },
    })

    await act(async () => {
      root.render(<FeatureSetupPanel feature="checkout" editable />)
    })

    expect(container.querySelector('[data-testid="setup-playwright"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="setup-heal-card"]')).toBeNull()
  })
})

function threshold(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('[data-testid="setup-heal-threshold"]')
}

async function mount(
  extra: Record<string, unknown> = {},
  { editable = true }: { editable?: boolean } = {},
): Promise<void> {
  vi.mocked(getFeatureConfigDoc).mockResolvedValue(configDoc(extra))
  await act(async () => {
    root.render(<FeatureSetupPanel feature="checkout" editable={editable} />)
  })
}

function configDoc(extra: Record<string, unknown> = {}): ParsedConfigDoc {
  return {
    path: '/ws/features/checkout/feature.config.cjs',
    format: 'cjs',
    content: '',
    parsed: {
      // No repos: the service blocks are covered by the flight-page suite, and
      // omitting them keeps this file off the git-status fetch they trigger.
      value: { name: 'checkout', envs: ['local'], repos: [], ...extra },
      complexFields: [],
      source: '',
    },
  }
}
