import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationStore } from './store'
import { notificationRoutes } from './index'
import type { NotificationSource } from '../../../../../shared/notifications/types'
import type { RunManifest } from '../runs/logic/runtime/manifest'
import { suiteReviewRevision } from '../runs/logic/runtime/suite-review'

let dir: string
const events = { publish: vi.fn() }
const source: NotificationSource = { key: 'flight:f1', signature: 'failed:run', message: { title: 'checkout paused', body: 'Test run failed', target: { kind: 'flight', flightId: 'f1' }, toast: true } }
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifications-')); events.publish.mockClear() })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

it('keeps passive coverage state out of the inbox and resolves test review through its owning event', async () => {
  const { register } = await import('./index')
  const dirtyListeners = new Set<() => void>()
  let dirty = true
  const app = Fastify()
  await register(app, {
    logsDir: dir, featuresDir: dir, workspaceEvents: events,
    coverageMonitor: { reconcile: vi.fn(), list: () => [{ feature: 'shop', freshness: { state: 'stale' } }] },
    dirtySpecStore: {
      list: () => [{ featureId: 'shop', status: dirty ? 'dirty' : 'clean', dirtySpecs: dirty ? [{ strength: { verdict: 'weaker' } }] : [] }],
      onEvent: (fn: () => void) => dirtyListeners.add(fn), offEvent: (fn: () => void) => dirtyListeners.delete(fn),
    },
    runStore: { list: () => [], get: () => null, onEvent: vi.fn(), offEvent: vi.fn() },
    flightStore: { list: () => [], latestForFeature: () => ({ flightId: 'f1' }), onEvent: vi.fn(), offEvent: vi.fn() },
  } as unknown as import('../../server-context').ServerContext)
  try {
    const initial = (await app.inject('/api/notifications')).json()
    expect(initial).toHaveLength(1)
    const [review] = initial
    expect(review.title).toBe('shop: possible test weakening')
    expect(review).toMatchObject({ toast: false, target: { kind: 'test-review', feature: 'shop' } })
    dirty = false
    for (const fn of dirtyListeners) fn()
    const current = (await app.inject('/api/notifications')).json()
    expect(current).toEqual([expect.objectContaining({ id: review.id, resolvedAt: expect.any(String) })])
  } finally { await app.close() }
  expect(dirtyListeners.size).toBe(0)
})

