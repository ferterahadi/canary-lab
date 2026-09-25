import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { register, NOTIFICATION_RECOVERY_MS } from './index'
import { NotificationStore } from './store'
import { DirtySpecStore } from '../runs/logic/dirty-specs/store'
import { WorkspaceEventBus } from '../../shared/workspace-events'
import type { RunManifest } from '../runs/logic/runtime/manifest'
import type { ServerContext } from '../../server-context'
import type { WorkspaceNotification } from '../../../../../shared/notifications/types'

let dir: string
let app: FastifyInstance
let dirty: DirtySpecStore
let spec: string
let recovery: () => void
let runManifest: RunManifest | undefined
let events: WorkspaceEventBus
const original = "test('checkout', () => { expect(1).toBe(1); expect(2).toBe(2) })"
const weakened = "test('checkout', () => { expect(1).toBe(1) })"
const persisted = (): WorkspaceNotification[] => JSON.parse(fs.readFileSync(path.join(dir, 'logs/notifications/state.json'), 'utf8')).items

beforeEach(async () => {
  runManifest = undefined
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-recovery-'))
  const featuresDir = path.join(dir, 'features')
  const configDir = path.join(featuresDir, 'shop')
  // The configured suite lives outside the feature discovery folder. Recovery
  // must inspect this actual source, not features/shop/e2e.
  const liveDir = path.join(dir, 'linked-suite')
  const snapshot = path.join(dir, 'snapshot')
  for (const root of [configDir, liveDir, snapshot]) fs.mkdirSync(path.join(root, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(configDir, 'feature.config.cjs'), `exports.config = { name: 'shop', featureDir: ${JSON.stringify(liveDir)}, repos: [] }`)
  spec = path.join(liveDir, 'e2e/checkout.spec.ts')
  fs.writeFileSync(spec, original)
  fs.writeFileSync(path.join(snapshot, 'e2e/checkout.spec.ts'), original)
  dirty = new DirtySpecStore(path.join(dir, 'logs'))
  await dirty.captureRunStart('shop', snapshot)
  fs.writeFileSync(spec, weakened)
  await dirty.recompute('shop', liveDir)
  events = new WorkspaceEventBus()
  const realInterval = globalThis.setInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
    if (ms === NOTIFICATION_RECOVERY_MS) recovery = callback
    return realInterval(callback, ms)
  }) as typeof setInterval)
  const initialRefresh = vi.spyOn(dirty, 'recompute')
  app = Fastify()
  const empty = { list: () => [], get: () => null, onEvent: vi.fn(), offEvent: vi.fn() }
  await register(app, { logsDir: path.join(dir, 'logs'), featuresDir, workspaceEvents: events,
    dirtySpecStore: dirty, flightStore: empty, runStore: { ...empty, list: () => runManifest ? [{ runId: runManifest.runId, feature: runManifest.feature, status: runManifest.status, pendingSpecEdits: 1 }] : [], get: () => runManifest ? { manifest: runManifest } : null } } as unknown as ServerContext)
  await app.ready()
  await initialRefresh.mock.results[0].value
  await new Promise<void>((resolve) => setImmediate(resolve))
  initialRefresh.mockRestore()
  await vi.waitFor(() => expect(persisted()[0]?.title).toBe('shop: possible test weakening'))
})

