// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvalidationProvider, useInvalidation } from './invalidation'
import { useLiveResource, type LiveResource } from './use-live-resource'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

/** Renders the hook and exposes the bus so a test can bump a topic the way the
 *  workspace-event handler does. */
function Probe({ id, fetcher, cache }: { id: string | null; fetcher: (key: string) => Promise<string | null>; cache?: string }) {
  const { value, loading } = useLiveResource('coverage', id, fetcher, cache !== undefined ? { cache } : {})
  const { invalidate } = useInvalidation()
  return (
    <div>
      <span data-testid="value">{value ?? '—'}</span>
      <span data-testid="loading">{loading ? 'loading' : 'idle'}</span>
      <button data-testid="bump" onClick={() => invalidate('coverage')}>bump</button>
    </div>
  )
}

async function render(props: { id: string | null; fetcher: (key: string) => Promise<string | null>; cache?: string }) {
  await act(async () => {
    root.render(<InvalidationProvider><Probe {...props} /></InvalidationProvider>)
  })
}

const read = (testId: string): string | undefined =>
  container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? undefined

describe('useLiveResource', () => {
  it('withdraws trust offline, reconciles on visibility/focus, and exposes explicit retry', async () => {
    vi.useFakeTimers()
    let live!: LiveResource<string>
    const fetcher = vi.fn(async () => 'current')
    function Task() {
      live = useLiveResource('coverage', 'events', fetcher, { reconcileMs: 5000, leaseMs: 15000, cache: 'live-events' })
      return null
    }
    await act(async () => root.render(<Task />))
    expect(live.confirmed).toBe(true)
    await act(async () => window.dispatchEvent(new Event('offline')))
    expect(live.confirmed).toBe(false)
    expect(live.error).toContain('Connection lost')
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(live.confirmed).toBe(true)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const count = fetcher.mock.calls.length
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(fetcher).toHaveBeenCalledTimes(count)
    visibility.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(fetcher).toHaveBeenCalledTimes(count + 1)
    fetcher.mockRejectedValueOnce('unavailable')
    await act(async () => live.refresh())
    expect(live.error).toBe('unavailable')
    expect(live.value).toBe('current')
    await act(async () => window.dispatchEvent(new Event('online')))
    expect(live.confirmed).toBe(true)
    visibility.mockRestore()
  })

  it('reconciles a missed completion event, retains state through failures, and stops terminal polling', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce('running')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('done')
    function Task() {
      const { value } = useLiveResource('coverage', 'poll-recovery', fetcher, { pollWhile: (v) => v !== 'done' })
      return <span data-testid="value">{value}</span>
    }
    await act(async () => root.render(<Task />))
    expect(read('value')).toBe('running')
    await act(async () => vi.advanceTimersByTimeAsync(2500))
    expect(read('value')).toBe('running')
    await act(async () => vi.advanceTimersByTimeAsync(2500))
    expect(read('value')).toBe('done')
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('recovers a hung request and ignores its stale response after completion', async () => {
    vi.useFakeTimers()
    let resolveOld!: (value: string) => void
    const fetcher = vi.fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValue('done')
    function Task() {
      const { value } = useLiveResource('coverage', 'poll-hung', fetcher, { pollWhile: (v) => v !== 'done' })
      return <span data-testid="value">{value}</span>
    }
    await act(async () => root.render(<Task />))
    await act(async () => vi.advanceTimersByTimeAsync(2500))
    expect(read('value')).toBe('done')
    await act(async () => resolveOld('running'))
    expect(read('value')).toBe('done')
  })

  it('resolves the value for its key', async () => {
    await render({ id: 'checkout', fetcher: async (key) => `value:${key}` })
    expect(read('value')).toBe('value:checkout')
    expect(read('loading')).toBe('idle')
  })

  it('refetches when its topic is invalidated — the whole point', async () => {
    let n = 0
    const fetcher = vi.fn(async () => `pass ${++n}`)
    await render({ id: 'checkout', fetcher })
    expect(read('value')).toBe('pass 1')

    // What a `coverage-changed` workspace event does.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="bump"]')?.click() })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(read('value')).toBe('pass 2')
  })

  it('does not refetch when an unrelated topic is invalidated', async () => {
    const fetcher = vi.fn(async () => 'once')
    function Other() {
      useLiveResource('coverage', 'checkout', fetcher)
      const { invalidate } = useInvalidation()
      return <button data-testid="other" onClick={() => invalidate('journal', 'run-1')}>other</button>
    }
    await act(async () => { root.render(<InvalidationProvider><Other /></InvalidationProvider>) })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="other"]')?.click() })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('stays idle with no key, then fetches when one arrives', async () => {
    const fetcher = vi.fn(async (key: string) => `value:${key}`)
    await render({ id: null, fetcher })
    expect(fetcher).not.toHaveBeenCalled()
    expect(read('value')).toBe('—')

    await render({ id: 'checkout', fetcher })
    expect(read('value')).toBe('value:checkout')
  })

  it('clears the value when the key goes away — a stale value under a new subject is a lie', async () => {
    await render({ id: 'checkout', fetcher: async (key) => `value:${key}` })
    expect(read('value')).toBe('value:checkout')
    await render({ id: null, fetcher: async (key) => `value:${key}` })
    expect(read('value')).toBe('—')
    expect(read('loading')).toBe('idle')
  })

  it('reads a failure as absent, the way every caller renders it', async () => {
    await render({ id: 'checkout', fetcher: async () => { throw new Error('404') } })
    expect(read('value')).toBe('—')
    expect(read('loading')).toBe('idle')
  })

  it('treats a resolved undefined as absent', async () => {
    await render({ id: 'checkout', fetcher: async () => undefined as unknown as string })
    expect(read('value')).toBe('—')
    await render({ id: 'cached-absent', cache: 'absent', fetcher: async () => undefined as unknown as string })
    expect(read('value')).toBe('—')
  })

  it('ignores an already queued freshness-expiry callback after unmount', async () => {
    const original = globalThis.setTimeout
    let expiry: (() => void) | undefined
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
      if (ms === 15000) expiry = handler
      return original(handler, ms)
    }) as typeof setTimeout)
    function Task() {
      useLiveResource('coverage', 'late-lease', async () => 'current', { reconcileMs: 5000, leaseMs: 15000 })
      return null
    }
    await act(async () => root.render(<Task />))
    expect(expiry).toBeDefined()
    await act(async () => root.render(null))
    await act(async () => expiry!())
    timer.mockRestore()
  })

  it('ignores a fetch that resolves after its key changed', async () => {
    const resolvers: Array<(v: string) => void> = []
    const fetcher = (key: string) => new Promise<string>((resolve) => {
      resolvers.push((v) => resolve(`${key}:${v}`))
    })
    await render({ id: 'first', fetcher })
    await render({ id: 'second', fetcher })
    // The first request lands LAST. Without the alive guard it would overwrite
    // the second key's value — the classic out-of-order-response bug.
    await act(async () => { resolvers[1]!('b'); resolvers[0]!('a') })
    expect(read('value')).toBe('second:b')
  })

  it('ignores a fetch that FAILS after its key changed', async () => {
    const rejecters: Array<(e: Error) => void> = []
    const fetcher = (key: string) => key === 'first'
      ? new Promise<string>((_resolve, reject) => { rejecters.push(reject) })
      : Promise.resolve(`${key}:ok`)
    await render({ id: 'first', fetcher })
    await render({ id: 'second', fetcher })

    // The abandoned key's rejection lands last. Without the alive guard on the
    // catch it would blank the value the new key had already resolved.
    await act(async () => { rejecters[0]!(new Error('offline')) })

    expect(read('value')).toBe('second:ok')
  })

  it('does not re-fetch just because the caller passed a new closure', async () => {
    let calls = 0
    // An inline arrow is a NEW function every render; keying the effect on it
    // would loop forever.
    await render({ id: 'checkout', fetcher: async () => { calls += 1; return 'x' } })
    await render({ id: 'checkout', fetcher: async () => { calls += 1; return 'x' } })
    expect(calls).toBe(1)
  })

  it('a tagged remount paints the last resolved value immediately, then the fresh fetch replaces it', async () => {
    // The flight rail remounts its stage pane on every row click — a revisit
    // must read stale-then-fresh, not skeleton-then-fresh. Cache is OPT-IN
    // via a resource tag (two resources can share topic + key).
    await render({ id: 'revisit-key', fetcher: async () => 'first read', cache: 'probe' })
    expect(read('value')).toBe('first read')

    let release: ((v: string) => void) | null = null
    const slow = () => new Promise<string>((resolve) => { release = resolve })
    // A new element `key` forces a REAL remount (a plain re-render would keep
    // the state and prove nothing about the seed).
    await act(async () => {
      root.render(<InvalidationProvider><Probe key="remounted" id="revisit-key" fetcher={slow} cache="probe" /></InvalidationProvider>)
    })
    expect(read('value')).toBe('first read')
    expect(read('loading')).toBe('loading')
    await act(async () => { release?.('second read') })
    expect(read('value')).toBe('second read')
  })

  it('a key CHANGE paints that key’s cached value (or nothing) at once — never the old key’s figures', async () => {
    const fetcher = async (key: string) => `value:${key}`
    await render({ id: 'key-a', fetcher, cache: 'probe' })
    expect(read('value')).toBe('value:key-a')

    // Uncached key: the old value clears immediately while the fetch runs.
    let release: ((v: string) => void) | null = null
    const slow = () => new Promise<string>((resolve) => { release = resolve })
    await act(async () => {
      root.render(<InvalidationProvider><Probe id="key-b-uncached" fetcher={slow} cache="probe" /></InvalidationProvider>)
    })
    expect(read('value')).toBe('—')
    await act(async () => { release?.('value:key-b-uncached') })

    // Back to the cached key: its figures return without waiting for the fetch.
    await act(async () => {
      root.render(<InvalidationProvider><Probe id="key-a" fetcher={slow} cache="probe" /></InvalidationProvider>)
    })
    expect(read('value')).toBe('value:key-a')

    // An UNTAGGED call site never caches and never seeds — a fresh mount of the
    // same key starts empty.
    await act(async () => {
      root.render(<InvalidationProvider><Probe key="untagged" id="key-a" fetcher={slow} /></InvalidationProvider>)
    })
    expect(read('value')).toBe('—')
  })

  it('reports loading across a refetch so a caller can hold its skeleton', async () => {
    const seen: LiveResource<string>['loading'][] = []
    let release: ((v: string) => void) | null = null
    function Watcher() {
      const { loading } = useLiveResource('coverage', 'checkout', () =>
        new Promise<string>((resolve) => { release = resolve }))
      seen.push(loading)
      return null
    }
    await act(async () => { root.render(<InvalidationProvider><Watcher /></InvalidationProvider>) })
    expect(seen).toContain(true)
    await act(async () => { release?.('done') })
    expect(seen.at(-1)).toBe(false)
  })
})
