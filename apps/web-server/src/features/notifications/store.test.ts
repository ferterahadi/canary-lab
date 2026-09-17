import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationStore } from './store'
import { notificationRoutes } from './index'
import type { NotificationSource } from '../../../../../shared/notifications/types'
import type { FeatureCoverageChange } from '../../../../../shared/coverage/freshness'

let dir: string
const events = { publish: vi.fn() }
const source: NotificationSource = { key: 'flight:f1', signature: 'failed:run', message: { title: 'checkout paused', body: 'Test run failed', target: { kind: 'flight', flightId: 'f1' } } }
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifications-')); events.publish.mockClear() })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

it('creates and resolves test-change and coverage topics independently through their owning events', async () => {
  const { register } = await import('./index')
  const dirtyListeners = new Set<() => void>()
  let onWorkspaceEvent!: (event: { type: string }) => void
  let dirty = true
  const coverage: FeatureCoverageChange = {
    feature: 'shop', delivery: 'tool-response-and-wait',
    freshness: { revision: 'v1', checkedAt: 'now', state: 'stale', reasons: ['Mapping inputs changed.'], changedTests: ['checkout'], latestRunFailed: false, proofNeedsRun: false },
  }
  const app = Fastify()
  await register(app, {
    logsDir: dir, workspaceEvents: { ...events, subscribe: (fn: typeof onWorkspaceEvent) => { onWorkspaceEvent = fn; return vi.fn() } },
    coverageMonitor: { reconcile: vi.fn(), list: () => [coverage] },
    dirtySpecStore: {
      list: () => [{ featureId: 'shop', status: dirty ? 'dirty' : 'clean', dirtySpecs: dirty ? [{}] : [] }],
      onEvent: (fn: () => void) => dirtyListeners.add(fn), offEvent: (fn: () => void) => dirtyListeners.delete(fn),
    },
    runStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
    flightStore: { list: () => [], latestForFeature: () => ({ flightId: 'f1' }), onEvent: vi.fn(), offEvent: vi.fn() },
  } as unknown as import('../../server-context').ServerContext)
  try {
    const initial = (await app.inject('/api/notifications')).json()
    expect(initial).toHaveLength(2)
    const review = initial.find((item: { target: { kind: string } }) => item.target.kind === 'test-review')
    const mapping = initial.find((item: { target: { kind: string } }) => item.target.kind === 'coverage')
    expect(review.title).toBe('shop: tests changed')
    expect(mapping.target).toEqual({ kind: 'coverage', feature: 'shop', flightId: 'f1', stage: 'specs-coverage' })
    events.publish.mockClear()
    for (const fn of dirtyListeners) fn()
    onWorkspaceEvent({ type: 'coverage-changed' })
    expect(events.publish).not.toHaveBeenCalled()

    coverage.freshness.state = 'current'
    onWorkspaceEvent({ type: 'coverage-changed' })
    let current = (await app.inject('/api/notifications')).json()
    expect(current.find((item: { id: string }) => item.id === mapping.id).resolvedAt).toBeTruthy()
    expect(current.find((item: { id: string }) => item.id === review.id).resolvedAt).toBeUndefined()
    expect(events.publish).toHaveBeenCalledWith({ type: 'notifications-changed' })

    coverage.freshness.state = 'stale'
    onWorkspaceEvent({ type: 'coverage-changed' })
    dirty = false
    for (const fn of dirtyListeners) fn()
    current = (await app.inject('/api/notifications')).json()
    expect(current.find((item: { id: string }) => item.id === review.id).resolvedAt).toBeTruthy()
    expect(current.filter((item: { resolvedAt?: string }) => !item.resolvedAt)).toEqual([
      expect.objectContaining({ target: { kind: 'coverage', feature: 'shop', flightId: 'f1', stage: 'specs-coverage' } }),
    ])
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
    logsDir: dir, workspaceEvents: events,
    dirtySpecStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
    runStore: { list: () => runs, onEvent: (fn: () => void) => runListeners.add(fn), offEvent: (fn: () => void) => runListeners.delete(fn) },
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
    logsDir: dir, workspaceEvents: events,
    dirtySpecStore: { list: () => changes, onEvent: vi.fn(), offEvent: vi.fn() },
    runStore: { list: () => runs, onEvent: (fn: () => void) => runListeners.add(fn), offEvent: (fn: () => void) => runListeners.delete(fn) },
    flightStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
  } as unknown as import('../../server-context').ServerContext)
  try {
    const [active] = (await app.inject('/api/notifications')).json()
    expect(active.target).toEqual({ kind: 'test-review', feature: 'shop', runId: 'r1' })
    runs = [{ ...runs[0], status: 'passed' }]
    for (const fn of runListeners) fn()
    const after = (await app.inject('/api/notifications')).json()
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: active.id, severity: 'danger', target: { kind: 'test-review', feature: 'shop' } })
    expect(after[0].resolvedAt).toBeUndefined()
  } finally { await app.close() }
})

it('keeps ordinary test changes actionable after the active run ends', async () => {
  const { register } = await import('./index')
  const runListeners = new Set<() => void>()
  let runs = [{ runId: 'r1', feature: 'shop', status: 'healing', pendingSpecEdits: 1 }]
  const changes = [{ featureId: 'shop', status: 'dirty' as const, dirtySpecs: [{ strength: { verdict: 'equivalent' as const } }] }]
  const app = Fastify()
  await register(app, {
    logsDir: dir, workspaceEvents: events,
    dirtySpecStore: { list: () => changes, onEvent: vi.fn(), offEvent: vi.fn() },
    runStore: { list: () => runs, onEvent: (fn: () => void) => runListeners.add(fn), offEvent: (fn: () => void) => runListeners.delete(fn) },
    flightStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
  } as unknown as import('../../server-context').ServerContext)
  try {
    const [active] = (await app.inject('/api/notifications')).json()
    runs = [{ ...runs[0], status: 'passed' }]
    for (const fn of runListeners) fn()
    const after = (await app.inject('/api/notifications')).json()
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: active.id, target: { kind: 'test-review', feature: 'shop' } })
    expect(after[0].resolvedAt).toBeUndefined()
  } finally { await app.close() }
})

it('persists test-change alerts from dirty-store events, preserves deletion, and resolves recovery', async () => {
  const { register } = await import('./index')
  const dirtyListeners = new Set<() => void>()
  let changes = [{ featureId: 'shop', status: 'dirty' as 'dirty' | 'clean', dirtySpecs: [{ strength: { verdict: 'weaker' } }] }]
  const app = Fastify()
  await register(app, {
    logsDir: dir, workspaceEvents: events,
    runStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
    flightStore: { list: () => [], onEvent: vi.fn(), offEvent: vi.fn() },
    dirtySpecStore: { list: () => changes, onEvent: (fn: () => void) => dirtyListeners.add(fn), offEvent: (fn: () => void) => dirtyListeners.delete(fn) },
  } as unknown as import('../../server-context').ServerContext)
  try {
    const [initial] = (await app.inject('/api/notifications')).json()
    expect(initial).toMatchObject({ severity: 'danger', target: { kind: 'test-review', feature: 'shop' } })
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