afterEach(async () => {
  await app.close()
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

it('repairs a missed direct-file event without a browser request and publishes the settlement', async () => {
  const id = persisted()[0].id
  const observed: string[] = []
  const unsubscribe = events.subscribe((event) => observed.push(event.type))
  fs.writeFileSync(spec, original)
  // There is deliberately no filesystem watcher in this fixture.
  recovery()
  await vi.waitFor(() => expect(persisted()[0]).toMatchObject({ id, resolvedAt: expect.any(String) }))
  expect(observed).toContain('notifications-changed')
  unsubscribe()
})

it('refreshes the clicked suite and returns its settled action before the next timer', async () => {
  const id = persisted()[0].id
  fs.writeFileSync(spec, original)
  const result = await app.inject({ method: 'POST', url: `/api/notifications/${id}/resolve-action` })
  expect(result.statusCode).toBe(200)
  expect(result.json()).toMatchObject({ target: { kind: 'feature', feature: 'shop' }, items: [expect.objectContaining({ id, resolvedAt: expect.any(String) })] })
})

it('preserves an unverifiable issue, blocks its stale action, and automatically recovers', async () => {
  const id = persisted()[0].id
  const recompute = vi.spyOn(dirty, 'recompute').mockRejectedValue(new Error('source unreadable'))
  const result = await app.inject({ method: 'POST', url: `/api/notifications/${id}/resolve-action` })
  expect(result.statusCode).toBe(200)
  expect(result.json()).toMatchObject({ status: 'unavailable', items: [expect.objectContaining({ unavailable: true })] })
  expect(persisted()[0]).toMatchObject({ id, unavailable: true })
  expect(persisted()[0].resolvedAt).toBeUndefined()
  expect((await app.inject('/api/notifications/feature/shop')).json().items).toEqual([expect.objectContaining({ state: 'unavailable' })])
  recompute.mockRestore()
  fs.writeFileSync(spec, original)
  recovery()
  await vi.waitFor(() => expect(persisted()[0].resolvedAt).toEqual(expect.any(String)))
  expect(persisted()[0].unavailable).toBeUndefined()
})

it('keeps one recovery in flight when another refresh event arrives', async () => {
  const record = dirty.get('shop')!
  let release: () => void = () => {}
  const pending = new Promise<typeof record>((resolve) => { release = () => resolve(record) })
  const recompute = vi.spyOn(dirty, 'recompute').mockImplementationOnce(() => pending)

  recovery()
  recovery()
  await vi.waitFor(() => expect(recompute).toHaveBeenCalledTimes(1))
  release()
  await vi.waitFor(() => expect(recompute.mock.results[0]?.value).toBe(pending))
})

it('stops refreshing additional suites once the server begins closing', async () => {
  const discovery = path.join(dir, 'features', 'second')
  const linked = path.join(dir, 'second-suite')
  fs.mkdirSync(discovery, { recursive: true })
  fs.mkdirSync(linked)
  fs.writeFileSync(path.join(discovery, 'feature.config.cjs'), `exports.config = { name: 'second', featureDir: ${JSON.stringify(linked)}, repos: [] }`)
  const record = dirty.get('shop')!
  let release: () => void = () => {}
  const pending = new Promise<typeof record>((resolve) => { release = () => resolve(record) })
  const recompute = vi.spyOn(dirty, 'recompute').mockImplementationOnce(() => pending)

  recovery()
  await vi.waitFor(() => expect(recompute).toHaveBeenCalledTimes(1))
  const closing = app.close()
  await new Promise<void>((resolve) => setImmediate(resolve))
  release()
  await closing

  expect(recompute).toHaveBeenCalledTimes(1)
})

it('marks a periodic recompute failure unavailable and clears it when the suite disappears', async () => {
  const warning = vi.spyOn(app.log, 'warn')
  const recompute = vi.spyOn(dirty, 'recompute').mockRejectedValueOnce(new Error('suite unreadable'))
  recovery()
  await vi.waitFor(() => expect(warning).toHaveBeenCalledWith({ err: expect.any(Error), feature: 'shop' }, 'Could not refresh test integrity for notifications'))
  await vi.waitFor(() => expect(persisted()[0].unavailable).toBe(true))
  recompute.mockRestore()

  fs.rmSync(path.join(dir, 'features', 'shop'), { recursive: true })
  recovery()
  await vi.waitFor(() => expect(persisted()[0].resolvedAt).toEqual(expect.any(String)))
})

it('reports a vanished suite config when resolving a saved review action', async () => {
  const id = persisted()[0].id
  fs.rmSync(path.join(dir, 'features', 'shop', 'feature.config.cjs'))
  const warning = vi.spyOn(app.log, 'warn')

  await app.inject({ method: 'POST', url: `/api/notifications/${id}/resolve-action` })

  expect(warning).toHaveBeenCalledWith({ err: expect.objectContaining({ message: 'Suite configuration is unavailable' }), feature: 'shop' }, 'Could not refresh notification action')
})

it.each([new Error('feature scan failed'), 'feature scan failed'])('keeps the inbox unavailable when discovery throws %s', async (failure) => {
  const logged = vi.spyOn(app.log, 'error')
  vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => { throw failure })

  recovery()

  await vi.waitFor(() => expect(logged).toHaveBeenCalledWith({ err: expect.objectContaining({ message: 'feature scan failed' }) }, 'Could not update notifications'))
})

it('skips a discovered config without a live suite directory', async () => {
  const config = path.join(dir, 'features', 'shop', 'feature.config.cjs')
  fs.writeFileSync(config, "exports.config = { name: 'shop', repos: [] }\n")
  const recompute = vi.spyOn(dirty, 'recompute')

  recovery()

  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(recompute).not.toHaveBeenCalled()
})

it('reports a failed notification recovery without leaking its rejection', async () => {
  vi.spyOn(NotificationStore.prototype, 'reconcile').mockImplementationOnce(() => { throw new Error('store unavailable') })
  const logged = vi.spyOn(app.log, 'error').mockImplementationOnce(() => { throw new Error('log sink unavailable') })

  recovery()

  await vi.waitFor(() => expect(logged).toHaveBeenCalledWith({ err: expect.objectContaining({ message: 'log sink unavailable' }) }, 'Could not recover notifications'))
})

it('logs a failed suite retirement and refreshes when a feature is created', async () => {
  const logged = vi.spyOn(app.log, 'error')
  vi.spyOn(NotificationStore.prototype, 'retire').mockImplementationOnce(() => { throw new Error('retirement unavailable') })

  events.publish({ type: 'feature-deleted', feature: 'shop' })
  expect(logged).toHaveBeenCalledWith({ err: expect.objectContaining({ message: 'retirement unavailable' }) }, 'Could not retire test-review notification')

  const recompute = vi.spyOn(dirty, 'recompute')
  events.publish({ type: 'feature-created', feature: 'shop' })
  await vi.waitFor(() => expect(recompute).toHaveBeenCalled())
})

it('settles a removed linked suite without a browser request, then creates a fresh episode after restoration', async () => {
  const id = persisted()[0].id
  const live = path.dirname(path.dirname(spec))
  fs.rmSync(live, { recursive: true })
  recovery()
  await vi.waitFor(() => expect(persisted()[0]).toMatchObject({ id, resolvedAt: expect.any(String) }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect((await app.inject('/api/notifications/feature/shop')).json().items[0].state).toBe('resolved')
  fs.mkdirSync(path.dirname(spec), { recursive: true })
  fs.writeFileSync(spec, weakened)
  events.publish({ type: 'tests-changed', feature: 'shop' })
  await vi.waitFor(() => {
    const current = persisted().find((item) => !item.resolvedAt)
    expect(current?.id).not.toBe(id)
    expect(current?.title).toBe('shop: possible test weakening')
  })
})


it('keeps a real linked-suite review actionable when only its discovery folder and saved snapshot contain configuration', async () => {
  const snapshot = path.join(dir, 'snapshot')
  fs.writeFileSync(path.join(snapshot, 'feature.config.cjs'), 'exports.config = { name: "shop" }')
  runManifest = { runId: 'linked-run', feature: 'shop', status: 'aborted', featureDir: path.dirname(path.dirname(spec)),
    suiteSnapshot: { kind: 'taken', dir: snapshot }, specEdits: { checkedAt: 'then', pending: [{ file: 'e2e/checkout.spec.ts', change: 'modified' }], adopted: [] } } as RunManifest
  const id = persisted()[0].id
  const rows = (await app.inject('/api/notifications')).json() as WorkspaceNotification[]
  expect(rows).toEqual([expect.objectContaining({ id, target: { kind: 'test-review', feature: 'shop', runId: 'linked-run' } })])
  expect(rows[0].resolvedAt).toBeUndefined()
  expect(fs.existsSync(path.join(runManifest.featureDir!, 'feature.config.cjs'))).toBe(false)
})