describe('durable notifications', () => {
  it('upgrades an existing neutral test review to warning without duplicating it or resetting read state', () => {
    const current: NotificationSource = {
      key: 'test-review:shop',
      signature: 'attention',
      message: { title: 'shop awaits review', body: '1 changed file', severity: 'warning', target: { kind: 'test-review', feature: 'shop' } },
    }
    const store = new NotificationStore(dir, events)
    store.reconcile([{ ...current, message: { ...current.message!, severity: 'neutral' } }])
    const original = store.list()[0]
    store.markRead(original.id)
    events.publish.mockClear()
    store.reconcile([current])
    expect(store.list()).toEqual([expect.objectContaining({ id: original.id, severity: 'warning', readAt: expect.any(String) })])
    expect(events.publish).toHaveBeenCalledExactlyOnceWith({ type: 'notifications-changed' })
    store.remove(original.id)
    store.reconcile([current])
    expect(store.list()).toEqual([])
  })

  it('never resurrects deleted messages after reload, a fresh store, or repeat source updates', () => {
    const store = new NotificationStore(dir, events)
    store.reconcile([source])
    const item = store.list()[0]
    store.remove(item.id)
    for (let n = 0; n < 3; n++) new NotificationStore(dir, events).reconcile([source])
    expect(new NotificationStore(dir, events).list()).toEqual([])
    const disk = fs.readFileSync(path.join(dir, 'notifications/state.json'), 'utf8')
    expect(disk).not.toContain('checkout paused')
    expect(events.publish).toHaveBeenCalledTimes(2)
  })

  it('updates a retained message without making it unread again or recreating a deleted one', () => {
    const store = new NotificationStore(dir, events)
    store.reconcile([source])
    const original = store.list()[0]
    store.markRead(original.id)
    const updated = { ...source, message: { ...source.message!, body: '2 test files changed' } }
    store.reconcile([updated])
    expect(store.list()[0]).toMatchObject({ id: original.id, createdAt: original.createdAt, body: '2 test files changed', readAt: expect.any(String) })
    store.remove(original.id)
    store.reconcile([source])
    expect(store.list()).toEqual([])
  })

  it('re-arms one retained message when the same issue escalates to danger', () => {
    const store = new NotificationStore(dir, events)
    store.reconcile([source])
    const original = store.list()[0]
    store.markRead(original.id)
    store.reconcile([{ ...source, message: { ...source.message!, severity: 'danger', body: 'Possible integrity weakening' } }])
    const [escalated] = store.list()
    expect(escalated).toMatchObject({
      id: original.id,
      severity: 'danger',
      body: 'Possible integrity weakening',
    })
    expect(escalated).not.toHaveProperty('readAt')
  })

  it('re-arms a retained inbox item when it becomes eligible for a blocking toast', () => {
    const store = new NotificationStore(dir, events)
    store.reconcile([{ ...source, message: { ...source.message!, toast: false } }])
    const original = store.list()[0]
    store.markRead(original.id)
    store.reconcile([source])
    expect(store.list()[0]).toMatchObject({ id: original.id, toast: true })
    expect(store.list()[0]).not.toHaveProperty('readAt')
  })

  it('creates a new notification when a recovered flight fails again, without restoring its old message', () => {
    const store = new NotificationStore(dir, events)
    store.reconcile([source])
    const old = store.list()[0].id
    store.remove(old)
    store.reconcile([{ key: source.key, signature: 'quiet' }])
    store.reconcile([source])
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].id).not.toBe(old)
  })

  it('marks recovered/deleted sources resolved while retaining their readable history', () => {
    const store = new NotificationStore(dir, events)
    store.reconcile([source])
    store.reconcile([])
    expect(store.list()[0].resolvedAt).toBeTruthy()
    events.publish.mockClear()
    store.reconcile([])
    expect(events.publish).not.toHaveBeenCalled()
  })

  it('persists read state, and treats repeat deletion/read as a no-op', () => {
    const store = new NotificationStore(dir, events)
    store.reconcile([source])
    const note = store.list()[0]
    new NotificationStore(dir, events).markRead(note.id)
    expect(store.list()[0]).toMatchObject({ title: 'checkout paused', body: 'Test run failed', readAt: expect.any(String) })
    events.publish.mockClear()
    store.markRead(note.id)
    store.markRead('missing')
    store.remove('missing')
    expect(events.publish).not.toHaveBeenCalled()
    store.remove(note.id)
    expect(store.list()).toEqual([])
  })

  it('fails visibly instead of resetting damaged state and forgetting permanent deletion', () => {
    const file = path.join(dir, 'notifications/state.json')
    fs.mkdirSync(path.dirname(file))
    fs.writeFileSync(file, '{broken')
    const store = new NotificationStore(dir, events)
    expect(() => store.reconcile([source])).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
    fs.writeFileSync(file, JSON.stringify({ version: 3 }))
    expect(() => store.list()).toThrow('Cannot read')
  })

  it('rejects manual creation, exposes read/delete routes, and emits updates after persistence', async () => {
    const app = Fastify()
    const store = new NotificationStore(dir, events)
    store.reconcile([source])
    await app.register(notificationRoutes, { store })
    try {
      expect((await app.inject({ method: 'POST', url: '/api/notifications', payload: { title: 'Follow up' } })).statusCode).toBe(404)
      const { id } = store.list()[0]
      expect((await app.inject({ method: 'POST', url: `/api/notifications/${id}/read` })).statusCode).toBe(204)
      expect((await app.inject('/api/notifications')).json()[0].readAt).toBeTruthy()
      expect((await app.inject({ method: 'DELETE', url: `/api/notifications/${id}` })).statusCode).toBe(204)
      expect((await app.inject('/api/notifications')).json()).toEqual([])
      expect(events.publish).toHaveBeenCalledWith({ type: 'notifications-changed' })
    } finally { await app.close() }
  })
})

