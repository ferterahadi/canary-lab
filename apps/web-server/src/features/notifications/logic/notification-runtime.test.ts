import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNotificationRuntime, NOTIFICATION_RECOVERY_MS } from './notification-runtime'
import { RunStore, createRegistry } from '../../runs/logic/run-store'
import { DirtySpecStore } from '../../runs/logic/dirty-specs/store'
import { FlightRunStore } from '../../flights/logic/store'
import { FLIGHT_STAGE_KEYS, type FlightManifest } from '../../flights/logic/types'
import { WorkspaceEventBus, type WorkspaceEvent } from '../../../shared/workspace-events'

let dir: string
let runtime: ReturnType<typeof createNotificationRuntime>
let events: WorkspaceEventBus
let runs: RunStore
let dirty: DirtySpecStore
let flights: FlightRunStore
let flight: FlightManifest
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notification-runtime-')))
  const featuresDir = path.join(dir, 'features')
  fs.mkdirSync(featuresDir)
  const logsDir = path.join(dir, 'logs')
  events = new WorkspaceEventBus()
  runs = new RunStore(logsDir, createRegistry())
  dirty = new DirtySpecStore(logsDir)
  flights = new FlightRunStore(logsDir)
  flight = {
    flightId: 'f1', feature: 'shop', repoPaths: [], description: 'fixture',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'paused', pauseReason: 'stage-failed', currentStage: 'run',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' })),
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }
  flights.save(flight)
  runtime = createNotificationRuntime({ logsDir, featuresDir, runStore: runs, dirtySpecStore: dirty,
    flightStore: flights, workspaceEvents: events, log: { warn: vi.fn(), error: vi.fn() } })
})

afterEach(async () => {
  await runtime.dispose()
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

it('starts reconciliation explicitly and settles the inbox from a Flight store event without a read request', async () => {
  expect(runtime.store.list()).toEqual([])
  runtime.start()
  const [active] = runtime.store.list()
  expect(active.target).toEqual({ kind: 'flight', flightId: 'f1' })
  expect(active.resolvedAt).toBeUndefined()
  await flush()
  const publish = vi.spyOn(events, 'publish')
  flights.save({ ...flight, status: 'done', pauseReason: undefined })
  expect(runtime.store.list()).toEqual([expect.objectContaining({ id: active.id, resolvedAt: expect.any(String) })])
  expect(publish).toHaveBeenCalledWith({ type: 'notifications-changed' })
})

it('reconciles run and dirty-store events but ignores its own workspace events', async () => {
  runtime.start()
  await flush()
  const reconcile = vi.spyOn(runtime.store, 'reconcile')
  runs.emit('event', { kind: 'index-changed' })
  expect(reconcile).toHaveBeenCalledTimes(1)
  await dirty.recompute('shop', path.join(dir, 'features'))
  expect(reconcile.mock.calls.length).toBeGreaterThan(1)
  reconcile.mockClear()
  for (const type of ['notifications-changed', 'coverage-changed', 'tests-dirty-changed'] as const) {
    events.publish({ type, feature: 'shop' })
  }
  await flush()
  expect(reconcile).not.toHaveBeenCalled()
})

it.each<WorkspaceEvent>([
  { type: 'tests-changed', feature: 'shop' },
  { type: 'feature-created', feature: 'shop' },
  { type: 'feature-renamed', from: 'old', to: 'shop' },
  { type: 'features-changed' },
])('rediscovers suites after $type', async (event) => {
  runtime.start()
  await flush()
  const suite = path.join(dir, 'features', 'shop')
  fs.mkdirSync(suite)
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'), "exports.config = { name: 'shop', featureDir: __dirname }")
  const recompute = vi.spyOn(dirty, 'recompute')
  events.publish(event)
  await expect.poll(() => dirty.get('shop')).not.toBeNull()
  expect(recompute).toHaveBeenCalledExactlyOnceWith('shop', suite)
})

it('clears the recovery timer and detaches every subscription on disposal', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval')
  const clear = vi.spyOn(globalThis, 'clearInterval')
  const offRun = vi.spyOn(runs, 'offEvent')
  const offFlight = vi.spyOn(flights, 'offEvent')
  const offDirty = vi.spyOn(dirty, 'offEvent')
  runtime.start()
  await flush()
  expect(interval).toHaveBeenCalledWith(expect.any(Function), NOTIFICATION_RECOVERY_MS)
  await runtime.dispose()
  expect(clear).toHaveBeenCalledWith(interval.mock.results[0].value)
  for (const off of [offRun, offFlight, offDirty]) expect(off).toHaveBeenCalledTimes(1)
  const reconcile = vi.spyOn(runtime.store, 'reconcile')
  events.publish({ type: 'feature-deleted', feature: 'shop' })
  events.publish({ type: 'features-changed' })
  runs.emit('event', { kind: 'index-changed' })
  flights.save({ ...flight, status: 'done' })
  await dirty.recompute('shop', path.join(dir, 'features'))
  await flush()
  expect(reconcile).not.toHaveBeenCalled()
  expect(runtime.store.isRetired('shop')).toBe(false)
  expect(runtime.store.list()[0].resolvedAt).toBeUndefined()
})
