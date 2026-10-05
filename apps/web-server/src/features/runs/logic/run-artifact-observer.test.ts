import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRunArtifactObserver, type RunArtifactObserver } from './run-artifact-observer'
import { RunStore, type RunStoreEvent } from './run-store'
import { createRegistry } from './run-registry'
import type { WatchDirectory } from './run-file-watcher'

let root: string
let store: RunStore
let observer: RunArtifactObserver
let events: RunStoreEvent[]
let watches: { listener: Parameters<WatchDirectory>[2]; handle: EventEmitter & { close: ReturnType<typeof vi.fn> } }[]
const log = vi.fn()
const watch: WatchDirectory = (_dir, _opts, listener) => {
  const handle = Object.assign(new EventEmitter(), { close: vi.fn() })
  watches.push({ listener, handle })
  return handle as unknown as fs.FSWatcher
}
function seed(id = 'run-1') {
  const dir = path.join(root, 'runs', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId: id, status: 'passed', feature: 'fixture', services: [], healCycles: 0 }))
  return dir
}
function write(name: string, content: string, id = 'run-1') { fs.writeFileSync(path.join(root, 'runs', id, name), content) }
async function changed(name: string | Buffer | null = null, delay = 251) {
  watches.at(-1)!.listener('change', name)
  await vi.advanceTimersByTimeAsync(delay)
}
beforeEach(() => {
  vi.useFakeTimers()
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-observer-')))
  store = new RunStore(root, createRegistry())
  events = []; watches = []; log.mockReset()
  store.onEvent(event => events.push(event))
  observer = createRunArtifactObserver({ store, log, watchDirectory: watch })
})
afterEach(() => { observer.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }) })

it('seeds fingerprints, filters unrelated writes and shares one leased watch', async () => {
  seed(); observer.observe('run-1'); observer.observe('run-1')
  expect(watches).toHaveLength(1)
  await changed(null); expect(events).toEqual([])
  write('unrelated.txt', 'ignored'); await changed('unrelated.txt'); expect(events).toEqual([])
  write('diagnosis-journal.md', 'created'); await changed(Buffer.from('diagnosis-journal.md'))
  expect(events).toEqual([{ kind: 'journal-changed', runId: 'run-1' }])
  await changed(); write('diagnosis-journal.md', 'created'); await changed(); expect(events).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(80_000); observer.observe('run-1')
  await vi.advanceTimersByTimeAsync(80_000); expect(watches[0].handle.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10_000); expect(watches[0].handle.close).toHaveBeenCalledOnce()
  observer.observe('run-1'); expect(watches).toHaveLength(2)
})

it('detects creation, append, replacement, truncation and removal', async () => {
  const dir = seed(); observer.observe('run-1')
  write('diagnosis-journal.md', 'first'); await changed()
  fs.appendFileSync(path.join(dir, 'diagnosis-journal.md'), '\nsecond'); await changed()
  write('journal.tmp', 'replacement'); fs.renameSync(path.join(dir, 'journal.tmp'), path.join(dir, 'diagnosis-journal.md')); await changed()
  write('diagnosis-journal.md', ''); await changed()
  fs.unlinkSync(path.join(dir, 'diagnosis-journal.md')); await changed()
  expect(events.map(e => e.kind)).toEqual(Array(5).fill('journal-changed'))
  write('lifecycle-events.jsonl', '{"type":"change"}\npartial'); await changed()
  write('manifest.json', '{"runId":"run-1","status":"failed"}'); await changed()
  expect(events.slice(5)).toEqual(Array(2).fill({ kind: 'changed', runId: 'run-1' }))
})

it('coalesces bursts with a one-second maximum delay', async () => {
  seed(); observer.observe('run-1')
  for (let i = 0; i < 5; i++) { write('diagnosis-journal.md', String(i)); await changed(null, 200) }
  expect(events).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(2); expect(events).toHaveLength(1)
  await changed(); expect(events).toHaveLength(1)
})

it('does not duplicate normal store notifications and releases removed observations', async () => {
  seed(); observer.observe('run-1')
  write('diagnosis-journal.md', 'store write'); store.recordJournalChange('run-1'); await changed()
  write('lifecycle-events.jsonl', 'event'); store.notifyDetailChanged('run-1'); await changed()
  for (const kind of ['finalized', 'bootstrap'] as const) {
    write('lifecycle-events.jsonl', kind); store.emit('event', { kind, runId: 'run-1' }); await changed()
  }
  store.emit('event', { kind: 'list-changed' }); store.notifyDetailChanged('unknown')
  store.emit('event', { kind: 'other', runId: 'run-1' })
  expect(events.filter(e => e.kind === 'changed' && e.runId === 'run-1')).toHaveLength(1)
  expect(events.filter(e => e.kind === 'journal-changed')).toHaveLength(1)
  store.emit('event', { kind: 'removed', runId: 'run-1' }); expect(watches[0].handle.close).toHaveBeenCalledOnce()
})