it('records source transitions without a browser and detaches subscriptions on server close', async () => {
  const { register } = await import('./index')
  const runListeners = new Set<() => void>()
  const flightListeners = new Set<() => void>()
  let runs = [{ runId: 'r1', feature: 'shop', status: 'healing', pendingSpecEdits: 1 }]
  const app = Fastify()
  await register(app, {
    logsDir: dir, featuresDir: dir, workspaceEvents: events,
    dirtySpecStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
    runStore: { list: () => runs, get: () => null, onEvent: (fn: () => void) => runListeners.add(fn), offEvent: (fn: () => void) => runListeners.delete(fn) },
    flightStore: { list: () => [], onEvent: (fn: () => void) => flightListeners.add(fn), offEvent: (fn: () => void) => flightListeners.delete(fn) },
  } as unknown as import('../../server-context').ServerContext)
  try {
    expect((await app.inject('/api/notifications')).json()[0].target).toEqual({ kind: 'test-review', runId: 'r1', feature: 'shop' })
    runs = [{ ...runs[0], status: 'running', pendingSpecEdits: 0 }]
    for (const fn of runListeners) fn()
    expect((await app.inject('/api/notifications')).json()[0].resolvedAt).toBeTruthy()
  } finally { await app.close() }
  expect(runListeners.size).toBe(0)
  expect(flightListeners.size).toBe(0)
})

it('keeps one alert when a weakening moves from an active run back to its feature', async () => {
  const { register } = await import('./index')
  const runListeners = new Set<() => void>()
  let runs = [{ runId: 'r1', feature: 'shop', status: 'healing', pendingSpecEdits: 1 }]
  const changes = [{ featureId: 'shop', status: 'dirty' as const, dirtySpecs: [{ strength: { verdict: 'weaker' as const } }] }]
  const app = Fastify()
  await register(app, {
    logsDir: dir, featuresDir: dir, workspaceEvents: events,
    dirtySpecStore: { list: () => changes, onEvent: vi.fn(), offEvent: vi.fn() },
    runStore: { list: () => runs, get: () => null, onEvent: (fn: () => void) => runListeners.add(fn), offEvent: (fn: () => void) => runListeners.delete(fn) },
    flightStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
  } as unknown as import('../../server-context').ServerContext)
  try {
    const [active] = (await app.inject('/api/notifications')).json()
    expect(active.target).toEqual({ kind: 'test-review', feature: 'shop', runId: 'r1' })
    runs = [{ ...runs[0], status: 'passed' }]
    for (const fn of runListeners) fn()
    const after = (await app.inject('/api/notifications')).json()
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: active.id, severity: 'danger', toast: false, target: { kind: 'test-review', feature: 'shop' } })
    expect(after[0].resolvedAt).toBeUndefined()
  } finally { await app.close() }
})

it('resolves ordinary test changes when they no longer block an active run', async () => {
  const { register } = await import('./index')
  const runListeners = new Set<() => void>()
  let runs = [{ runId: 'r1', feature: 'shop', status: 'healing', pendingSpecEdits: 1 }]
  const changes = [{ featureId: 'shop', status: 'dirty' as const, dirtySpecs: [{ strength: { verdict: 'equivalent' as const } }] }]
  const app = Fastify()
  await register(app, {
    logsDir: dir, featuresDir: dir, workspaceEvents: events,
    dirtySpecStore: { list: () => changes, onEvent: vi.fn(), offEvent: vi.fn() },
    runStore: { list: () => runs, get: () => null, onEvent: (fn: () => void) => runListeners.add(fn), offEvent: (fn: () => void) => runListeners.delete(fn) },
    flightStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
  } as unknown as import('../../server-context').ServerContext)
  try {
    const [active] = (await app.inject('/api/notifications')).json()
    runs = [{ ...runs[0], status: 'passed' }]
    for (const fn of runListeners) fn()
    const after = (await app.inject('/api/notifications')).json()
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: active.id, resolvedAt: expect.any(String) })
  } finally { await app.close() }
})

