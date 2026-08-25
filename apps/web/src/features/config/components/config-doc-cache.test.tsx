// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigDocCacheProvider, useCachedDoc } from './config-doc-cache'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

/** Records the `loading` flag of EVERY render, not just the settled one — the
 *  whole point of the cache is that a second mount never renders a loading
 *  frame at all, and a "did it end up loaded" assertion cannot see that. */
function Probe({ cacheKey, load, seen, onRead }: {
  cacheKey: string
  load: () => Promise<{ value: string }>
  seen: boolean[]
  onRead?: (read: ReturnType<typeof useCachedDoc<{ value: string }>>) => void
}) {
  const cached = useCachedDoc(cacheKey, load)
  seen.push(cached.loading)
  onRead?.(cached)
  return <div data-testid="value">{cached.doc?.value ?? '—'}</div>
}

function shown(): string {
  return document.querySelector('[data-testid="value"]')?.textContent ?? ''
}

describe('useCachedDoc', () => {
  it('serves a remounted key from memory — no second fetch, no loading frame', async () => {
    const load = vi.fn().mockResolvedValue({ value: 'from-disk' })
    const first: boolean[] = []
    const second: boolean[] = []

    await act(async () => {
      root.render(
        <ConfigDocCacheProvider>
          <Probe cacheKey="doc:a" load={load} seen={first} />
        </ConfigDocCacheProvider>,
      )
    })
    expect(shown()).toBe('from-disk')
    expect(load).toHaveBeenCalledTimes(1)
    expect(first[0]).toBe(true)

    // Unmounting the reader is exactly what a tab switch does — the provider
    // (the dialog) stays up, so the document must survive.
    await act(async () => {
      root.render(<ConfigDocCacheProvider><div /></ConfigDocCacheProvider>)
    })
    await act(async () => {
      root.render(
        <ConfigDocCacheProvider>
          <Probe cacheKey="doc:a" load={load} seen={second} />
        </ConfigDocCacheProvider>,
      )
    })

    expect(load).toHaveBeenCalledTimes(1)
    expect(shown()).toBe('from-disk')
    // Not one render of the remount reported loading — that is the flash.
    expect(second).not.toContain(true)
  })

  it('two readers of the same key share one fetch', async () => {
    const load = vi.fn().mockResolvedValue({ value: 'shared' })
    await act(async () => {
      root.render(
        <ConfigDocCacheProvider>
          <Probe cacheKey="doc:a" load={load} seen={[]} />
          <Probe cacheKey="doc:a" load={load} seen={[]} />
        </ConfigDocCacheProvider>,
      )
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('refresh() drops the entry so the next read re-reads the file', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ value: 'before' })
      .mockResolvedValueOnce({ value: 'after' })
    let api: ReturnType<typeof useCachedDoc<{ value: string }>> | null = null

    await act(async () => {
      root.render(
        <ConfigDocCacheProvider>
          <Probe cacheKey="doc:a" load={load} seen={[]} onRead={(r) => { api = r }} />
        </ConfigDocCacheProvider>,
      )
    })
    expect(shown()).toBe('before')

    await act(async () => { api?.refresh() })
    expect(load).toHaveBeenCalledTimes(2)
    expect(shown()).toBe('after')
  })

  it('setDoc publishes a saved document to the other readers of that key', async () => {
    const load = vi.fn().mockResolvedValue({ value: 'on-disk' })
    let api: ReturnType<typeof useCachedDoc<{ value: string }>> | null = null
    const second: boolean[] = []

    await act(async () => {
      root.render(
        <ConfigDocCacheProvider>
          <Probe cacheKey="doc:a" load={load} seen={[]} onRead={(r) => { api = r }} />
        </ConfigDocCacheProvider>,
      )
    })
    await act(async () => { api?.setDoc({ value: 'just-saved' }) })

    await act(async () => {
      root.render(
        <ConfigDocCacheProvider>
          <Probe cacheKey="doc:a" load={load} seen={second} />
        </ConfigDocCacheProvider>,
      )
    })
    // The remounted reader shows the SAVED value without going back to the API.
    expect(shown()).toBe('just-saved')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a changed key reads its own document rather than the previous one', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ value: 'alpha' })
      .mockResolvedValueOnce({ value: 'beta' })

    await act(async () => {
      root.render(
        <ConfigDocCacheProvider>
          <Probe cacheKey="doc:alpha" load={load} seen={[]} />
        </ConfigDocCacheProvider>,
      )
    })
    expect(shown()).toBe('alpha')

    await act(async () => {
      root.render(
        <ConfigDocCacheProvider>
          <Probe cacheKey="doc:beta" load={load} seen={[]} />
        </ConfigDocCacheProvider>,
      )
    })
    expect(shown()).toBe('beta')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('surfaces a load failure instead of sitting on the loading state', async () => {
    const load = vi.fn().mockRejectedValue(new Error('config.cjs is unreadable'))
    // A holder rather than a bare `let … = null`, because this is the one case
    // that reads the captured value in the OUTER flow. TypeScript cannot see the
    // assignment inside `onRead`, so it narrows the variable to `null` and the
    // reads below become `never`. The sibling cases dodge it only by reading
    // inside another callback.
    const captured: { api: ReturnType<typeof useCachedDoc<{ value: string }>> | null } = { api: null }

    await act(async () => {
      root.render(
        <ConfigDocCacheProvider>
          <Probe cacheKey="doc:a" load={load} seen={[]} onRead={(r) => { captured.api = r }} />
        </ConfigDocCacheProvider>,
      )
    })
    expect(captured.api?.error).toBe('config.cjs is unreadable')
    expect(captured.api?.loading).toBe(false)
  })

  // A tab rendered outside the dialog (its own unit test) must behave exactly as
  // it did before the cache existed, or those suites would be testing a fiction.
  it('with no provider, every mount loads', async () => {
    const load = vi.fn().mockResolvedValue({ value: 'uncached' })
    const second: boolean[] = []

    await act(async () => { root.render(<Probe cacheKey="doc:a" load={load} seen={[]} />) })
    await act(async () => { root.render(<div />) })
    await act(async () => { root.render(<Probe cacheKey="doc:a" load={load} seen={second} />) })

    expect(load).toHaveBeenCalledTimes(2)
    expect(second[0]).toBe(true)
    expect(shown()).toBe('uncached')
  })
})