it('retains fingerprints through invalid and unreadable files, then recovers', async () => {
  seed(); observer.observe('run-1')
  for (const invalid of ['', '{', 'null', '3', '{}', '{"runId":"run-1"}']) {
    write('manifest.json', invalid); write('lifecycle-events.jsonl', invalid); await changed()
    expect(events).toEqual([])
  }
  const read = fs.readFileSync
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith('diagnosis-journal.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return read(...args)
  })
  await changed(); expect(events).toEqual([]); spy.mockRestore()
  write('manifest.json', '{"runId":"run-1","status":"passed"}'); await changed()
  expect(events).toEqual([{ kind: 'changed', runId: 'run-1' }])
})

it('retries watch failures and replaced directories on subsequent reads', async () => {
  const dir = seed(); observer.observe('run-1')
  write('diagnosis-journal.md', 'pending'); await changed(null, 1)
  watches[0].handle.emit('error', new Error('watch lost'))
  await vi.advanceTimersByTimeAsync(300); expect(events).toEqual([]); expect(log).toHaveBeenCalledOnce()
  observer.observe('run-1'); expect(watches).toHaveLength(2)
  fs.renameSync(dir, `${dir}-old`); seed(); observer.observe('run-1')
  expect(watches).toHaveLength(3); expect(watches[1].handle.close).toHaveBeenCalledOnce()
  observer.dispose()
  observer = createRunArtifactObserver({ store, log, watchDirectory: () => { throw new Error('unavailable') } })
  observer.observe('run-1'); observer.observe('run-1'); expect(log).toHaveBeenCalledTimes(3)
})

it('bounds resources and ignores invalid, absent, non-directory and escaping runs', async () => {
  observer.dispose(); observer = createRunArtifactObserver({ store, log, watchDirectory: watch, maxWatches: 1 })
  observer.observe('missing-root'); seed(); seed('run-2')
  for (const id of ['', '.', '..', '../elsewhere', 'bad/path', 'bad\\path', 'missing']) observer.observe(id)
  fs.writeFileSync(path.join(root, 'runs', 'file'), 'file'); observer.observe('file')
  fs.symlinkSync(root, path.join(root, 'runs', 'outside')); observer.observe('outside')
  write('manifest.json', '{}'); observer.observe('run-1'); expect(watches).toHaveLength(0)
  seed(); observer.observe('run-1'); observer.observe('run-2'); expect(watches).toHaveLength(1)
  write('diagnosis-journal.md', 'pending'); await changed(null, 1)
  observer.dispose(); observer.observe('run-2'); await vi.advanceTimersByTimeAsync(90_000)
  expect(events).toEqual([]); expect(watches[0].handle.close).toHaveBeenCalledOnce()
  expect(store.listenerCount('event')).toBe(1)
})

it('receives real filesystem events without a store writer', async () => {
  vi.useRealTimers(); observer.dispose()
  const dir = seed(); observer = createRunArtifactObserver({ store, log }); observer.observe('run-1')
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(log.mock.calls).toEqual([])
  fs.writeFileSync(path.join(dir, 'diagnosis-journal.md'), 'external')
  await vi.waitFor(() => expect(events).toEqual([{ kind: 'journal-changed', runId: 'run-1' }]), { timeout: 2000 })
})

it.each(['removed', 'replaced', 'symlink'])('releases a %s directory before reading redirected artifacts', async (mode) => {
  const dir = seed(); observer.observe('run-1')
  fs.renameSync(dir, `${dir}-old`)
  if (mode === 'replaced') seed()
  if (mode === 'symlink') fs.symlinkSync(root, dir)
  await changed()
  expect(events).toEqual([]); expect(watches[0].handle.close).toHaveBeenCalledOnce()
})
it('releases redirected watches on store acknowledgement too', () => {
  const dir = seed(); observer.observe('run-1'); fs.rmSync(dir, { recursive: true })
  store.notifyDetailChanged('run-1'); expect(watches[0].handle.close).toHaveBeenCalledOnce()
})
