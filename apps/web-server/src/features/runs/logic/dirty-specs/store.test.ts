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
})
