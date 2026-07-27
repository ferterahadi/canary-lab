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
    featureOf: (r) => r.feature,
    withFeature: (r, feature) => ({ ...r, feature }),
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

  // Legacy rows written before the index carried `id` only have the feature's
  // own key. `idOfEntry` recovers them; without it remove() can't drop them and
  // they resurrect on refresh.
  function makeLegacyStore(logsDir: string) {
    return new FileBackedTaskStore<Rec>({
      logsDir,
      dirName: 'widgets',
      recordFile: 'record.json',
      idOf: (r) => r.id,
      indexEntryOf: (r) => ({ id: r.id, status: r.status, feature: r.feature, createdAt: r.createdAt }),
      idOfEntry: (e) => (typeof e.id === 'string' ? e.id : (e as { legacyId?: string }).legacyId),
    })
  }

  function writeLegacyIndex(logsDir: string, rows: Record<string, unknown>[]): void {
    const root = path.join(logsDir, 'widgets')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(rows))
  }

  it('remove drops a legacy id-less row from disk via idOfEntry (no resurrection on re-list)', () => {
    const store = makeLegacyStore(dir)
    const root = path.join(dir, 'widgets')
    fs.mkdirSync(path.join(root, 'w1'), { recursive: true })
    fs.writeFileSync(path.join(root, 'w1', 'record.json'), JSON.stringify({ id: 'w1', status: 'done', feature: 'f', createdAt: '2026-01-01' }))
    writeLegacyIndex(dir, [{ legacyId: 'w1', status: 'done', feature: 'f', createdAt: '2026-01-01' }])
    store.remove('w1')
    expect(store.list()).toEqual([]) // persisted — not just an optimistic event
    expect(fs.existsSync(path.join(root, 'w1'))).toBe(false)
  })

  it('pruneOrphans clears a legacy id-less row whose record was wiped', () => {
    const store = makeLegacyStore(dir)
    writeLegacyIndex(dir, [{ legacyId: 'gone', status: 'done', feature: 'f', createdAt: '2026-01-01' }])
    expect(store.pruneOrphans()).toEqual(['gone'])
    expect(store.list()).toEqual([])
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

  it('allows any transition when the store declares no state machine', () => {
    // `allowedTransitions` is optional; a store without one is a plain status
    // setter, so an otherwise-illegal-looking move must go through.
    const store = new FileBackedTaskStore<Rec>({
      logsDir: dir,
      dirName: 'freeform',
      recordFile: 'record.json',
      idOf: (r) => r.id,
      indexEntryOf: (r) => ({ id: r.id, status: r.status, feature: r.feature, createdAt: r.createdAt }),
    })
    store.save({ id: 'a', status: 'done', feature: 'f', createdAt: '2026-01-01' })
    expect(store.transition('a', 'created').status).toBe('created')
    expect(store.get('a')!.status).toBe('created')
  })

  it('transition throws a locating error when the record is gone', () => {
    // Distinct from IllegalTaskTransitionError on purpose: the caller can retry
    // an illegal move, but a missing record means the id itself is wrong.
    const store = makeStore(dir)
    expect(() => store.transition('nope', 'running')).toThrow('record not found: nope')
    expect(() => store.transition('nope', 'running')).not.toThrow(IllegalTaskTransitionError)
  })

  it('rejects every transition when transitions are declared without statusOf', () => {
    // Without `statusOf` the current state reads as '', which no transition map
    // lists — so the guard closes rather than silently allowing anything. A
    // store that declares a state machine must also say how to read the state.
    const store = new FileBackedTaskStore<Rec>({
      logsDir: dir,
      dirName: 'guarded',
      recordFile: 'record.json',
      idOf: (r) => r.id,
      indexEntryOf: (r) => ({ id: r.id, status: r.status, feature: r.feature, createdAt: r.createdAt }),
      allowedTransitions: { created: ['running'] },
    })
    store.save({ id: 'a', status: 'created', feature: 'f', createdAt: '2026-01-01' })
    expect(() => store.transition('a', 'running')).toThrow(IllegalTaskTransitionError)
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

  it('sinks undated legacy rows below dated ones, whichever side of the compare they land on', () => {
    // Two undated rows bracketing the dated ones so the comparator sees a
    // missing `createdAt` as both operands; the dated rows must still come
    // back newest-first rather than being reordered by the fallback.
    const store = makeStore(dir)
    store.save({ id: 'a', status: 'done', feature: 'f', createdAt: '2026-01-02' })
    store.save({ id: 'b', status: 'done', feature: 'f', createdAt: '2026-01-03' })
    const indexPath = path.join(dir, 'widgets', 'index.json')
    const rows = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    rows.unshift({ jobId: 'legacy-first', status: 'done', feature: 'f' })
    rows.push({ jobId: 'legacy-last', status: 'done', feature: 'f' })
    fs.writeFileSync(indexPath, JSON.stringify(rows))

    const listed = store.list()
    expect(listed).toHaveLength(4)
    expect(listed.slice(0, 2).map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('reconcileInterrupted is a no-op for a store with no reconcile config', () => {
    const store = new FileBackedTaskStore<Rec>({
      logsDir: dir,
      dirName: 'plain',
      recordFile: 'record.json',
      idOf: (r) => r.id,
      indexEntryOf: (r) => ({ id: r.id, status: r.status, feature: r.feature, createdAt: r.createdAt }),
    })
    store.save({ id: 'a', status: 'running', feature: 'f', createdAt: '2026-01-01' })
    store.reconcileInterrupted(() => '2026-02-02')
    expect(store.get('a')!.status).toBe('running')
  })

  it('runs an untrusted record through the configured validator', () => {
    // `validate` is the seam that keeps a hand-edited or half-written record
    // from reaching callers as a typed value; returning null must read as "no
    // record" rather than surfacing the raw JSON.
    const store = new FileBackedTaskStore<Rec>({
      logsDir: dir,
      dirName: 'validated',
      recordFile: 'record.json',
      idOf: (r) => r.id,
      indexEntryOf: (r) => ({ id: r.id, status: r.status, feature: r.feature, createdAt: r.createdAt }),
      validate: (raw) => {
        const rec = raw as Partial<Rec>
        return typeof rec.status === 'string' ? (raw as Rec) : null
      },
    })
    store.save({ id: 'good', status: 'done', feature: 'f', createdAt: '2026-01-01' })
    expect(store.get('good')).toMatchObject({ status: 'done' })

    fs.writeFileSync(
      path.join(dir, 'validated', 'good', 'record.json'),
      JSON.stringify({ id: 'good', feature: 'f', createdAt: '2026-01-01' }),
    )
    expect(store.get('good')).toBeNull()
  })

  it('treats an index file holding a non-array as empty', () => {
    const store = makeStore(dir)
    store.save({ id: 'a', status: 'done', feature: 'f', createdAt: '2026-01-01' })
    fs.writeFileSync(path.join(dir, 'widgets', 'index.json'), JSON.stringify({ rows: [] }))
    expect(store.list()).toEqual([])
  })

  it('offEvent stops a listener from receiving further events', () => {
    const store = makeStore(dir)
    const seen: string[] = []
    const listener = (event: { kind: string }): void => { seen.push(event.kind) }
    store.onEvent(listener)
    store.save({ id: 'a', status: 'created', feature: 'f', createdAt: '2026-01-01' })
    store.offEvent(listener)
    store.save({ id: 'b', status: 'created', feature: 'f', createdAt: '2026-01-02' })
    expect(seen).toEqual(['changed'])
  })

  describe('renameFeature', () => {
    it('rewrites the feature on every matching record and index row, leaving others alone', () => {
      const store = makeStore(dir)
      store.save({ id: 'a', status: 'done', feature: 'old', createdAt: '2026-01-01' })
      store.save({ id: 'b', status: 'done', feature: 'other', createdAt: '2026-01-02' })
      store.save({ id: 'c', status: 'done', feature: 'old', createdAt: '2026-01-03' })

      expect(store.renameFeature('old', 'new')).toBe(2)

      expect(store.get('a')).toMatchObject({ feature: 'new' })
      expect(store.get('c')).toMatchObject({ feature: 'new' })
      expect(store.get('b')).toMatchObject({ feature: 'other' })
      expect(store.list().map((e) => e.feature).sort()).toEqual(['new', 'new', 'other'])
    })

    it('skips legacy index rows that carry no resolvable id', () => {
      // Same legacy shape reconcileInterrupted guards against: an unkeyed row
      // has no record to load, so renaming must step over it rather than
      // path.join(undefined,…) and take the whole rename down with it.
      const store = makeStore(dir)
      store.save({ id: 'a', status: 'done', feature: 'old', createdAt: '2026-01-01' })
      const indexPath = path.join(dir, 'widgets', 'index.json')
      const rows = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      rows.push({ jobId: 'legacy', status: 'done', feature: 'old' })
      fs.writeFileSync(indexPath, JSON.stringify(rows))

      expect(store.renameFeature('old', 'new')).toBe(1)
      expect(store.get('a')).toMatchObject({ feature: 'new' })
    })

    it('is a no-op when the store carries no feature, or from === to', () => {
      const featureless = new FileBackedTaskStore<Rec>({
        logsDir: dir,
        dirName: 'featureless',
        recordFile: 'record.json',
        idOf: (r) => r.id,
        indexEntryOf: (r) => ({ id: r.id, createdAt: r.createdAt }),
      })
      featureless.save({ id: 'a', status: 'done', feature: 'old', createdAt: '2026-01-01' })
      expect(featureless.renameFeature('old', 'new')).toBe(0)
      expect(featureless.get('a')).toMatchObject({ feature: 'old' })

      const store = makeStore(dir)
      store.save({ id: 'a', status: 'done', feature: 'old', createdAt: '2026-01-01' })
      expect(store.renameFeature('old', 'old')).toBe(0)
    })

    it('moves the record directory (sidecars included) when the id IS the feature name', () => {
      // dirty-specs keys its record BY the feature — renaming re-homes the row.
      const keyed = new FileBackedTaskStore<Rec>({
        logsDir: dir,
        dirName: 'keyed',
        recordFile: 'record.json',
        idOf: (r) => r.feature,
        indexEntryOf: (r) => ({ id: r.feature, feature: r.feature, createdAt: r.createdAt }),
        featureOf: (r) => r.feature,
        withFeature: (r, feature) => ({ ...r, id: feature, feature }),
      })
      keyed.save({ id: 'old', status: 'done', feature: 'old', createdAt: '2026-01-01' })
      fs.writeFileSync(path.join(keyed.recordDir('old'), 'sidecar.txt'), 'keep me')

      expect(keyed.renameFeature('old', 'new')).toBe(1)

      expect(keyed.get('new')).toMatchObject({ feature: 'new' })
      expect(keyed.get('old')).toBeNull()
      expect(fs.existsSync(keyed.recordDir('old'))).toBe(false)
      expect(fs.readFileSync(path.join(keyed.recordDir('new'), 'sidecar.txt'), 'utf8')).toBe('keep me')
      expect(keyed.list().map((e) => e.id)).toEqual(['new'])
    })
  })

  it('a throwing listener does not break persistence', () => {
    const store = makeStore(dir)
    store.onEvent(() => { throw new Error('bad listener') })
    expect(() => store.save({ id: 'a', status: 'created', feature: 'f', createdAt: '2026-01-01' })).not.toThrow()
    expect(store.get('a')).not.toBeNull()
  })
})
