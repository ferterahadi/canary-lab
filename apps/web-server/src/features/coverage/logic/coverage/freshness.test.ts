import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceEventBus, type WorkspaceEvent } from '../../../../shared/workspace-events'
import { CoverageFreshnessMonitor } from './freshness-monitor'
import { freshnessWorkspace } from './__fixtures__/freshness-workspace'
import { computeFeatureCoverage, runCoverageEngine } from './service'
import { fakePropose } from './__fixtures__/fake-coverage-agents'
import { CoverageJobRunStore } from './jobs/store'
import { startExternalCoverage, startExternalSummary, submitExternalCoverage, submitExternalSummary } from './jobs/external'

let fixture: Awaited<ReturnType<typeof freshnessWorkspace>>
let monitor: CoverageFreshnessMonitor
let events: WorkspaceEvent[]

beforeEach(async () => {
  fixture = await freshnessWorkspace()
  const bus = new WorkspaceEventBus()
  events = []
  bus.subscribe((event) => events.push(event))
  monitor = new CoverageFreshnessMonitor(fixture.args, bus, () => {})
})
afterEach(() => { monitor.close(); fixture.cleanup() })

describe('coverage freshness, real inputs and live delivery', () => {
  it('detects an edited linked source without a browser request and routes recovery to requirements', async () => {
    monitor.start()
    const before = monitor.read('shop')
    expect(before.freshness.state).toBe('current')
    await monitor.reconcile()
    const waiting = monitor.wait('shop', before.freshness.revision, 2000)
    fs.appendFileSync(fixture.doc, '\n# Cancel order\nA buyer can cancel.')
    const changed = await waiting
    expect(changed.changed).toBe(true)
    expect(changed.change.freshness).toMatchObject({ state: 'stale', nextAction: { stage: 'prd-summary' } })
    expect(events).toContainEqual(expect.objectContaining({ type: 'coverage-changed', feature: 'shop', revision: changed.change.freshness.revision }))
  })

  it('reconciles additions, deletions, helpers and configuration after dropped events', async () => {
    const initial = monitor.read('shop')
    fs.appendFileSync(fixture.spec, "test('cancel order', async () => { expect(2).toBe(2) })\n")
    await monitor.reconcile()
    expect(monitor.list()[0]).toMatchObject({ measurement: { tests: 2 }, freshness: { state: 'stale', nextAction: { stage: 'specs-coverage' } } })
    expect(monitor.list()[0].freshness.revision).not.toBe(initial.freshness.revision)
    await runCoverageEngine(fixture.args, { propose: fakePropose })
    fs.writeFileSync(path.join(fixture.featureDir, 'e2e', 'helper.ts'), 'export const value = 2')
    expect(monitor.read('shop').freshness.state).toBe('stale')
    await runCoverageEngine(fixture.args, { propose: fakePropose })
    fs.writeFileSync(path.join(fixture.root, 'package-lock.json'), '{"lockfileVersion":3}')
    expect(monitor.read('shop').freshness.state).toBe('stale')
    fs.unlinkSync(fixture.spec)
    expect(monitor.read('shop')).toMatchObject({ measurement: { tests: 0 }, freshness: { state: 'stale' } })
  })

  it('does not hide a newer failure, or fall back to an older pass while a newer run has no result', () => {
    fixture.run('pass', 'passed')
    const passed = computeFeatureCoverage(fixture.args)
    expect(passed.freshness).toMatchObject({ state: 'current', latestRunId: 'pass', latestRunFailed: false, proofNeedsRun: false })
    fixture.run('fail', 'failed')
    const failed = computeFeatureCoverage(fixture.args)
    expect(failed.coveragePct).toBe(passed.coveragePct)
    expect(failed.enforcement?.provenUnchanged).toBe(1)
    expect(failed.freshness).toMatchObject({ latestRunFailed: true, latestRunId: 'fail', nextAction: { stage: 'run' } })
    expect(failed.tests[0].lastRun?.passed).toBe(false)
    fixture.run('starting', 'running', false)
    const starting = computeFeatureCoverage(fixture.args)
    expect(starting.provenRunId).toBeUndefined()
    expect(starting.tests[0].lastRun).toBeUndefined()
    expect(starting.freshness).toMatchObject({ latestRunId: 'starting', latestRunStatus: 'running', proofNeedsRun: true })
  })

  it('keeps old run proof historical after changed helper inputs are remapped', async () => {
    fixture.run('pass', 'passed')
    fs.writeFileSync(path.join(fixture.featureDir, 'e2e', 'helper.ts'), 'export const value = 2')
    await runCoverageEngine({ ...fixture.args, now: '2026-09-18T00:00:00Z' }, { propose: fakePropose })
    expect(computeFeatureCoverage(fixture.args).freshness).toMatchObject({ state: 'current', proofNeedsRun: true, nextAction: { stage: 'run' } })
  })

  it('reports broken linked sources as unavailable and recovers when restored', () => {
    fs.unlinkSync(fixture.doc)
    expect(monitor.read('shop').freshness.state).toBe('unavailable')
    fs.writeFileSync(fixture.doc, '# Create order\nA buyer can create an order.')
    expect(monitor.read('shop').freshness.state).toBe('current')
  })

  it('withdraws measurements while a spec is malformed and recovers after the save completes', () => {
    const original = fs.readFileSync(fixture.spec, 'utf8')
    fs.writeFileSync(fixture.spec, "test('half-written', async () => {")
    expect(monitor.read('shop')).toMatchObject({ freshness: { state: 'unavailable' } })
    expect(monitor.list()[0].measurement).toBeUndefined()
    fs.writeFileSync(fixture.spec, original)
    expect(monitor.read('shop').freshness.state).toBe('current')
  })

  it('returns unchanged snapshots on timeout and catches up across observer restarts', async () => {
    const first = monitor.read('shop')
    expect(await monitor.wait('shop', first.freshness.revision, 5)).toMatchObject({ changed: false })
    monitor.close()
    fs.appendFileSync(fixture.doc, '\nChanged wording.')
    monitor = new CoverageFreshnessMonitor(fixture.args, new WorkspaceEventBus(), () => {})
    expect(await monitor.wait('shop', first.freshness.revision, 0)).toMatchObject({ changed: true, change: { freshness: { state: 'stale' } } })
    const waiting = monitor.wait('shop', monitor.read('shop').freshness.revision, 30_000)
    monitor.close()
    expect(await waiting).toMatchObject({ change: { freshness: { state: 'unavailable' } } })
  })

  it('rejects stale external summaries and mappings and releases their job claims', () => {
    const store = new CoverageJobRunStore(fixture.args.logsDir)
    const summary = startExternalSummary({ ...fixture.args, sessionId: 'agent' }, { store })
    expect(summary.kind).toBe('started')
    if (summary.kind !== 'started') throw new Error('Missing summary context')
    fs.appendFileSync(fixture.doc, '\nUpdated requirements.')
    expect(() => submitExternalSummary({ ...fixture.args, jobId: summary.manifest.jobId, requirements: [] }, { store })).toThrow('Source documents changed')
    expect(store.get(summary.manifest.jobId)?.status).toBe('failed')
    expect(store.activeFor('shop', 'summary')).toBeNull()
    const mapping = startExternalCoverage({ ...fixture.args, sessionId: 'agent' }, { store })
    if (mapping.kind !== 'started') throw new Error('Missing mapping context')
    fs.appendFileSync(fixture.spec, "test('another', async () => {})\n")
    expect(() => submitExternalCoverage({ ...fixture.args, jobId: mapping.manifest.jobId, mappings: [], unmappable: ['create order'] }, { store })).toThrow('Mapping inputs changed')
    expect(store.get(mapping.manifest.jobId)?.status).toBe('failed')
    expect(store.activeFor('shop', 'coverage')).toBeNull()
  })

  it('publishes standalone run completion while the observer remains mounted', async () => {
    monitor.start()
    const before = monitor.read('shop')
    fixture.run('fail', 'failed')
    await vi.waitFor(() => expect(monitor.list()[0].freshness.latestRunFailed).toBe(true))
    expect(monitor.list()[0].freshness.revision).not.toBe(before.freshness.revision)
  })
})
