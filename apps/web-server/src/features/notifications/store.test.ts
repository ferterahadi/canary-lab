import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationStore } from './store'
import { notificationRoutes } from './index'
import type { NotificationSource } from '../../../../../shared/notifications/types'

let dir: string
const events = { publish: vi.fn() }
const source: NotificationSource = { key: 'flight:f1', signature: 'failed:run', message: { title: 'checkout paused', body: 'Test run failed', target: { kind: 'flight', flightId: 'f1' } } }
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifications-')); events.publish.mockClear() })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('durable notifications', () => {
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
