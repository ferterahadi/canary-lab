import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirtySpecStore } from './store'

let root: string
let featureDir: string
let logsDir: string

function git(args: string[]): void {
  execFileSync('git', args, { cwd: featureDir, stdio: 'pipe' })
}

function writeSpec(body: string): void {
  const abs = path.join(featureDir, 'e2e', 'voucher.spec.ts')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

const PASS = `test('applies voucher', async () => { expect(1).toBe(1) })\n`
const TAMPERED = `test('applies voucher', async () => { expect(1).toBe(2) })\n`

const TWO_TESTS = `test('a', async () => { expect(1).toBe(1) })
test('b', async () => { expect(2).toBe(2) })
`
const TWO_TESTS_B_EDITED = `test('a', async () => { expect(1).toBe(1) })
test('b', async () => { expect(2).toBe(3) })
`

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirty-store-'))
  featureDir = path.join(root, 'feature')
  logsDir = path.join(root, 'logs')
  fs.mkdirSync(featureDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: featureDir, stdio: 'pipe' })
  git(['config', 'user.email', 't@t.dev'])
  git(['config', 'user.name', 'test'])
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('DirtySpecStore', () => {
  it('captures run-start, flags a mid-run edit, and emits a change event', async () => {
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir)
    const events: string[] = []
    store.onEvent((e) => events.push(e.kind))

    await store.captureRunStart('checkout', featureDir)
    expect(store.isDirty('checkout')).toBe(false)

    writeSpec(TAMPERED)
    const rec = await store.recompute('checkout', featureDir)
    expect(rec.status).toBe('dirty')
    expect(store.isDirty('checkout')).toBe(true)
    expect(events).toContain('changed')

    // record persisted to disk atomically
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(logsDir, 'dirty-specs', 'checkout', 'dirty.json'), 'utf8'),
    )
    expect(onDisk.status).toBe('dirty')
    expect(onDisk.message).toContain('Tests have been modified')
  })

  // Every emit becomes a `tests-dirty-changed` push and a full `/api/features`
  // refetch on the client. The `.git` watcher fans a single git write out to
  // every feature sharing that root, so a recompute that changed nothing must
  // stay completely silent — measured at 33 wasted refetches per git write.
  it('does not re-write or re-emit when a recompute finds nothing new', async () => {
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir)
    await store.captureRunStart('checkout', featureDir)

    const recordPath = path.join(logsDir, 'dirty-specs', 'checkout', 'dirty.json')
    const mtimeBefore = fs.statSync(recordPath).mtimeMs
    const events: string[] = []
    store.onEvent((e) => events.push(e.kind))

    await store.recompute('checkout', featureDir)
    await store.recompute('checkout', featureDir)

    expect(events).toEqual([])
    expect(fs.statSync(recordPath).mtimeMs).toBe(mtimeBefore)
    expect(store.isDirty('checkout')).toBe(false)
  })

  // Guards the trap in the skip check: callers hand `saveWithDirty` an already
  // augmented record, so the comparison has to be against what's on disk. A
  // baseline rewrite carries the same status and dirtySpecs as the stored row.
  it('still saves when only a baseline changed, with status and dirtySpecs untouched', async () => {
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir)
    await store.captureRunStart('checkout', featureDir)
    const firstHashes = store.get('checkout')?.runStartHashes

    // A different-but-still-clean tree: re-capturing must persist new baselines.
    writeSpec(TWO_TESTS)
    const events: string[] = []
    store.onEvent((e) => events.push(e.kind))
    const rec = await store.captureRunStart('checkout', featureDir)

    expect(rec.status).toBe('clean')
    expect(rec.dirtySpecs).toEqual([])
    expect(rec.runStartHashes).not.toEqual(firstHashes)
    expect(events).toContain('changed')
    const onDisk = JSON.parse(fs.readFileSync(path.join(logsDir, 'dirty-specs', 'checkout', 'dirty.json'), 'utf8'))
    expect(onDisk.runStartHashes).toEqual(rec.runStartHashes)
  })

  it('approve clears the dirty flag', async () => {
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir)
    await store.captureRunStart('checkout', featureDir)
    writeSpec(TAMPERED)
    await store.recompute('checkout', featureDir)
    expect(store.isDirty('checkout')).toBe(true)

    await store.approve('checkout', featureDir)
    expect(store.isDirty('checkout')).toBe(false)
  })

  it('finalizeRun(pass) promotes an untampered green; a later edit re-dirties', async () => {
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir)
    await store.captureRunStart('checkout', featureDir)
    await store.finalizeRun('checkout', featureDir, true)
    expect(store.get('checkout')?.lastGreenHashes['e2e/voucher.spec.ts']).toBeTruthy()

    writeSpec(TAMPERED)
    const rec = await store.recompute('checkout', featureDir)
    expect(rec.status).toBe('dirty')
  })

  it('finalizeRun(pass) does NOT promote a spec tampered with mid-run', async () => {
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir)
    await store.captureRunStart('checkout', featureDir)
    // agent edits the spec during the heal window, then it "passes"
    writeSpec(TAMPERED)
    const rec = await store.finalizeRun('checkout', featureDir, true)
    expect(rec.status).toBe('dirty')
    expect(store.get('checkout')?.lastGreenHashes['e2e/voucher.spec.ts']).toBeUndefined()
  })

  it('finalizeRun(pass) tolerates a legacy record with no per-test hash fields on disk', async () => {
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir)
    await store.captureRunStart('checkout', featureDir)

    // Simulate a record persisted before per-test hashes existed: strip the
    // fields directly from the file on disk, bypassing the store's own API
    // (which always writes them), so `finalizeRun` sees them as undefined.
    const recordPath = path.join(logsDir, 'dirty-specs', 'checkout', 'dirty.json')
    const raw = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
    delete raw.runStartTestHashes
    delete raw.lastGreenTestHashes
    fs.writeFileSync(recordPath, JSON.stringify(raw))

    const rec = await store.finalizeRun('checkout', featureDir, true)
    expect(rec.status).toBe('clean')
    expect(store.get('checkout')?.lastGreenHashes['e2e/voucher.spec.ts']).toBeTruthy()
  })

  it('finalizeRun(fail) leaves the green baseline untouched', async () => {
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir)
    await store.captureRunStart('checkout', featureDir)
    await store.finalizeRun('checkout', featureDir, false)
    expect(store.get('checkout')?.lastGreenHashes).toEqual({})
  })

  it('narrows affectedTests to the edited test across a full run-start/recompute cycle', async () => {
    writeSpec(TWO_TESTS)
    const store = new DirtySpecStore(logsDir)
    await store.captureRunStart('checkout', featureDir)

    writeSpec(TWO_TESTS_B_EDITED)
    const rec = await store.recompute('checkout', featureDir)
    expect(rec.status).toBe('dirty')
    expect(rec.dirtySpecs[0].affectedTests).toEqual(['b'])
  })

  it('stamps `since` only when status changes', async () => {
    const clock = vi.fn()
    clock.mockReturnValueOnce('t0').mockReturnValueOnce('t0').mockReturnValue('t1')
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir, clock)
    await store.captureRunStart('checkout', featureDir)
    const before = store.get('checkout')?.since
    await store.recompute('checkout', featureDir)
    expect(store.get('checkout')?.since).toBe(before)
  })

  it('remove deletes the record so get() and isDirty() see nothing', async () => {
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir)
    await store.captureRunStart('checkout', featureDir)
    expect(store.get('checkout')).not.toBeNull()

    store.remove('checkout')
    expect(store.get('checkout')).toBeNull()
    expect(store.isDirty('checkout')).toBe(false)
    expect(fs.existsSync(path.join(logsDir, 'dirty-specs', 'checkout', 'dirty.json'))).toBe(false)
  })

  it('remove emits a removed event', async () => {
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir)
    await store.captureRunStart('checkout', featureDir)
    const events: string[] = []
    store.onEvent((e) => events.push(e.kind))

    store.remove('checkout')
    expect(events).toContain('removed')
  })

  it('offEvent stops a listener from receiving further events', async () => {
    writeSpec(PASS)
    const store = new DirtySpecStore(logsDir)
    const events: string[] = []
    const listener = (e: { kind: string }) => events.push(e.kind)
    store.onEvent(listener)

    await store.captureRunStart('checkout', featureDir)
    expect(events.length).toBeGreaterThan(0)

    store.offEvent(listener)
    events.length = 0
    writeSpec(TAMPERED)
    await store.recompute('checkout', featureDir)
    expect(events).toEqual([])
  })

  it('renameFeature() moves the record to the new feature id', async () => {
    // Here the feature name IS the record id, so a rename re-homes the record
    // directory as well as the field — the dirty cue has to follow the suite.
    const store = new DirtySpecStore(logsDir)
    writeSpec(PASS)
    await store.captureRunStart('checkout', featureDir)
    expect(store.get('checkout')).not.toBeNull()

    expect(store.renameFeature('checkout', 'checkout_v2')).toBe(1)
    expect(store.get('checkout')).toBeNull()
    const moved = store.get('checkout_v2')
    expect(moved?.featureId).toBe('checkout_v2')
    expect(moved?.id).toBe('checkout_v2')
  })

  it('renameFeature() is a no-op when no record matches', async () => {
    const store = new DirtySpecStore(logsDir)
    writeSpec(PASS)
    await store.captureRunStart('checkout', featureDir)
    expect(store.renameFeature('absent', 'other')).toBe(0)
    expect(store.get('checkout')?.featureId).toBe('checkout')
  })

  it('remove() drops the record', async () => {
    const store = new DirtySpecStore(logsDir)
    writeSpec(PASS)
    await store.captureRunStart('checkout', featureDir)
    store.remove('checkout')
    expect(store.get('checkout')).toBeNull()
  })
})
