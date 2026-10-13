import { expect, it, vi } from 'vitest'
import { gettingStartedClaim, withGettingStartedClaim } from './getting-started-claim'

function owner() {
  return { attach: vi.fn<(sessionId: string, target: string) => void>(), abandon: vi.fn<(sessionId: string) => void>() }
}

it('does not own absent or previously acquired claims', async () => {
  const store = owner()
  expect(gettingStartedClaim(undefined, 'session')).toBeNull()
  expect(gettingStartedClaim(store, null)).toBeNull()
  await expect(withGettingStartedClaim(null, () => 'early')).resolves.toBe('early')
  await expect(withGettingStartedClaim(null, (attach) => { attach('existing'); return 'done' })).resolves.toBe('done')
  expect(store.abandon).not.toHaveBeenCalled()
})

it('waits for asynchronous launch and retains the attached target', async () => {
  const store = owner()
  let resolve!: (value: string) => void
  const pending = new Promise<string>((done) => { resolve = done })
  const result = withGettingStartedClaim(gettingStartedClaim(store, 'session'), async (attach) => {
    const target = await pending
    attach(target)
    return target
  })
  expect(store.abandon).not.toHaveBeenCalled()
  expect(store.attach).not.toHaveBeenCalled()
  resolve('queued-run')
  await expect(result).resolves.toBe('queued-run')
  expect(store.attach).toHaveBeenCalledWith('session', 'queued-run')
  expect(store.abandon).not.toHaveBeenCalled()
})

it('releases early returns and synchronous or asynchronous launch failures exactly once', async () => {
  for (const run of [() => 'needs-input', () => { throw new Error('launch') }, async () => { throw new Error('launch') }]) {
    const store = owner()
    await withGettingStartedClaim(gettingStartedClaim(store, 'session'), run).catch(() => undefined)
    expect(store.abandon).toHaveBeenCalledExactlyOnceWith('session')
    expect(store.attach).not.toHaveBeenCalled()
  }
})

it('retains attachment when response construction fails, but releases a failed attachment', async () => {
  const store = owner()
  const failure = new Error('response')
  await expect(withGettingStartedClaim(gettingStartedClaim(store, 'session'), (attach) => {
    attach('durable-task')
    throw failure
  })).rejects.toBe(failure)
  expect(store.abandon).not.toHaveBeenCalled()
  store.attach.mockImplementation(() => { throw failure })
  await expect(withGettingStartedClaim(gettingStartedClaim(store, 'new-session'), (attach) => attach('task'))).rejects.toBe(failure)
  expect(store.abandon).toHaveBeenCalledExactlyOnceWith('new-session')
})

it('preserves the primary failure and surfaces cleanup failure when there is no primary failure', async () => {
  const store = owner()
  const cleanup = new Error('cleanup')
  store.abandon.mockImplementation(() => { throw cleanup })
  await expect(withGettingStartedClaim(gettingStartedClaim(store, 'session'), () => 'early')).rejects.toBe(cleanup)
  await expect(withGettingStartedClaim(gettingStartedClaim(store, 'session'), () => { throw null })).rejects.toBeNull()
})
