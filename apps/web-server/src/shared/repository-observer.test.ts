import fs from 'fs'
import { EventEmitter } from 'events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRepositoryObserver } from './repository-observer'
import type { RepositoryWatchPath } from './repository-watch-paths'

const consumer = { flightId: 'flight' }
let observer: ReturnType<typeof createRepositoryObserver>
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)
function harness() {
  const handles: Array<{ file: string; emitChange: (event: string, filename: string | null) => void; handle: EventEmitter & { close: ReturnType<typeof vi.fn> } }> = []
  const watchPath = vi.fn((file: string, _options, listener) => {
    const handle = Object.assign(new EventEmitter(), { close: vi.fn() })
    handles.push({ file, emitChange: listener, handle })
    return handle
  })
  const spec: RepositoryWatchPath = { path: '/repo', recursive: true, accepts: (name) => name !== 'ignored' }
  const watchPaths = vi.fn(async () => [spec])
  const readTree = vi.fn(async () => ({ ok: true as const, lines: [] as string[] }))
  const readRepo = vi.fn(async () => ({ currentBranch: 'main' }))
  const publish = vi.fn()
  const log = vi.fn()
  const deps = { events: { publish }, log, watchPath: watchPath as unknown as typeof fs.watch, watchPaths, readTree,
    readRepo: readRepo as unknown as NonNullable<Parameters<typeof createRepositoryObserver>[0]['readRepo']> }
  observer = createRepositoryObserver(deps)
  return { handles, watchPath, watchPaths, readTree, readRepo, publish, log, deps }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { observer?.dispose(); vi.useRealTimers() })

