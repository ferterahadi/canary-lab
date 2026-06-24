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

  it('pruneOrphans drops index rows whose record dir was wiped out-of-band, and emits removed', () => {
    const store = makeStore(dir)
    store.save({ id: 'a', status: 'done', feature: 'f', createdAt: '2026-01-01' })
    store.save({ id: 'b', status: 'done', feature: 'f', createdAt: '2026-01-02' })
    store.save({ id: 'c', status: 'done', feature: 'f', createdAt: '2026-01-03' })
    // Wipe b's record dir directly (a logs cleanup / manual rm) — the index row lingers.
    fs.rmSync(path.join(dir, 'widgets', 'b'), { recursive: true, force: true })
    const events: unknown[] = []
    store.onEvent((e) => events.push(e))
    const pruned = store.pruneOrphans()
    expect(pruned).toEqual(['b'])
    expect(store.list().map((e) => e.id).sort()).toEqual(['a', 'c'])
    expect(events).toEqual([{ kind: 'removed', id: 'b' }])
  })

  it('pruneOrphans is a no-op (no events) when every row has its record', () => {
    const store = makeStore(dir)
    store.save({ id: 'a', status: 'done', feature: 'f', createdAt: '2026-01-01' })
    const events: unknown[] = []
    store.onEvent((e) => events.push(e))
    expect(store.pruneOrphans()).toEqual([])
    expect(events).toEqual([])
    expect(store.list().map((e) => e.id)).toEqual(['a'])
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

  it('reconcileInterrupted tolerates legacy index entries lacking an id', () => {
    // A pre-refactor store wrote index rows keyed by a feature-specific field
    // (e.g. jobId) with no generic `id`/`createdAt`. reconcileInterrupted must
    // skip those rather than path.join(undefined,…) and crash server boot.
    const store = makeStore(dir)
    store.save({ id: 'a', status: 'running', feature: 'f', createdAt: '2026-01-02' })
    const indexPath = path.join(dir, 'widgets', 'index.json')
    const rows = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    rows.push({ jobId: 'legacy', status: 'done', feature: 'f' })
    fs.writeFileSync(indexPath, JSON.stringify(rows))
    expect(() => store.reconcileInterrupted(() => '2026-02-02')).not.toThrow()
    expect(store.get('a')).toMatchObject({ status: 'failed' })
  })

  it('list tolerates legacy index entries lacking createdAt when sorting', () => {
    const store = makeStore(dir)
    store.save({ id: 'a', status: 'done', feature: 'f', createdAt: '2026-01-02' })
    const indexPath = path.join(dir, 'widgets', 'index.json')
    const rows = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    rows.push({ jobId: 'legacy', status: 'done', feature: 'f' })
    fs.writeFileSync(indexPath, JSON.stringify(rows))
    expect(() => store.list()).not.toThrow()
  })

  it('a throwing listener does not break persistence', () => {
    const store = makeStore(dir)
    store.onEvent(() => { throw new Error('bad listener') })
    expect(() => store.save({ id: 'a', status: 'created', feature: 'f', createdAt: '2026-01-01' })).not.toThrow()
    expect(store.get('a')).not.toBeNull()
  })
})
