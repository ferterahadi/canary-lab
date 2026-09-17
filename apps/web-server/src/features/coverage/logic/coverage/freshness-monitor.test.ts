import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoverageFreshnessMonitor } from './freshness-monitor'
import { WorkspaceEventBus } from '../../../../shared/workspace-events'
import { computeFeatureCoverage } from './service'
import { loadFeatures } from '../../../../shared/feature-loader'
import type { CoverageLedger } from '../../../../../../../shared/coverage/types'

vi.mock('./service', () => ({ computeFeatureCoverage: vi.fn() }))
vi.mock('../../../../shared/feature-loader', () => ({ loadFeatures: vi.fn() }))
let root: string
let bus: WorkspaceEventBus
let monitor: CoverageFreshnessMonitor
let warn: ReturnType<typeof vi.fn<(error: unknown) => void>>
let watchers: Map<string, EventEmitter>
const ledger = (revision = 'v1'): CoverageLedger => ({ feature: 'shop', coveragePct: 0, mappedPct: 0,
  totals: { covered: 0, total: 1, pathIncomplete: 0, variantIncomplete: 0, untested: 1, orphanTests: 0 }, tests: [], requirements: [], orphanRequirementIds: [], orphanTestNames: [],
  freshness: { revision, checkedAt: 'now', state: 'current', reasons: [], changedTests: [], latestRunFailed: false, proofNeedsRun: false },
})

beforeEach(() => {
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-watch-'))
  fs.mkdirSync(path.join(root, 'features'))
  fs.mkdirSync(path.join(root, 'logs'))
  fs.mkdirSync(path.join(root, 'features', 'shop', 'docs'), { recursive: true })
  bus = new WorkspaceEventBus(); warn = vi.fn(); watchers = new Map()
  vi.mocked(loadFeatures).mockReturnValue([{ name: 'shop', featureDir: path.join(root, 'features', 'shop') }] as never)
  vi.mocked(computeFeatureCoverage).mockReturnValue(ledger())
  vi.spyOn(fs, 'watch').mockImplementation(((dir: string, _options: unknown, listener: (...args: unknown[]) => void) => {
    const emitter = new EventEmitter()
    Object.assign(emitter, { close: vi.fn() })
    emitter.on('change', listener)
    watchers.set(dir, emitter)
    return emitter
  }) as unknown as typeof fs.watch)
  monitor = new CoverageFreshnessMonitor({ featuresDir: path.join(root, 'features'), logsDir: path.join(root, 'logs') }, bus, warn)
})
afterEach(() => { monitor.close(); vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }) })

describe('observer recovery and lifetime', () => {
  it('removes disappeared suites and coalesces repeated/concurrent scans', async () => {
    const events: unknown[] = []; bus.subscribe((event) => events.push(event))
    monitor.read('shop')
    fs.rmSync(path.join(root, 'features', 'shop'), { recursive: true })
    vi.mocked(loadFeatures).mockReturnValue([])
    await Promise.all([monitor.reconcile(), monitor.reconcile()])
    expect(monitor.list()).toEqual([])
    expect(events).toContainEqual({ type: 'coverage-changed', feature: 'shop' })
    monitor.close()
    await monitor.reconcile()
    monitor.schedule()
  })

  it('stops a scan between suites when the server closes', async () => {
    vi.mocked(loadFeatures).mockReturnValue([{ name: 'shop' }, { name: 'other' }] as never)
    const scanning = monitor.reconcile()
    monitor.close()
    await scanning
    expect(monitor.list()).toHaveLength(1)
  })

  it('recovers watcher failures and filters unrelated log/build noise', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    monitor.start()
    await monitor.reconcile()
    const featureWatch = watchers.get(path.join(root, 'features'))!
    const logWatch = watchers.get(path.join(root, 'logs'))!
    featureWatch.emit('change', 'change', 'node_modules/noise')
    logWatch.emit('change', 'change', 'output.log')
    featureWatch.emit('change', 'rename', null)
    logWatch.emit('change', 'change', 'runs/r1/e2e-summary.json')
    featureWatch.emit('error', new Error('watcher disconnected'))
    expect(warn).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(200)
    expect(watchers.get(path.join(root, 'features'))).not.toBe(featureWatch)
    // A real input change must still be recovered after watcher reattachment;
    // no-op signals alone no longer justify rebuilding a ledger.
    fs.writeFileSync(path.join(root, 'features', 'shop', 'docs', 'spec.md'), 'new input')
    vi.mocked(computeFeatureCoverage).mockReturnValue(ledger('v2'))
    bus.publish({ type: 'tests-changed', feature: 'shop' })
    bus.publish({ type: 'notifications-changed' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(monitor.list()[0].freshness.revision).toBe('v2')
    expect(computeFeatureCoverage).toHaveBeenCalledTimes(2)
  })

  it('keeps reconciling if a watcher cannot attach or a linked input is renamed', async () => {
    const dir = path.join(root, 'features', 'shop', 'docs')
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(path.join(root, 'gone.md'), path.join(dir, 'gone.md'))
    vi.mocked(fs.watch).mockImplementationOnce(() => { throw new Error('not supported') })
    vi.spyOn(fs, 'readlinkSync').mockImplementation(() => { throw new Error('renamed') })
    await monitor.reconcile()
    expect(warn).toHaveBeenCalledOnce()
    expect(monitor.list()[0].freshness.state).toBe('current')
  })

  it('turns non-Error read failures into unavailable state', () => {
    vi.mocked(computeFeatureCoverage).mockImplementationOnce(() => { throw 'unreadable' })
    expect(monitor.read('shop').freshness).toMatchObject({ state: 'unavailable', reasons: [expect.stringContaining('unreadable')] })
  })

  it('closes the wait registration race and settles an event only once', async () => {
    vi.mocked(computeFeatureCoverage).mockReturnValueOnce(ledger()).mockReturnValue(ledger('v2'))
    const read = monitor.read.bind(monitor)
    vi.spyOn(monitor, 'read').mockImplementationOnce((...args) => {
      const first = read(...args)
      fs.writeFileSync(path.join(root, 'features', 'shop', 'docs', 'spec.md'), 'changed between read and subscription')
      return first
    })
    expect(await monitor.wait('shop', 'v1', 1000)).toMatchObject({ changed: true, change: { freshness: { revision: 'v2' } } })
  })

  it('ignores another suite while waiting for the selected suite revision', async () => {
    const waiting = monitor.wait('shop', 'v1', 1000)
    monitor.observe({ ...ledger('other-v2'), feature: 'other' })
    monitor.observe(ledger('v2'))
    expect(await waiting).toMatchObject({ changed: true, change: { feature: 'shop' } })
  })
})
