// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getVerificationTargets,
  listVerificationConfigs,
  createVerificationConfig,
  updateVerificationConfig,
} from '@/shared/api/client'
import { VerificationDialog, reseedTargetUrls } from './VerificationDialog'

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    getVerificationTargets: vi.fn(),
    listVerificationConfigs: vi.fn(),
    createVerificationConfig: vi.fn(),
    updateVerificationConfig: vi.fn(),
  }
})

let container: HTMLDivElement
let root: Root

const TARGETS = {
  targets: [
    { id: 'api', name: 'acme-merchant-pass' },
    { id: 'oms', name: 'acmefnb' },
  ],
  targetUrls: { api: 'http://localhost:3000' },
}

function savedConfig(over: Partial<Parameters<typeof createVerificationConfig>[1]> = {}) {
  return {
    id: 'cfg_1',
    featureId: 'merchant-pass-fnb',
    name: 'Staging',
    targetUrls: { api: 'https://staging.example.com/health' },
    playwrightEnvsetId: 'local',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    ...over,
  }
}

function render(props: Partial<Parameters<typeof VerificationDialog>[0]> = {}) {
  return act(async () => {
    root.render(
      <VerificationDialog
        feature="merchant-pass-fnb"
        envs={['local', 'staging']}
        onClose={props.onClose ?? (() => {})}
        onStart={props.onStart ?? (async () => {})}
        {...props}
      />,
    )
  })
}

/** The dialog surface as the shared Modal renders it (portal-free, but the
 *  backdrop is a sibling of the content — query from the container root). */