it('persists test-change alerts from dirty-store events, preserves deletion, and resolves recovery', async () => {
  const { register } = await import('./index')
  const dirtyListeners = new Set<() => void>()
  let changes = [{ featureId: 'shop', status: 'dirty' as 'dirty' | 'clean', dirtySpecs: [{ strength: { verdict: 'weaker' } }] }]
  const app = Fastify()
  await register(app, {
    logsDir: dir, featuresDir: dir, workspaceEvents: events,
    runStore: { list: () => [], get: () => null, onEvent: vi.fn(), offEvent: vi.fn() },
    flightStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
    dirtySpecStore: { list: () => changes, onEvent: (fn: () => void) => dirtyListeners.add(fn), offEvent: (fn: () => void) => dirtyListeners.delete(fn) },
  } as unknown as import('../../server-context').ServerContext)
  try {
    const [initial] = (await app.inject('/api/notifications')).json()
    expect(initial).toMatchObject({ severity: 'danger', toast: false, target: { kind: 'test-review', feature: 'shop' } })
    await app.inject({ method: 'DELETE', url: `/api/notifications/${initial.id}` })
    for (const fn of dirtyListeners) fn()
    expect((await app.inject('/api/notifications')).json()).toEqual([])
    changes = [{ ...changes[0], status: 'clean' }]
    for (const fn of dirtyListeners) fn()
    changes = [{ ...changes[0], status: 'dirty' }]
    for (const fn of dirtyListeners) fn()
    const [next] = (await app.inject('/api/notifications')).json()
    expect(next.id).not.toBe(initial.id)
    changes = [{ ...changes[0], status: 'clean' }]
    for (const fn of dirtyListeners) fn()
    expect((await app.inject('/api/notifications')).json()[0].resolvedAt).toBeTruthy()
  } finally { await app.close() }
  expect(dirtyListeners.size).toBe(0)
})

