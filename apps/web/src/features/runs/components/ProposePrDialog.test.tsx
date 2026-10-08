// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrPreflight } from '@/shared/api/runs'
import { ProposePrDialog } from './ProposePrDialog'
import { deferred } from '../../../../../../tools/test-helpers/deferred'

const mocks = vi.hoisted(() => ({ getRunPrPreflight: vi.fn(), proposeRunPr: vi.fn() }))
vi.mock('@/shared/api/runs', () => ({
  getRunPrPreflight: mocks.getRunPrPreflight,
  proposeRunPr: mocks.proposeRunPr,
}))

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

const confirm = () => container.querySelector<HTMLButtonElement>('[data-testid="propose-pr-confirm"]')!
const clickLabel = (label: string) => [...container.querySelectorAll('button')].find((button) => button.textContent === label)!.click()

it('rejects a delayed pushable preflight from a previous open session', async () => {
  const old = deferred<PrPreflight>()
  mocks.getRunPrPreflight.mockReturnValueOnce(old.promise).mockResolvedValue(blocked)
  const render = (open: boolean) => act(async () => root.render(<ProposePrDialog open={open} runId="r1" onClose={() => {}} />))
  await render(true)
  await render(false)
  await render(true)
  await act(async () => old.resolve(pushable))
  expect(confirm().disabled).toBe(true)
  expect(container.textContent).not.toContain('Signed in as me')
})

it('starts every open session unconfirmed and supersedes earlier refreshes and runs', async () => {
  await open(pushable)
  const old = deferred<PrPreflight>()
  mocks.getRunPrPreflight.mockReturnValueOnce(old.promise).mockResolvedValue(blocked)
  await act(async () => clickLabel('Refresh'))
  expect(confirm().disabled).toBe(true)
  await act(async () => root.render(<ProposePrDialog open runId="r2" onClose={() => {}} />))
  await act(async () => old.resolve(pushable))
  expect(confirm().disabled).toBe(true)
  await act(async () => root.render(<ProposePrDialog open={false} runId="r2" onClose={() => {}} />))
  mocks.getRunPrPreflight.mockReturnValue(new Promise(() => {}))
  await act(async () => root.render(<ProposePrDialog open runId="r2" onClose={() => {}} />))
  expect(confirm().disabled).toBe(true)
})

it('requires a successful Retry after a failed probe and never polls', async () => {
  vi.useFakeTimers()
  try {
    await open(pushable)
    mocks.getRunPrPreflight.mockRejectedValueOnce(new Error('probe unavailable')).mockResolvedValue(blocked)
    await act(async () => clickLabel('Refresh'))
    expect(confirm().disabled).toBe(true)
    expect(container.textContent).toContain('probe unavailable')
    await act(async () => clickLabel('Retry'))
    expect(container.textContent).toContain('gh auth login')
    await act(async () => vi.advanceTimersByTimeAsync(60000))
    expect(mocks.getRunPrPreflight).toHaveBeenCalledTimes(3)
  } finally { vi.useRealTimers() }
})

it('keeps the outstanding submission lock across reopen but discards late results and callbacks', async () => {
  const request = deferred<{ results: [] }>()
  const onProposed = vi.fn()
  mocks.proposeRunPr.mockReturnValue(request.promise)
  mocks.getRunPrPreflight.mockResolvedValue(pushable)
  const render = (open: boolean) => act(async () => root.render(<ProposePrDialog open={open} runId="r1" onClose={() => {}} onProposed={onProposed} />))
  await render(true)
  await act(async () => { confirm().click(); confirm().click() })
  await render(false)
  await render(true)
  expect(confirm().disabled).toBe(true)
  expect(mocks.proposeRunPr).toHaveBeenCalledTimes(1)
  await act(async () => request.resolve({ results: [] }))
  expect(onProposed).not.toHaveBeenCalled()
  expect(container.querySelector('[data-testid="propose-pr-results"]')).toBeNull()
  expect(confirm().disabled).toBe(false)
})

it('discards mutation failures after run replacement and callbacks after teardown', async () => {
  const first = deferred<{ results: [] }>()
  const second = deferred<{ results: [] }>()
  const onProposed = vi.fn()
  mocks.getRunPrPreflight.mockResolvedValue(pushable)
  mocks.proposeRunPr.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const render = (runId: string) => act(async () => root.render(<ProposePrDialog open runId={runId} onClose={() => {}} onProposed={onProposed} />))
  await render('r1')
  await act(async () => confirm().click())
  await render('r2')
  await act(async () => first.reject(new Error('old failure')))
  expect(container.textContent).not.toContain('old failure')
  await act(async () => confirm().click())
  await act(async () => root.render(null))
  await act(async () => second.resolve({ results: [] }))
  expect(onProposed).not.toHaveBeenCalled()
})
