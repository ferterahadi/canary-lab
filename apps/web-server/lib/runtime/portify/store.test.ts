import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortifyRunStore } from './store'
import type { PortifyManifest } from './types'

const roots: string[] = []
afterEach(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})
function tmpLogs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-store-'))
  roots.push(d)
  return d
}

function manifest(over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'portify-1',
    feature: 'cns',
    featureDir: '/f',
    repos: [{ name: 'r', path: '~/r' }],
    agent: 'claude',
    branch: 'canary/dynamic-ports-cns',
    status: 'planning',
    attempt: 0,
    maxAttempts: 3,
    startedAt: '2026-06-07T00:00:00.000Z',
    ...over,
  }
}

describe('PortifyRunStore', () => {
  it('save persists the manifest + index entry and get/list read them back', () => {
    const logs = tmpLogs()
    const store = new PortifyRunStore(logs)
    expect(store.list()).toEqual([])
    expect(store.get('portify-1')).toBeNull()

    store.save(manifest())
    const got = store.get('portify-1')
    expect(got?.workflowId).toBe('portify-1')
    expect(store.list()).toEqual([
      { workflowId: 'portify-1', feature: 'cns', status: 'planning', startedAt: '2026-06-07T00:00:00.000Z' },
    ])
  })

  it('save upserts an existing index entry (status + endedAt update in place)', () => {
    const store = new PortifyRunStore(tmpLogs())
    store.save(manifest())
    store.save(manifest({ status: 'committed', endedAt: '2026-06-07T00:05:00.000Z' }))
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ status: 'committed', endedAt: '2026-06-07T00:05:00.000Z' })
  })

  it('emits a changed event on save, and offEvent unsubscribes', () => {
    const store = new PortifyRunStore(tmpLogs())
    const events: unknown[] = []
    const fn = (e: unknown) => events.push(e)
    store.onEvent(fn)
    store.save(manifest())
    expect(events).toEqual([{ kind: 'changed', workflowId: 'portify-1' }])
    store.offEvent(fn)
    store.save(manifest({ status: 'editing' }))
    expect(events).toHaveLength(1)
  })

  it('a throwing listener does not break persistence', () => {
    const store = new PortifyRunStore(tmpLogs())
    store.onEvent(() => { throw new Error('bad listener') })
    expect(() => store.save(manifest())).not.toThrow()
    expect(store.get('portify-1')).not.toBeNull()
  })

  it('get returns null for a corrupt manifest, list returns [] for a corrupt index', () => {
    const logs = tmpLogs()
    const store = new PortifyRunStore(logs)
    store.save(manifest())
    fs.writeFileSync(path.join(logs, 'portify', 'portify-1', 'portify.json'), '{not json')
    expect(store.get('portify-1')).toBeNull()
    fs.writeFileSync(path.join(logs, 'portify', 'index.json'), '{not json')
    expect(store.list()).toEqual([])
  })

  it('list returns [] when the index JSON is valid but not an array', () => {
    const logs = tmpLogs()
    const store = new PortifyRunStore(logs)
    store.save(manifest())
    fs.writeFileSync(path.join(logs, 'portify', 'index.json'), '{"not":"an array"}')
    expect(store.list()).toEqual([])
  })

  it('reconcileInterrupted flips non-terminal workflows to aborted, leaves terminal ones', () => {
    const store = new PortifyRunStore(tmpLogs())
    store.save(manifest({ workflowId: 'a', status: 'editing' }))
    store.save(manifest({ workflowId: 'b', status: 'ready-to-commit' }))
    store.save(manifest({ workflowId: 'c', status: 'committed' }))
    store.reconcileInterrupted(() => '2026-06-07T01:00:00.000Z')
    expect(store.get('a')?.status).toBe('aborted')
    expect(store.get('a')?.error).toContain('Interrupted by server restart')
    expect(store.get('b')?.status).toBe('aborted')
    expect(store.get('c')?.status).toBe('committed')
  })

  it('reconcileInterrupted skips an index entry whose manifest is missing', () => {
    const logs = tmpLogs()
    const store = new PortifyRunStore(logs)
    store.save(manifest({ workflowId: 'a', status: 'editing' }))
    fs.rmSync(path.join(logs, 'portify', 'a', 'portify.json'))
    expect(() => store.reconcileInterrupted(() => 'x')).not.toThrow()
  })
})
