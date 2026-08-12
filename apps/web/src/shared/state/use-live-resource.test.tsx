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
})

/** Renders the hook and exposes the bus so a test can bump a topic the way the
 *  workspace-event handler does. */
function Probe({ id, fetcher }: { id: string | null; fetcher: (key: string) => Promise<string | null> }) {
  const { value, loading } = useLiveResource('coverage', id, fetcher)
  const { invalidate } = useInvalidation()
  return (
    <div>
      <span data-testid="value">{value ?? '—'}</span>
      <span data-testid="loading">{loading ? 'loading' : 'idle'}</span>
      <button data-testid="bump" onClick={() => invalidate('coverage')}>bump</button>
    </div>
  )
}

async function render(props: { id: string | null; fetcher: (key: string) => Promise<string | null> }) {
  await act(async () => {
    root.render(<InvalidationProvider><Probe {...props} /></InvalidationProvider>)
  })
}

const read = (testId: string): string | undefined =>
  container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? undefined

describe('useLiveResource', () => {
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

  it('does not re-fetch just because the caller passed a new closure', async () => {
    let calls = 0
    // An inline arrow is a NEW function every render; keying the effect on it
    // would loop forever.
    await render({ id: 'checkout', fetcher: async () => { calls += 1; return 'x' } })
    await render({ id: 'checkout', fetcher: async () => { calls += 1; return 'x' } })
    expect(calls).toBe(1)
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