it('shares simultaneous reads and native watches across consumers, but keeps scope and later reads independent', async () => {
  const h = harness()
  await Promise.all([observer.readWorkingTree('/repo', 'directory', consumer), observer.readWorkingTree('/repo', 'directory', { flightId: 'second' })])
  expect(h.readTree).toHaveBeenCalledTimes(1)
  expect(h.watchPaths).toHaveBeenCalledTimes(1)
  await observer.readWorkingTree('/repo', 'repository', consumer)
  expect(h.readTree).toHaveBeenCalledTimes(2)
  expect(h.watchPath).toHaveBeenCalledTimes(1)
  await observer.readWorkingTree('/repo', 'directory', consumer)
  expect(h.readTree).toHaveBeenCalledTimes(3) // completed snapshots are never cached
  h.handles[0].emitChange('change', 'tracked')
  await tick(250)
  expect(h.publish).toHaveBeenCalledWith({ type: 'repos-changed', consumers: [consumer, { flightId: 'second' }] })
  expect(h.readTree).toHaveBeenCalledTimes(3) // watcher callbacks perform no Git inspections
  observer.dispose()
  expect(h.handles[0].handle.close).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('debounces bursts, bounds continuous changes, and suppresses ignored-file hints', async () => {
  const h = harness()
  await observer.readWorkingTree('/repo', 'directory', consumer)
  h.handles[0].emitChange('change', 'ignored')
  await tick(1000)
  expect(h.publish).not.toHaveBeenCalled()
  for (let i = 0; i < 5; i++) { h.handles[0].emitChange('change', 'tracked'); await tick(200) }
  expect(h.publish).toHaveBeenCalledTimes(1)
  expect(h.readTree).toHaveBeenCalledTimes(1)
})

it('does not join reads from an older filesystem generation or retain rejected reads', async () => {
  const h = harness()
  let finish!: (value: { ok: true; lines: string[] }) => void
  h.readTree.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const old = observer.readWorkingTree('/repo', 'directory', consumer)
  await tick(0)
  h.handles[0].emitChange('change', 'tracked')
  h.readTree.mockResolvedValueOnce({ ok: true, lines: [' M new'] })
  expect(await observer.readWorkingTree('/repo', 'directory', consumer)).toEqual({ ok: true, lines: [' M new'] })
  finish({ ok: true, lines: [' M old'] }); await old
  h.readTree.mockRejectedValueOnce(new Error('read failed'))
  await expect(observer.readWorkingTree('/repo', 'directory', consumer)).rejects.toThrow('read failed')
  await expect(observer.readWorkingTree('/repo', 'directory', consumer)).resolves.toEqual({ ok: true, lines: [] })
  expect(h.readTree).toHaveBeenCalledTimes(4)
})

it('shares checkout reads by branch configuration and never joins explicit remote fetches', async () => {
  const h = harness()
  const repo = { name: 'app', localPath: '/repo' }
  const target = { feature: 'suite', repo: 'app' }
  await Promise.all([observer.readRepo(repo, target, {}), observer.readRepo({ ...repo, name: 'alias' }, target, {})])
  expect(h.readRepo).toHaveBeenCalledTimes(1)
  await Promise.all([observer.readRepo(repo, target, {}), observer.readRepo({ ...repo, branch: 'other' }, target, {})])
  expect(h.readRepo).toHaveBeenCalledTimes(3)
  await Promise.all([observer.readRepo(repo, target, { fetch: true }), observer.readRepo(repo, target, { fetch: true })])
  expect(h.readRepo).toHaveBeenCalledTimes(5)
})

it('expires each consumer lease independently and closes the last shared watch', async () => {
  const h = harness()
  await observer.readWorkingTree('/repo', 'directory', consumer)
  await tick(30000)
  await observer.readWorkingTree('/repo', 'directory', { flightId: 'second' })
  await tick(60000)
  expect(h.handles[0].handle.close).not.toHaveBeenCalled()
  h.handles[0].emitChange('change', 'tracked')
  await tick(250)
  expect(h.publish).toHaveBeenLastCalledWith({ type: 'repos-changed', consumers: [{ flightId: 'second' }] })
  await tick(29750)
  expect(h.handles[0].handle.close).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('rebuilds watches after structural events, missing filenames and asynchronous watch failures', async () => {
  const h = harness()
  await observer.readWorkingTree('/repo', 'directory', consumer)
  for (const filename of ['new-dir', null, '.gitignore']) {
    h.handles.at(-1)!.emitChange(filename === 'new-dir' ? 'rename' : 'change', filename)
    await observer.readWorkingTree('/repo', 'directory', consumer)
  }
  expect(h.watchPaths).toHaveBeenCalledTimes(4)
  h.handles.at(-1)!.handle.emit('error', new Error('watch ended'))
  await observer.readWorkingTree('/repo', 'directory', consumer)
  expect(h.watchPaths).toHaveBeenCalledTimes(4) // failure hints cannot create a tight retry loop
  await tick(30000)
  await observer.readWorkingTree('/repo', 'directory', consumer)
  expect(h.watchPaths).toHaveBeenCalledTimes(5)
  expect(h.log).toHaveBeenCalledWith(expect.stringContaining('watch failed'), expect.any(Error))
})

it('retries failed discovery and watcher-budget failures without blocking authoritative reads', async () => {
  const h = harness()
  h.watchPaths.mockRejectedValueOnce(new Error('missing path'))
  await expect(observer.readWorkingTree('/repo', 'directory', consumer)).resolves.toMatchObject({ ok: true })
  expect(h.watchPath).not.toHaveBeenCalled()
  await tick(30000)
  await observer.readWorkingTree('/repo', 'directory', consumer)
  expect(h.watchPath).toHaveBeenCalledTimes(1)
  observer.dispose()
  observer = createRepositoryObserver({ ...h.deps, maxWatches: 0 })
  await expect(observer.readWorkingTree('/repo', 'directory', consumer)).resolves.toMatchObject({ ok: true })
  expect(h.log).toHaveBeenLastCalledWith(expect.stringContaining('Unable to observe'), expect.objectContaining({ message: 'Repository watcher budget exhausted' }))
})

it('stops pending discovery and debounce publication on disposal or lease expiry', async () => {
  const h = harness()
  let finish!: (specs: RepositoryWatchPath[]) => void
  h.watchPaths.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const read = observer.readWorkingTree('/repo', 'directory', consumer)
  await tick(90000)
  finish([{ path: '/repo', recursive: true, accepts: () => true }])
  await read
  expect(h.watchPath).not.toHaveBeenCalled()
  observer.dispose()
  await observer.readWorkingTree('/repo', 'directory', consumer)
  expect(h.watchPath).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('retries a hung read next reconciliation without letting its late completion remove the newer read', async () => {
  const h = harness()
  let finishOld!: (value: { ok: true; lines: string[] }) => void
  let finishNew!: (value: { ok: true; lines: string[] }) => void
  h.readTree.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
  const old = observer.readWorkingTree('/repo', 'directory', consumer)
  await tick(30000)
  h.readTree.mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve }))
  const next = observer.readWorkingTree('/repo', 'directory', consumer)
  await tick(0)
  finishOld({ ok: true, lines: [] }); await old
  const sibling = observer.readWorkingTree('/repo', 'directory', consumer)
  await tick(0)
  expect(h.readTree).toHaveBeenCalledTimes(2)
  finishNew({ ok: true, lines: [' M new'] })
  expect(await next).toEqual(await sibling)
})

it('does not publish an expired consumer if the event loop resumes after its deadline', async () => {
  const h = harness()
  await observer.readWorkingTree('/repo', 'directory', consumer)
  h.handles[0].emitChange('change', 'tracked')
  vi.setSystemTime(100000)
  await tick(250)
  expect(h.publish).not.toHaveBeenCalled()
})
