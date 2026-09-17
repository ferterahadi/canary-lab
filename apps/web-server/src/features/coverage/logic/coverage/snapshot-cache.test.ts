import fs from 'fs'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import * as service from './service'
import { freshnessWorkspace } from './__fixtures__/freshness-workspace'
import { fakePropose } from './__fixtures__/fake-coverage-agents'
import { CoverageFreshnessMonitor } from './freshness-monitor'
import { CoverageSnapshotCache } from './snapshot-cache'
import { CoverageJobRunStore } from './jobs/store'
import { WorkspaceEventBus } from '../../../../shared/workspace-events'
import { coverageRoutes } from '../../routes/coverage'
import * as featureLoader from '../../../../shared/feature-loader'

let fixture: Awaited<ReturnType<typeof freshnessWorkspace>>
let monitor: CoverageFreshnessMonitor
let compute: MockInstance<typeof service.computeFeatureCoverage>
const computeFeatureCoverage = service.computeFeatureCoverage

beforeEach(async () => {
  fixture = await freshnessWorkspace()
  const other = path.join(fixture.args.featuresDir, 'other')
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, 'feature.config.cjs'), "module.exports = { config: { name: 'other', featureDir: __dirname } }")
  monitor = new CoverageFreshnessMonitor(fixture.args, new WorkspaceEventBus(), () => {})
  compute = vi.spyOn(service, 'computeFeatureCoverage')
})
afterEach(() => { monitor.close(); vi.restoreAllMocks(); fixture.cleanup() })

