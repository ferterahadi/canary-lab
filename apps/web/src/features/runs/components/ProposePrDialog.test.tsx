// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrPreflight } from '../../../shared/api/client'
import { ProposePrDialog } from './ProposePrDialog'

const mocks = vi.hoisted(() => ({ getRunPrPreflight: vi.fn(), proposeRunPr: vi.fn() }))
vi.mock('../../../shared/api/client', () => mocks)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pushable: PrPreflight = {
  gh: { installed: true, authenticated: true, account: 'me', host: 'github.com' },
  anyPushable: true,
  repos: [{ repoName: 'fnb', repoRoot: '/r', origin: { owner: 'org', name: 'fnb', host: 'github.com' }, base: 'development', pushable: true }],
}
const blocked: PrPreflight = {
  gh: { installed: true, authenticated: false },
  anyPushable: false,
  repos: [{ repoName: 'fnb', repoRoot: '/r', origin: { owner: 'org', name: 'fnb', host: 'github.com' }, base: 'development', pushable: false, blocked: { reason: 'not-authed' } }],
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.getRunPrPreflight.mockReset()
  mocks.proposeRunPr.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function open(preflight: PrPreflight): Promise<void> {
  mocks.getRunPrPreflight.mockResolvedValue(preflight)
  await act(async () => { root.render(<ProposePrDialog open onClose={() => {}} runId="r1" />) })
  // let the preflight promise resolve
  await act(async () => { await Promise.resolve() })
}

describe('ProposePrDialog', () => {
  it('preflights on open and enables confirm for a pushable repo', async () => {
    await open(pushable)
    expect(mocks.getRunPrPreflight).toHaveBeenCalledWith('r1')
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="propose-pr-confirm"]')
    expect(confirm?.disabled).toBe(false)
    expect(confirm?.textContent).toMatch(/Open PR/)
  })

  it('disables confirm and shows remediation when blocked', async () => {
    await open(blocked)
    expect(container.querySelector<HTMLButtonElement>('[data-testid="propose-pr-confirm"]')?.disabled).toBe(true)
    expect(container.textContent).toContain('gh auth login')
  })

  it('opens the PR and shows the resulting link', async () => {
    mocks.proposeRunPr.mockResolvedValue({ results: [{ repoName: 'fnb', ok: true, pr: { repoName: 'fnb', url: 'https://github.com/org/fnb/pull/7', branch: 'b', base: 'development', createdAt: 'T' } }] })
    const onProposed = vi.fn()
    mocks.getRunPrPreflight.mockResolvedValue(pushable)
    await act(async () => { root.render(<ProposePrDialog open onClose={() => {}} runId="r1" onProposed={onProposed} />) })
    await act(async () => { await Promise.resolve() })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="propose-pr-confirm"]')?.click() })
    expect(mocks.proposeRunPr).toHaveBeenCalledWith('r1')
    expect(onProposed).toHaveBeenCalled()
    const results = container.querySelector('[data-testid="propose-pr-results"]')
    expect(results?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/org/fnb/pull/7')
  })
})
