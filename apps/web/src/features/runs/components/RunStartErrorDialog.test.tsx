// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/api/client'
import { RunStartErrorDialog, describeRunStartError } from './RunStartErrorDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

async function render(props: Partial<Parameters<typeof RunStartErrorDialog>[0]> = {}) {
  const onClose = vi.fn()
  const onRetry = vi.fn()
  await act(async () => {
    root.render(
      <RunStartErrorDialog error={new ApiError(500, {})} feature="checkout" onClose={onClose} onRetry={onRetry} {...props} />,
    )
  })
  return { onClose, onRetry }
}

const button = (text: string): HTMLButtonElement | null =>
  ([...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === text) ?? null)
const click = (el: Element | null): void => { act(() => { (el as HTMLElement).click() }) }

describe('describeRunStartError', () => {
  it('maps a 404 to a "feature no longer exists" hint, keeping the server reason', () => {
    const { detail, hint } = describeRunStartError(new ApiError(404, { error: 'feature not found' }), 'checkout')
    expect(detail).toBe('feature not found')
    expect(hint).toMatch(/no longer exists/i)
  })

  it('maps a 400 to a "valid environment" hint', () => {
    const { detail, hint } = describeRunStartError(new ApiError(400, { error: 'env must be one of: local, prod' }), 'checkout')
    expect(detail).toBe('env must be one of: local, prod')
    expect(hint).toMatch(/valid environment/i)
  })

  it('maps a 5xx to a server-logs hint', () => {
    const { hint } = describeRunStartError(new ApiError(500, { error: 'boot failed' }), 'checkout')
    expect(hint).toMatch(/server logs/i)
  })

  it('treats a non-ApiError (network) as unreachable-server', () => {
    const { title, detail, hint } = describeRunStartError(new TypeError('Failed to fetch'), 'checkout')
    expect(title).toMatch(/couldn.t reach the server/i)
    expect(detail).toBe('Failed to fetch')
    expect(hint).toMatch(/running/i)
  })
})

describe('RunStartErrorDialog', () => {
  it('renders headline + server reason and fires Retry / Close', async () => {
    const { onRetry, onClose } = await render({ error: new ApiError(404, { error: 'feature not found' }) })
    expect(container.textContent).toContain('Couldn’t start checkout')
    expect(container.textContent).toContain('feature not found')
    click(button('Retry'))
    expect(onRetry).toHaveBeenCalledOnce()
    click(button('Close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Escape', async () => {
    const { onClose } = await render()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('omits Retry when no handler is given', async () => {
    await render({ onRetry: undefined })
    expect(button('Retry')).toBeNull()
  })
})

// The real-world case: one repo (acme-merchant-pass) on `master`, feature
// configured for `development`.
function branchMismatchError(repos?: Array<Record<string, unknown>>) {
  return new ApiError(409, {
    type: 'repo_branch_mismatch',
    feature: 'checkout',
    error: 'Repo branch check failed:\n...',
    repos: repos ?? [
      { name: 'acme-merchant-pass', path: '/a', expected: 'development', current: 'master', detached: false, isGitRepo: true },
    ],
  })
}

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
const buttonContaining = (text: string): HTMLButtonElement | null =>
  ([...container.querySelectorAll('button')].find((el) => (el.textContent ?? '').includes(text)) ?? null)

describe('RunStartErrorDialog — branch mismatch', () => {
  it('frames the choice with both branch names and explains why, not a raw dump', async () => {
    await render({ error: branchMismatchError(), onSwitchBranches: vi.fn(), onPinCurrent: vi.fn() })
    expect(container.textContent).toContain('Which branch should this run test?')
    // Both branches named, the why explained, the repo identified.
    expect(container.textContent).toContain('development')
    expect(container.textContent).toContain('master')
    expect(container.textContent).toContain('acme-merchant-pass')
    expect(container.textContent).toContain('Recommended')
    // Not the raw exception string.
    expect(container.textContent).not.toContain('Repo branch check failed')
  })

  it('the Switch option checks out the feature’s branch', async () => {
    const onSwitchBranches = vi.fn().mockResolvedValue(undefined)
    await render({ error: branchMismatchError(), onSwitchBranches })
    click(buttonContaining('Switch acme-merchant-pass'))
    await flush()
    expect(onSwitchBranches).toHaveBeenCalledOnce()
  })

  it('the Pin option adopts the current branch', async () => {
    const onPinCurrent = vi.fn().mockResolvedValue(undefined)
    await render({ error: branchMismatchError(), onPinCurrent })
    click(buttonContaining('Pin the feature'))
    await flush()
    expect(onPinCurrent).toHaveBeenCalledOnce()
  })

  it('expands to a per-repo list when repos diverge, without a from→to diff', async () => {
    await render({
      error: branchMismatchError([
        { name: 'acme-merchant-pass', path: '/a', expected: 'development', current: 'master', detached: false, isGitRepo: true },
        { name: 'unified-dashboard', path: '/b', expected: 'development', current: 'hotfix/x', detached: false, isGitRepo: true },
      ]),
      onSwitchBranches: vi.fn(),
      onPinCurrent: vi.fn(),
    })
    // Shared target collapses to one name; the Switch action names the count.
    expect(container.textContent).toContain('development')
    expect(container.textContent).toContain('Switch 2 repos')
    // Divergent current branches expand into a per-repo list on the Pin card.
    expect(container.textContent).toContain('acme-merchant-pass')
    expect(container.textContent).toContain('unified-dashboard')
    expect(container.textContent).toContain('master')
    expect(container.textContent).toContain('hotfix/x')
    // Still no from→to diff arrow anywhere.
    expect(container.textContent).not.toContain('→')
  })

  it('surfaces an action failure inline and keeps the dialog open', async () => {
    const onSwitchBranches = vi.fn().mockRejectedValue(new Error('git checkout failed'))
    const { onClose } = await render({ error: branchMismatchError(), onSwitchBranches })
    click(buttonContaining('Switch acme-merchant-pass'))
    await flush()
    expect(container.textContent).toContain('git checkout failed')
    expect(onClose).not.toHaveBeenCalled()
  })
})
