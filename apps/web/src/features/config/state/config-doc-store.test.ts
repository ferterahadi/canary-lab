import { expect, it, vi } from 'vitest'
import { createConfigDocStore } from './config-doc-store'

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('shares reads and retains identity for identical snapshots, then releases listeners', async () => {
  const cache = createConfigDocStore()
  const changed = vi.fn()
  const unsubscribe = cache.subscribe('config:a', changed)
  const pending = deferred()
  const load = vi.fn(() => pending.promise)
  const first = cache.load('config:a', 'one', load)
  expect(cache.load('config:a', 'one', load)).toBe(first)
  pending.resolve({ envs: ['local'] })
  await first
  const snapshot = cache.read('config:a')
  await cache.load('config:a', 'one', load)
  expect(load).toHaveBeenCalledTimes(1)
  await cache.load('config:a', 'two', async () => ({ envs: ['local'] }))
  expect(cache.read('config:a')).toBe(snapshot)
  expect(changed).toHaveBeenCalledTimes(1)
  unsubscribe()
  cache.write('config:a', { envs: ['staging'] })
  expect(changed).toHaveBeenCalledTimes(1)
})

it('ignores reads and failures superseded by a newer request, invalidation or local save', async () => {
  const cache = createConfigDocStore()
  const stale = deferred()
  const first = cache.load('a', 'one', () => stale.promise)
  await cache.load('a', 'two', async () => 'newest')
  stale.resolve('old')
  await first
  expect(cache.read('a').doc).toBe('newest')
  const failing = deferred()
  const failed = cache.load('a', 'three', () => failing.promise)
  cache.invalidate('a')
  failing.reject(new Error('stale failure'))
  await expect(failed).rejects.toThrow('stale failure')
  expect(cache.read('a').error).toBeNull()
  const saving = deferred()
  const savingRead = cache.load('a', 'four', () => saving.promise)
  cache.write('a', 'saved')
  saving.resolve('before save')
  await savingRead
  const fetch = vi.fn(async () => 'later')
  expect(await cache.load('a', 'five', fetch)).toBe('saved')
  expect(fetch).not.toHaveBeenCalled()
  expect(cache.read('a').doc).toBe('saved')
  expect(await cache.load('a', 'six', fetch)).toBe('later')
})

it('retains the last good snapshot on failed reads and retries without caching the failure', async () => {
  const cache = createConfigDocStore()
  await cache.load('a', 'one', async () => ({ value: 'valid' }))
  await expect(cache.load('a', 'two', async () => { throw new Error('offline') })).rejects.toThrow('offline')
  expect(cache.read('a')).toMatchObject({ doc: { value: 'valid' }, error: 'offline' })
  await expect(cache.load('a', 'two', async () => { throw 'unreadable' })).rejects.toBe('unreadable')
  expect(cache.read('a').error).toBe('Failed to load')
  await cache.load('a', 'two', async () => ({ value: 'valid' }))
  expect(cache.read('a').error).toBeNull()
})

it('explicit invalidation retains the painted value but requires another read', async () => {
  const cache = createConfigDocStore()
  cache.write('a', 'saved')
  cache.invalidate('a')
  expect(cache.read('a').doc).toBe('saved')
  expect(await cache.load('a', 'one', async () => 'external')).toBe('external')
  expect(cache.read('missing').doc).toBeNull()
})