describe('shared coverage snapshots', () => {
  it('shares calculation across REST ledgers, badges, observer scans and agent waits', async () => {
    const app = Fastify()
    await app.register(coverageRoutes, { ...fixture.args, projectRoot: fixture.root, coverageMonitor: monitor })
    try {
      await monitor.reconcile()
      expect(compute).toHaveBeenCalledTimes(2)
      compute.mockClear()
      const replies = await Promise.all([
        app.inject('/api/features/shop/coverage'), app.inject('/api/features/shop/coverage'),
        app.inject('/api/coverage/states'), app.inject('/api/features/shop/coverage/changes'),
      ])
      expect(replies.every((reply) => reply.statusCode === 200)).toBe(true)
      expect(replies[0].json()).toMatchObject({ coveragePct: 100, freshness: { state: 'current' } })
      expect(replies[2].json()).toContainEqual(expect.objectContaining({ feature: 'shop', coveragePct: 100 }))
      expect(replies[3].json().change.freshness.revision).toBe(replies[0].json().freshness.revision)
      await monitor.reconcile()
      expect(compute).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('rebuilds only the changed suite, even for equal-size edits with restored mtimes', async () => {
    await monitor.reconcile()
    compute.mockClear()
    const before = fs.statSync(fixture.doc)
    fs.writeFileSync(fixture.doc, fs.readFileSync(fixture.doc, 'utf8').replace('buyer', 'owner'))
    fs.utimesSync(fixture.doc, before.atime, before.mtime)
    await monitor.reconcile()
    expect(compute).toHaveBeenCalledTimes(1)
    expect(compute.mock.calls[0][0].feature).toBe('shop')
    expect(monitor.read('shop').freshness).toMatchObject({ state: 'stale', nextAction: { stage: 'prd-summary' } })
    fs.utimesSync(fixture.spec, new Date(), new Date())
    await monitor.reconcile()
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('keeps checking imported helpers outside the suite and unresolved import candidates', async () => {
    const helper = path.join(fixture.root, 'util.ts')
    fs.writeFileSync(helper, 'export const value = 1')
    fs.writeFileSync(fixture.spec, `import { value } from '../../../util'\nimport { later } from '../../../later'\n${fs.readFileSync(fixture.spec, 'utf8')}`)
    await service.runCoverageEngine(fixture.args, { propose: fakePropose })
    expect(monitor.read('shop').freshness.state).toBe('current')
    compute.mockClear()
    fs.writeFileSync(helper, 'export const value = 2')
    expect(monitor.read('shop').freshness.state).toBe('stale')
    expect(compute).toHaveBeenCalledTimes(1)
    await service.runCoverageEngine(fixture.args, { propose: fakePropose })
    expect(monitor.read('shop').freshness.state).toBe('current')
    fs.writeFileSync(path.join(fixture.root, 'later.ts'), 'export const later = 1')
    expect(monitor.read('shop').freshness.state).toBe('stale')
  })

  it('invalidates cached resolution when an inherited configuration changes', () => {
    const base = path.join(fixture.root, 'base.json')
    fs.writeFileSync(base, '{"compilerOptions":{"strict":true}}')
    fs.writeFileSync(path.join(fixture.root, 'tsconfig.json'), '{"extends":"./base.json"}')
    monitor.read('shop')
    compute.mockClear()
    fs.writeFileSync(base, '{"compilerOptions":{"strict":false}}')
    monitor.read('shop')
    expect(compute).toHaveBeenCalledTimes(1)
    fs.unlinkSync(base)
    monitor.read('shop')
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('updates newly added/removed tests, support data, source selection and mapping state', async () => {
    await monitor.reconcile()
    compute.mockClear()
    const spec = path.join(fixture.featureDir, 'e2e', 'added.spec.ts')
    fs.writeFileSync(spec, "test('extra', async () => { expect(2).toBe(2) })")
    expect(monitor.ledger('shop').tests).toHaveLength(2)
    fs.unlinkSync(spec)
    expect(monitor.ledger('shop').tests).toHaveLength(1)
    const data = path.join(fixture.featureDir, 'e2e', 'data')
    fs.mkdirSync(data)
    fs.writeFileSync(path.join(data, 'orders.json'), '[]')
    monitor.read('shop')
    fs.writeFileSync(path.join(fixture.featureDir, 'docs', '_document-selection.json'), '{}')
    monitor.read('shop')
    fs.unlinkSync(path.join(fixture.featureDir, 'docs', '_coverage-state.json'))
    expect(monitor.read('shop').freshness.state).toBe('stale')
    expect(compute).toHaveBeenCalledTimes(5)
    expect(compute.mock.calls.every(([args]) => args.feature === 'shop')).toBe(true)
  })

  it('does not let cached older proof hide a new run, a changed result or dirty-test evidence', async () => {
    fixture.run('passed', 'passed')
    await monitor.reconcile()
    expect(monitor.ledger('shop').tests[0].lastRun?.passed).toBe(true)
    compute.mockClear()
    fixture.run('pending', 'running', false)
    await monitor.reconcile()
    expect(monitor.ledger('shop').tests[0].lastRun).toBeUndefined()
    fs.writeFileSync(path.join(fixture.args.logsDir, 'runs', 'pending', 'e2e-summary.json'), JSON.stringify({ failed: [{ name: 'test-case-create-order' }] }))
    expect(monitor.ledger('shop').freshness?.latestRunFailed).toBe(true)
    const dirty = path.join(fixture.args.logsDir, 'dirty-specs', 'shop')
    fs.mkdirSync(dirty, { recursive: true })
    fs.writeFileSync(path.join(dirty, 'dirty.json'), JSON.stringify({ status: 'dirty', dirtySpecs: [], since: '2026-09-18' }))
    monitor.read('shop')
    expect(compute).toHaveBeenCalledTimes(3)
    expect(compute.mock.calls.every(([args]) => args.feature === 'shop')).toBe(true)
  })

  it('tracks active jobs without invalidating unrelated suites', async () => {
    await monitor.reconcile()
    compute.mockClear()
    const store = new CoverageJobRunStore(fixture.args.logsDir)
    store.save({ jobId: 'mapping', feature: 'shop', kind: 'coverage', status: 'running', startedAt: '2026-09-17T00:00:00Z', log: '' })
    await monitor.reconcile()
    expect(monitor.read('shop').freshness.state).toBe('updating')
    store.save({ ...store.get('mapping')!, status: 'done' })
    expect(monitor.read('shop').freshness.state).toBe('current')
    expect(compute).toHaveBeenCalledTimes(2)
    expect(compute.mock.calls.every(([args]) => args.feature === 'shop')).toBe(true)
  })

  it('does not certify an old snapshot after read errors and recovers when inputs return', () => {
    monitor.read('shop')
    const source = fs.readFileSync(fixture.doc)
    fs.unlinkSync(fixture.doc)
    expect(monitor.read('shop').freshness.state).toBe('unavailable')
    fs.writeFileSync(fixture.doc, source)
    expect(monitor.read('shop').freshness.state).toBe('current')
    const spec = fs.readFileSync(fixture.spec)
    fs.writeFileSync(fixture.spec, "test('partial', () => {")
    expect(monitor.read('shop').freshness.state).toBe('unavailable')
    fs.writeFileSync(fixture.spec, spec)
    expect(monitor.read('shop').freshness.state).toBe('current')
  })

  it('rejects mixed-input calculations instead of caching them as fresh', () => {
    compute.mockImplementationOnce((args) => {
      const ledger = computeFeatureCoverage(args)
      fs.appendFileSync(fixture.doc, '\nChanged during calculation.')
      return ledger
    })
    expect(monitor.read('shop').freshness).toMatchObject({ state: 'unavailable', reasons: [expect.stringContaining('changed during calculation')] })
    expect(monitor.read('shop').freshness.state).toBe('stale')
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('drops removed/renamed suite snapshots and rejects unknown suite requests', async () => {
    await monitor.reconcile()
    fs.renameSync(path.join(fixture.args.featuresDir, 'other'), path.join(fixture.args.featuresDir, 'renamed'))
    fs.writeFileSync(path.join(fixture.args.featuresDir, 'renamed', 'feature.config.cjs'), "module.exports = { config: { name: 'renamed', featureDir: __dirname } }")
    await monitor.reconcile()
    expect(monitor.list().map((change) => change.feature).sort()).toEqual(['renamed', 'shop'])
    expect(() => monitor.ledger('other')).toThrow('feature not found')
    const cache = new CoverageSnapshotCache(fixture.args)
    cache.get('shop')
    cache.clear()
    expect(cache.get('shop').freshness?.state).toBe('current')
  })

  it('handles an absent feature root and ignores files alongside suite directories', () => {
    const empty = new CoverageSnapshotCache({ ...fixture.args, featuresDir: path.join(fixture.root, 'missing') })
    expect(empty.features()).toEqual([])
    fs.writeFileSync(path.join(fixture.args.featuresDir, 'README.md'), '# Suites')
    const cache = new CoverageSnapshotCache(fixture.args)
    expect(cache.features().map((feature) => feature.name).sort()).toEqual(['other', 'shop'])
  })

  it('does not cache discovery if suite configuration changes while loading', () => {
    const load = featureLoader.loadFeatures
    vi.spyOn(featureLoader, 'loadFeatures').mockImplementationOnce((dir) => {
      const features = load(dir)
      fs.appendFileSync(path.join(fixture.featureDir, 'feature.config.cjs'), '\n// changed while loading')
      return features
    })
    const cache = new CoverageSnapshotCache(fixture.args)
    expect(() => cache.features()).toThrow('configuration changed during discovery')
    expect(cache.get('shop').feature).toBe('shop')
  })

  it('rejects a calculation if newer execution evidence arrives during it', () => {
    compute.mockImplementationOnce((args) => {
      const ledger = computeFeatureCoverage(args)
      fixture.run('newer-failure', 'failed')
      return ledger
    })
    expect(monitor.read('shop').freshness.state).toBe('unavailable')
    expect(monitor.read('shop').freshness.latestRunFailed).toBe(true)
  })
})
