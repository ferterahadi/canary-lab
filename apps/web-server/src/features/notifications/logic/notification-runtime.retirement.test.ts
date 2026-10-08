import fs from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { createNotificationRuntime } from './notification-runtime'
import * as retirement from '../retired-suite'
import { RunStore } from '../../runs/logic/run-store'
import { createRegistry } from '../../runs/logic/run-registry'
import { DirtySpecStore } from '../../runs/logic/dirty-specs/store'
import { FlightRunStore } from '../../flights/logic/store'
import { WorkspaceEventBus } from '../../../shared/workspace-events'
import { runManifest } from '../../runs/logic/__fixtures__/run-manifest'
import * as review from '../../runs/logic/runtime/run-review-gate'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('notification-scoped-')

let runtime: ReturnType<typeof createNotificationRuntime> | undefined
afterEach(async () => {
  await runtime?.dispose()
  vi.restoreAllMocks()
})
function fixture() {
  const root = tempDir()
  const featuresDir = path.join(root, 'features')
  const logsDir = path.join(root, 'logs')
  fs.mkdirSync(featuresDir)
  const runs = new RunStore(logsDir, createRegistry())
  const dirty = new DirtySpecStore(logsDir)
  const events = new WorkspaceEventBus()
  const flights = new FlightRunStore(logsDir)
  runtime = createNotificationRuntime({ featuresDir, logsDir, runStore: runs, dirtySpecStore: dirty,
    flightStore: flights, workspaceEvents: events, log: { warn: vi.fn(), error: vi.fn() } })
  const suite = (name: string) => {
    const dir = path.join(featuresDir, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'feature.config.cjs'), `exports.config = { name: ${JSON.stringify(name)}, featureDir: __dirname }`)
    runs.bootstrap(runManifest({ runId: `${name}-run`, feature: name, status: 'passed' }))
    return dir
  }
  return { root, featuresDir, runs, dirty, events, flights, suite, runtime }
}

it('projects only the affected run suite and never checks historical Git on events or inbox reads', async () => {
  const f = fixture()
  f.suite('one'); f.suite('two')
  f.runs.bootstrap(runManifest({ runId: 'historical', feature: 'removed', status: 'passed' }))
  const git = vi.spyOn(retirement, 'isCommittedSuiteRetirement').mockResolvedValue(false)
  f.runtime.start()
  await f.runtime.refresh()
  git.mockClear()
  const pending = vi.spyOn(review, 'pendingRunReview')
  f.runs.patchManifest('one-run', { status: 'failed' })
  expect(pending.mock.calls.map((call) => call[1])).toEqual(['one'])
  pending.mockClear()
  f.runs.emit('event', { kind: 'journal-changed', runId: 'one-run' })
  expect(pending).not.toHaveBeenCalled()
  f.runtime.reconcile()
  expect(git).not.toHaveBeenCalled()
})

it('bounds retirement concurrency and discards a positive result after the suite is restored', async () => {
  const f = fixture()
  for (const name of ['old-one', 'old-two']) {
    f.runtime.store.reconcile([{ key: `test-review:${name}`, signature: 'quiet' }], new Set(), new Set([`test-review:${name}`]))
  }
  let release!: (retired: boolean) => void
  const git = vi.spyOn(retirement, 'isCommittedSuiteRetirement').mockImplementationOnce(() => new Promise((resolve) => { release = resolve })).mockResolvedValue(false)
  f.runtime.start()
  const audit = f.runtime.refresh()
  await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(1))
  // The audit is waiting on an external process; synchronous source projections
  // and the event loop still run. Neither an inbox read nor a run queues more Git.
  f.suite('old-one')
  f.events.publish({ type: 'feature-created', feature: 'old-one' })
  f.runtime.reconcile()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(git).toHaveBeenCalledTimes(1)
  release(true)
  await audit
  expect(git).toHaveBeenCalledTimes(2)
  expect(f.runtime.store.isRetired('old-one')).toBe(false)
})

it('records positive retirement evidence, retries negative checks on a later audit, and stops the queue on shutdown', async () => {
  const f = fixture()
  for (const name of ['deleted', 'missing']) f.runtime.store.reconcile([{ key: `test-review:${name}`, signature: 'quiet' }], new Set(), new Set([`test-review:${name}`]))
  const git = vi.spyOn(retirement, 'isCommittedSuiteRetirement').mockImplementation(async (_dir, feature) => feature === 'deleted')
  f.runtime.start()
  await f.runtime.refresh()
  expect(f.runtime.store.isRetired('deleted')).toBe(true)
  expect(f.runtime.store.isRetired('missing')).toBe(false)
  git.mockClear()
  await f.runtime.refresh()
  expect(git).toHaveBeenCalledExactlyOnceWith(f.featuresDir, 'missing')

  let release!: () => void
  git.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(true) }))
  f.runtime.store.reconcile([{ key: 'test-review:also-missing', signature: 'quiet' }], new Set(), new Set(['test-review:also-missing']))
  const audit = f.runtime.refresh()
  await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(2))
  const closing = f.runtime.dispose()
  release()
  await Promise.all([audit, closing])
  expect(f.runtime.store.isRetired('missing')).toBe(false)
})

it('continues the audit after a failed retirement write without claiming retirement', async () => {
  const f = fixture()
  f.runs.bootstrap(runManifest({ runId: 'old', feature: 'gone', status: 'passed' }))
  vi.spyOn(retirement, 'isCommittedSuiteRetirement').mockResolvedValue(true)
  vi.spyOn(f.runtime.store, 'retire').mockImplementationOnce(() => { throw new Error('disk unavailable') })
  await f.runtime.refresh()
  expect(f.runtime.store.isRetired('gone')).toBe(false)
  await f.runtime.refresh()
  expect(f.runtime.store.isRetired('gone')).toBe(true)
})

it('ignores a late Git result when a broad workspace change invalidates its revision', async () => {
  const f = fixture()
  f.runs.bootstrap(runManifest({ runId: 'old', feature: 'gone', status: 'passed' }))
  let release!: () => void
  const git = vi.spyOn(retirement, 'isCommittedSuiteRetirement').mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(true) }))
  f.runtime.start()
  const pending = f.runtime.refresh()
  await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(1))
  f.events.publish({ type: 'features-changed' })
  release()
  await pending
  expect(f.runtime.store.isRetired('gone')).toBe(false)
})

it('does no projection work after disposal', async () => {
  const f = fixture()
  const dir = f.suite('one')
  f.runtime.store.reconcile([{ key: 'test-review:one', signature: 'attention', message: { title: 'one', body: '', target: { kind: 'test-review', feature: 'one' } } }])
  const id = f.runtime.store.list()[0].id
  await f.runtime.dispose()
  const recompute = vi.spyOn(f.dirty, 'recompute')
  const reconcile = vi.spyOn(f.runtime.store, 'reconcile')
  await f.runtime.refreshAction(id)
  f.runtime.reconcile()
  expect(recompute).not.toHaveBeenCalled()
  expect(reconcile).not.toHaveBeenCalled()
  expect(fs.existsSync(dir)).toBe(true)
})

it('preserves the inbox when the historical inventory cannot be read', async () => {
  const f = fixture()
  f.runtime.store.reconcile([{ key: 'test-review:one', signature: 'attention', message: { title: 'one', body: '' } }])
  vi.spyOn(f.runs, 'list').mockImplementation(() => { throw new Error('inventory unreadable') })
  await f.runtime.refresh()
  expect(f.runtime.store.list()[0]).toMatchObject({ title: 'one', unavailable: true })
  expect(f.runtime.store.list()[0].resolvedAt).toBeUndefined()
})
