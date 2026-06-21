import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FileBackedTaskStore, IllegalTaskTransitionError } from './file-backed-task-store'

interface Rec {
  id: string
  status: string
  feature: string
  createdAt: string
  endedAt?: string
  error?: string
}

function makeStore(logsDir: string) {
  return new FileBackedTaskStore<Rec>({
    logsDir,
    dirName: 'widgets',
    recordFile: 'record.json',
    idOf: (r) => r.id,
    statusOf: (r) => r.status,
    indexEntryOf: (r) => ({ id: r.id, status: r.status, feature: r.feature, createdAt: r.createdAt }),
    allowedTransitions: { created: ['running'], running: ['done', 'failed'], done: [], failed: [] },
    sortNewestFirst: true,
    reconcile: {
      isInterrupted: (r) => r.status === 'running',
      mark: (r, now) => ({ ...r, status: 'failed', endedAt: r.endedAt ?? now, error: r.error ?? 'Interrupted' }),
    },
  })
}

describe('FileBackedTaskStore', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbts-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('save writes the record to <dir>/<id>/<recordFile> and creates the index', () => {
    const store = makeStore(dir)
    store.save({ id: 'w1', status: 'created', feature: 'f', createdAt: '2026-01-01' })
    expect(fs.existsSync(path.join(dir, 'widgets', 'w1', 'record.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'widgets', 'index.json'))).toBe(true)
  })

  it('get reads the record back', () => {
    const store = makeStore(dir)
    store.save({ id: 'w1', status: 'created', feature: 'f', createdAt: '2026-01-01' })
    expect(store.get('w1')).toMatchObject({ id: 'w1', status: 'created', feature: 'f' })
    expect(store.get('missing')).toBeNull()
  })

  it('list returns index entries newest-first', () => {
    const store = makeStore(dir)
    store.save({ id: 'a', status: 'created', feature: 'f', createdAt: '2026-01-01' })
    store.save({ id: 'b', status: 'created', feature: 'f', createdAt: '2026-01-03' })
    store.save({ id: 'c', status: 'created', feature: 'f', createdAt: '2026-01-02' })
    expect(store.list().map((e) => e.id)).toEqual(['b', 'c', 'a'])
  })

  it('save upserts the index entry (no duplicate rows)', () => {
    const store = makeStore(dir)
    store.save({ id: 'a', status: 'created', feature: 'f', createdAt: '2026-01-01' })
    store.save({ id: 'a', status: 'running', feature: 'f', createdAt: '2026-01-01' })
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].status).toBe('running')
  })

  it('emits changed on save and removed on remove', () => {
    const store = makeStore(dir)
    const events: Array<{ kind: string; id?: string }> = []
    store.onEvent((e) => events.push(e))
    store.save({ id: 'a', status: 'created', feature: 'f', createdAt: '2026-01-01' })
    store.remove('a')
    expect(events).toEqual([{ kind: 'changed', id: 'a' }, { kind: 'removed', id: 'a' }])
    expect(store.get('a')).toBeNull()
    expect(store.list()).toHaveLength(0)
  })

  it('transition applies a legal move and rejects an illegal one', () => {
    const store = makeStore(dir)
    store.save({ id: 'a', status: 'created', feature: 'f', createdAt: '2026-01-01' })
    const next = store.transition('a', 'running')
    expect(next.status).toBe('running')
    expect(store.get('a')!.status).toBe('running')
    expect(() => store.transition('a', 'done')).not.toThrow()
    expect(() => store.transition('a', 'created')).toThrow(IllegalTaskTransitionError)
  })

  it('patch merges fields and persists', () => {
    const store = makeStore(dir)
    store.save({ id: 'a', status: 'created', feature: 'f', createdAt: '2026-01-01' })
    const next = store.patch('a', { error: 'boom' })
    expect(next!.error).toBe('boom')
    expect(store.get('a')!.error).toBe('boom')
    expect(store.patch('missing', { error: 'x' })).toBeNull()
  })

  it('reconcileInterrupted flips interrupted records via the configured mark', () => {
    const store = makeStore(dir)
    store.save({ id: 'a', status: 'running', feature: 'f', createdAt: '2026-01-01' })
    store.save({ id: 'b', status: 'done', feature: 'f', createdAt: '2026-01-01' })
    store.reconcileInterrupted(() => '2026-02-02')
    expect(store.get('a')).toMatchObject({ status: 'failed', endedAt: '2026-02-02', error: 'Interrupted' })
    expect(store.get('b')!.status).toBe('done')
  })

  it('a throwing listener does not break persistence', () => {
    const store = makeStore(dir)
    store.onEvent(() => { throw new Error('bad listener') })
    expect(() => store.save({ id: 'a', status: 'created', feature: 'f', createdAt: '2026-01-01' })).not.toThrow()
    expect(store.get('a')).not.toBeNull()
  })
})