function dialog(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="verification-dialog"]')
  if (!el) throw new Error('verification dialog not rendered')
  return el
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(getVerificationTargets).mockReset().mockResolvedValue(TARGETS)
  vi.mocked(listVerificationConfigs).mockReset().mockResolvedValue([])
  vi.mocked(createVerificationConfig).mockReset().mockResolvedValue(savedConfig())
  vi.mocked(updateVerificationConfig).mockReset().mockResolvedValue(savedConfig())
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('VerificationDialog', () => {
  it('renders on the shared dialog chrome — no bespoke verify skin', async () => {
    await render()

    // Shared Modal surface, not a hand-rolled shell.
    expect(dialog().classList.contains('cl-modal')).toBe(true)
    // Every `cl-verify-*` class is retired; nothing may reintroduce one.
    expect(container.querySelector('[class*="cl-verify"]')).toBeNull()
    // Sections are the shared bordered blocks, in the same order as before.
    const titles = [...dialog().querySelectorAll('section > div > span:first-child')].map((s) => s.textContent)
    expect(titles).toEqual(['Start from', 'Services', 'Envset', 'Save this setup'])
  })

  it('switching envset swaps its URLs in and refreshes the service list', async () => {
    // Both services start with a URL the envset seeded — the untouched one is
    // what proves the swap actually happens.
    vi.mocked(getVerificationTargets).mockResolvedValue({
      targets: TARGETS.targets,
      targetUrls: { api: 'http://localhost:3000', oms: 'http://localhost:8080' },
    })
    await render()

    // Hand-edit one URL; the other keeps what `local` seeded.
    const edited = dialog().querySelector<HTMLInputElement>('input[aria-label="Health-check URL for acme-merchant-pass"]')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(edited, 'https://mine.example.com/health')
      edited.dispatchEvent(new Event('input', { bubbles: true }))
    })

    vi.mocked(getVerificationTargets).mockResolvedValue({
      targets: [
        { id: 'api', name: 'acme-merchant-pass' },
        { id: 'oms', name: 'acmefnb' },
        { id: 'gateway', name: 'gateway' },
      ],
      targetUrls: {
        api: 'https://staging.example.com',
        oms: 'https://oms.staging.example.com',
        gateway: 'https://gw.example.com',
      },
    })
    const envsetSelect = dialog().querySelector<HTMLSelectElement>('select[aria-label="Envset"]')!
    await act(async () => {
      const selectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      selectSetter.call(envsetSelect, 'staging')
      envsetSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // The hand-edited URL survives…
    expect(dialog().querySelector<HTMLInputElement>('input[aria-label="Health-check URL for acme-merchant-pass"]')?.value)
      .toBe('https://mine.example.com/health')
    // …the untouched one is actually SWAPPED for staging's (the whole point —
    // the old merge left it on localhost forever)…
    expect(dialog().querySelector<HTMLInputElement>('input[aria-label="Health-check URL for acmefnb"]')?.value)
      .toBe('https://oms.staging.example.com')
    // …and a service only staging knows about arrives seeded.
    expect(dialog().querySelector<HTMLInputElement>('input[aria-label="Health-check URL for gateway"]')?.value)
      .toBe('https://gw.example.com')
  })

  it('adopts the first envset once the async envs list arrives', async () => {
    // The parent's feature list loads async, so the dialog can mount with no
    // envsets at all: the select must not sit on an empty value while showing
    // the first option, and the targets must be fetched for a real envset.
    await render({ envs: [] })
    expect(getVerificationTargets).toHaveBeenCalledWith('merchant-pass-fnb', undefined)

    await render({ envs: ['local', 'staging'] })
    expect(dialog().querySelector<HTMLSelectElement>('select[aria-label="Envset"]')?.value).toBe('local')
    expect(getVerificationTargets).toHaveBeenCalledWith('merchant-pass-fnb', 'local')
  })

  it('states the mode facts as prose instead of green success chips', async () => {
    await render()
    const text = dialog().textContent ?? ''
    expect(text).toContain('merchant-pass-fnb')
    expect(text).toContain('No local boot, no healing.')
  })

  it('lists each service with its health-check URL and counts the configured ones', async () => {
    await render()

    const urlInput = dialog().querySelector<HTMLInputElement>('input[aria-label="Health-check URL for acme-merchant-pass"]')
    expect(urlInput?.value).toBe('http://localhost:3000')
    const empty = dialog().querySelector<HTMLInputElement>('input[aria-label="Health-check URL for acmefnb"]')
    expect(empty?.value).toBe('')
    expect(dialog().textContent).toContain('1 of 2 with a URL')
  })

  it('starts a verification with the current targets and envset', async () => {
    const onStart = vi.fn(async () => {})
    const onClose = vi.fn()
    await render({ onStart, onClose })

    const start = dialog().querySelector<HTMLButtonElement>('[data-testid="verification-start"]')!
    await act(async () => {
      start.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onStart).toHaveBeenCalledWith({
      playwrightEnvsetId: 'local',
      targetUrls: { api: 'http://localhost:3000' },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces a start failure in the dialog and keeps it open', async () => {
    const onClose = vi.fn()
    await render({ onStart: async () => { throw new Error('deployment unreachable') }, onClose })

    const start = dialog().querySelector<HTMLButtonElement>('[data-testid="verification-start"]')!
    await act(async () => {
      start.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(dialog().querySelector('[data-testid="verification-error"]')?.textContent).toContain('deployment unreachable')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('saves a named setup and shows it as the selected config in the footer', async () => {
    await render()

    const nameInput = dialog().querySelector<HTMLInputElement>('input[aria-label="Configuration name"]')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(nameInput, 'Staging')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')!
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(createVerificationConfig).toHaveBeenCalledWith('merchant-pass-fnb', {
      name: 'Staging',
      targetUrls: { api: 'http://localhost:3000' },
      playwrightEnvsetId: 'local',
    })
    expect(dialog().textContent).toContain('Using')
    expect(dialog().textContent).toContain('Staging')
  })
})

describe('reseedTargetUrls', () => {
  const LOCAL = { api: 'http://localhost:3000', oms: 'http://localhost:4000' }
  const STAGING = { api: 'https://api.staging', oms: 'https://oms.staging' }

  it('replaces every URL still holding what the previous envset seeded', () => {
    expect(reseedTargetUrls(LOCAL, LOCAL, STAGING)).toEqual(STAGING)
  })

  it('keeps a hand-edited URL and re-seeds the untouched one', () => {
    const current = { ...LOCAL, api: 'https://mine.example.com' }
    expect(reseedTargetUrls(current, LOCAL, STAGING)).toEqual({
      api: 'https://mine.example.com',
      oms: 'https://oms.staging',
    })
  })

  it('keeps every URL of a loaded saved config (nothing was envset-seeded)', () => {
    const saved = { api: 'https://prod.example.com' }
    expect(reseedTargetUrls(saved, {}, STAGING)).toEqual({
      api: 'https://prod.example.com',
      oms: 'https://oms.staging',
    })
  })

  it('fills a target the previous envset had no URL for', () => {
    expect(reseedTargetUrls({ api: 'http://localhost:3000' }, { api: 'http://localhost:3000' }, STAGING))
      .toEqual(STAGING)
  })

  it('drops a stale seeded URL for a target the new envset does not have', () => {
    expect(reseedTargetUrls(LOCAL, LOCAL, { api: 'https://api.staging' }))
      .toEqual({ api: 'https://api.staging' })
  })

  it('keeps a hand-edited URL even when the new envset drops that target', () => {
    const current = { ...LOCAL, oms: 'https://mine.example.com' }
    expect(reseedTargetUrls(current, LOCAL, { api: 'https://api.staging' }))
      .toEqual({ api: 'https://api.staging', oms: 'https://mine.example.com' })
  })

  it('treats a cleared field as untouched and re-seeds it', () => {
    expect(reseedTargetUrls({ api: '', oms: 'http://localhost:4000' }, LOCAL, STAGING)).toEqual(STAGING)
  })
})