it('persists terminal blockers before a start attempt and resolves exact approval with recovery for missed events', async () => {
  const { register } = await import('./index')
  const featuresDir = path.join(dir, 'features')
  const live = path.join(featuresDir, 'shop')
  const snapshot = path.join(dir, 'recorded-suite')
  for (const root of [live, snapshot]) {
    fs.mkdirSync(path.join(root, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(root, 'e2e', 'checkout.spec.ts'), "test('checkout', () => expect(1).toBe(1))")
  }
  fs.writeFileSync(path.join(live, 'e2e', 'checkout.spec.ts'), "test('checkout', () => expect(2).toBe(2))")
  // No pendingSpecEdits: abort won the race with the dirty-file watcher.
  const manifest = { runId: 'ended-run', feature: 'shop', status: 'aborted', featureDir: live, suiteSnapshot: { kind: 'taken', dir: snapshot } } as RunManifest
  const listeners = new Set<() => void>()
  const app = Fastify()
  await register(app, {
    logsDir: dir, featuresDir, workspaceEvents: events,
    dirtySpecStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
    runStore: { list: () => [{ runId: manifest.runId, feature: manifest.feature, status: manifest.status }], get: () => ({ manifest }), onEvent: (fn: () => void) => listeners.add(fn), offEvent: (fn: () => void) => listeners.delete(fn) },
    flightStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
  } as unknown as import('../../server-context').ServerContext)
  try {
    const [note] = (await app.inject('/api/notifications')).json()
    expect(note).toMatchObject({ severity: 'warning', toast: true, target: { kind: 'test-review', feature: 'shop', runId: 'ended-run' } })
    await app.inject({ method: 'POST', url: `/api/notifications/${note.id}/read` })
    expect((await app.inject('/api/notifications')).json()[0].resolvedAt).toBeUndefined()
    const revision = suiteReviewRevision(snapshot, live)
    manifest.specEdits = { checkedAt: 'now', pending: [], adopted: [], reviewDecisions: [{ revision, at: 'now', decision: 'approved-for-new-run', receipt: { decision: 'accepted', review_revision: revision, files: ['e2e/checkout.spec.ts'], at: 'now', git: { status: 'not-requested' }, execution: { status: 'new-run-required', runId: 'ended-run' } } }] }
    // No event: the already-open inbox's automatic read must reconcile truth.
    expect((await app.inject('/api/notifications')).json()).toEqual([expect.objectContaining({ id: note.id, resolvedAt: expect.any(String) })])
    fs.appendFileSync(path.join(live, 'e2e', 'checkout.spec.ts'), '\n// another revision')
    for (const fn of listeners) fn()
    const fresh = (await app.inject('/api/notifications')).json().find((item: { resolvedAt?: string }) => !item.resolvedAt)
    expect(fresh.id).not.toBe(note.id)
    fs.copyFileSync(path.join(snapshot, 'e2e', 'checkout.spec.ts'), path.join(live, 'e2e', 'checkout.spec.ts'))
    for (const fn of listeners) fn()
    expect((await app.inject('/api/notifications')).json().every((item: { resolvedAt?: string }) => !!item.resolvedAt)).toBe(true)
  } finally { await app.close() }
})

it.each(['snapshot', 'live'] as const)('keeps an unavailable %s review pending while a valid terminal blocker updates and resolves', async (missing) => {
  const { register } = await import('./index')
  const featuresDir = path.join(dir, 'features')
  const manifests = ['missing-suite', 'valid-suite'].map((feature) => {
    const live = path.join(featuresDir, feature)
    const snapshot = path.join(dir, `${feature}-snapshot`)
    for (const root of [live, snapshot]) {
      fs.mkdirSync(path.join(root, 'e2e'), { recursive: true })
      fs.writeFileSync(path.join(root, 'e2e', 'contract.spec.ts'), "test('contract', () => expect(1).toBe(1))")
    }
    fs.writeFileSync(path.join(live, 'e2e', 'contract.spec.ts'), "test('contract', () => expect(2).toBe(2))")
    return { runId: `${feature}-run`, feature, featureDir: live, status: 'aborted', suiteSnapshot: { kind: 'taken', dir: snapshot } } as RunManifest
  })
  const app = Fastify()
  await register(app, {
    logsDir: dir, featuresDir, workspaceEvents: events,
    // The unavailable suite also has a quiet source. It must not overwrite
    // the last confirmed review merely because its comparison cannot be read.
    dirtySpecStore: { list: () => [{ featureId: 'missing-suite', status: 'clean', dirtySpecs: [] }], onEvent: vi.fn(), offEvent: vi.fn() },
    runStore: {
      list: (options: { feature?: string } = {}) => manifests.filter((item) => !options.feature || item.feature === options.feature),
      get: (runId: string) => ({ manifest: manifests.find((item) => item.runId === runId) }),
      onEvent: vi.fn(), offEvent: vi.fn(),
    },
    flightStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
  } as unknown as import('../../server-context').ServerContext)
  try {
    const initial = (await app.inject('/api/notifications')).json()
    expect(initial).toHaveLength(2)
    const missingNote = initial.find((item: { target: { feature: string } }) => item.target.feature === 'missing-suite')
    const unavailableDir = missing === 'snapshot' ? path.join(dir, 'missing-suite-snapshot') : path.join(featuresDir, 'missing-suite')
    fs.rmSync(unavailableDir, { recursive: true })
    fs.writeFileSync(path.join(featuresDir, 'valid-suite', 'e2e', 'fixture.ts'), 'export const fixture = 1')
    const response = await app.inject('/api/notifications')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: missingNote.id, target: missingNote.target }),
      expect.objectContaining({ body: expect.stringContaining('2 test files changed'), target: { kind: 'test-review', feature: 'valid-suite', runId: 'valid-suite-run' } }),
    ]))
    expect(response.json().find((item: { id: string }) => item.id === missingNote.id).resolvedAt).toBeUndefined()
    fs.copyFileSync(path.join(dir, 'valid-suite-snapshot', 'e2e', 'contract.spec.ts'), path.join(featuresDir, 'valid-suite', 'e2e', 'contract.spec.ts'))
    fs.unlinkSync(path.join(featuresDir, 'valid-suite', 'e2e', 'fixture.ts'))
    const settled = (await app.inject('/api/notifications')).json()
    expect(settled.find((item: { target: { feature: string } }) => item.target.feature === 'valid-suite').resolvedAt).toBeTruthy()
    expect(settled.find((item: { id: string }) => item.id === missingNote.id).resolvedAt).toBeUndefined()
    await app.inject({ method: 'DELETE', url: `/api/notifications/${missingNote.id}` })
    expect((await app.inject('/api/notifications')).json().some((item: { id: string }) => item.id === missingNote.id)).toBe(false)
  } finally { await app.close() }
})
