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
  it('reads an absent threshold as on at the default, with both run shapes named', async () => {
    await mount()

    const card = container.querySelector('[data-testid="setup-heal-card"]')
    expect(card).toBeTruthy()
    expect(card?.textContent).toContain('Auto-repair')
    expect(mode('stop')?.getAttribute('aria-checked')).toBe('true')
    expect(mode('full')?.getAttribute('aria-checked')).toBe('false')
    expect(threshold()?.value).toBe('2')
    expect(threshold()?.disabled).toBe(false)
  })

  it('reads an explicit 0 as the run-everything mode — stepper parked at the default so switching back lands on a usable count', async () => {
    await mount({ healOnFailureThreshold: 0 })

    expect(mode('full')?.getAttribute('aria-checked')).toBe('true')
    expect(mode('stop')?.getAttribute('aria-checked')).toBe('false')
    expect(threshold()?.disabled).toBe(true)
    expect(threshold()?.value).toBe('2')
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

  it('picking the run-everything mode persists an explicit 0 rather than dropping the key', async () => {
    await mount({ healOnFailureThreshold: 3 })

    await act(async () => { mode('full')?.click() })
    const off = vi.mocked(putFeatureConfigDoc).mock.calls[0][1] as Record<string, unknown>
    expect(off.healOnFailureThreshold).toBe(0)
  })

  it('picking stop & heal back restores the default count', async () => {
    await mount({ healOnFailureThreshold: 0 })

    await act(async () => { mode('stop')?.click() })
    const on = vi.mocked(putFeatureConfigDoc).mock.calls[0][1] as Record<string, unknown>
    expect(on.healOnFailureThreshold).toBe(2)
  })

  it('is keyboard-pickable — Space on a mode selects it, same as a click', async () => {
    await mount({ healOnFailureThreshold: 3 })

    await act(async () => {
      mode('full')?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })
    const off = vi.mocked(putFeatureConfigDoc).mock.calls[0][1] as Record<string, unknown>
    expect(off.healOnFailureThreshold).toBe(0)
  })

  it('clicking the already-picked mode writes nothing — no PUT for a no-op', async () => {
    await mount({ healOnFailureThreshold: 3 })

    await act(async () => { mode('stop')?.click() })
    expect(putFeatureConfigDoc).not.toHaveBeenCalled()
  })

  it('the unpicked row’s stepper is out of hit-testing, so a click there selects the row', async () => {
    await mount({ healOnFailureThreshold: 0 })

    // A disabled control swallows the click rather than bubbling it — the
    // wrapper drops out of hit-testing so the row still gets it.
    const stepper = threshold()?.closest('div')?.parentElement
    expect(stepper?.style.pointerEvents).toBe('none')

    // …and once the row IS picked the stepper takes clicks again.
    await act(async () => { mode('stop')?.click() })
    await mount({ healOnFailureThreshold: 3 })
    expect(threshold()?.closest('div')?.parentElement?.style.pointerEvents).toBe('')
  })

  it('mid-run (not editable) reads as text — no radio to race the conductor with', async () => {
    await mount({ healOnFailureThreshold: 3 }, { editable: false })

    const card = container.querySelector('[data-testid="setup-heal-card"]')
    expect(card?.textContent).toContain('Stop & repair after 3 failures')
    expect(card?.querySelector('[role="radio"]')).toBeNull()
    expect(threshold()).toBeNull()
  })

  it('mid-run with healing off still names the mode that IS in force', async () => {
    await mount({ healOnFailureThreshold: 0 }, { editable: false })
    const card = container.querySelector('[data-testid="setup-heal-card"]')
    expect(card?.textContent).toContain('Run the whole suite, then repair')
    expect(card?.querySelector('[role="radio"]')).toBeNull()
  })

  it('external ownership preserves the normal edit controls but disables every mutation with the hand-off tooltip', async () => {
    vi.mocked(getPlaywrightConfig).mockResolvedValue({
      path: '/ws/features/checkout/playwright.config.ts',
      format: 'ts',
      content: '',
      parsed: { value: { workers: 2, retries: 1, use: { video: 'off', trace: 'retain-on-failure' } }, complexFields: [], source: '' },
    })
    const lockedTitle = 'Change suite setup from the Claude/Codex session doing the work.'
    await mount({
      repos: [{
        name: 'shop',
        localPath: '/repo/shop',
        branch: 'main',
        startCommands: [{ name: 'web', command: 'npm start' }],
      }],
      healOnFailureThreshold: 2,
    }, { editable: false, lockedTitle })

    const edit = container.querySelector<HTMLButtonElement>('[data-testid="setup-edit-shop"]')
    const workers = container.querySelector<HTMLInputElement>('[data-testid="setup-pw-workers"]')
    const video = container.querySelector<HTMLSelectElement>('[data-testid="setup-pw-video"]')
    expect(edit?.disabled).toBe(true)
    expect(edit?.title).toBe(lockedTitle)
    expect(workers?.disabled).toBe(true)
    expect(workers?.title).toBe(lockedTitle)
    expect(video?.disabled).toBe(true)
    expect(threshold()?.disabled).toBe(true)
    expect(mode('stop')?.getAttribute('role')).toBe('radio')
    expect(mode('stop')?.getAttribute('aria-disabled')).toBe('true')
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

function mode(which: 'stop' | 'full'): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="setup-heal-mode-${which}"]`)
}

async function mount(
  extra: Record<string, unknown> = {},
  { editable = true, lockedTitle }: { editable?: boolean; lockedTitle?: string } = {},
): Promise<void> {
  vi.mocked(getFeatureConfigDoc).mockResolvedValue(configDoc(extra))
  await act(async () => {
    root.render(<FeatureSetupPanel feature="checkout" editable={editable} lockedTitle={lockedTitle} />)
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
