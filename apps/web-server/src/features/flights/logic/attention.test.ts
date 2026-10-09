import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLIGHT_STAGE_KEYS, type FlightManifest } from '../../../../../../shared/flights/types'
import { flightNeedsAttention } from '../../../../../../shared/flights/attention'
import { flightCheckpointTitle } from '../../../../../../shared/flights/checkpoint-labels'
import type { FlightWorkspaceEvidence } from '../../../../../../shared/flights/continuation'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { WorkspaceEventBus } from '../../../shared/workspace-events'
import { FlightRunStore } from './store'
import { FlightAttentionReader, assessFlightAttention } from './attention'
import { flightNotificationSources } from '../../notifications/sources'
import { freshnessWorkspace } from '../../coverage/logic/coverage/__fixtures__/freshness-workspace'

const tempDir = trackTempDirs('flight-attention-')
const flight = (over: Partial<FlightManifest> = {}): FlightManifest => ({
  flightId: 'fl_shop', feature: 'shop', repoPaths: ['/repo/shop'], description: 'Checkout',
  opts: { env: 'local', coverageTarget: 100, yolo: false },
  status: 'paused', pauseReason: 'stage-failed', currentStage: 'specs-coverage',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z',
  stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: key === 'specs-coverage' ? 'failed' : 'done',
    ...(key === 'specs-coverage' ? { error: "agent exited with code 2: unexpected argument '--full-auto'", endedAt: '2026-01-01T00:01:00Z' } : {}),
  })), ...over,
})
const evidence = (coveragePct = 100): FlightWorkspaceEvidence => ({
  'env-capture': { captured: 1 }, 'prd-summary': { requirementCount: 10 },
  'specs-coverage': { summaryState: 'fresh', mappingState: 'fresh', coveragePct, testsWritten: 16 },
  run: { status: 'passed' },
})
afterEach(() => vi.useRealTimers())

describe('one attention assessment', () => {
  it('retains an old authoring failure despite completed mapping and a later passing run below target', () => {
    const attention = assessFlightAttention(flight(), () => evidence(45))
    expect(attention).toMatchObject({ state: 'actionable', stage: 'specs-coverage', title: 'Flight paused: Tests & coverage agent failed' })
    expect(attention.reason).toContain('45%')
    expect(flightNeedsAttention({ ...flight(), attention })).toBe(true)
  })
  it('resolves only the attention episode and keeps the failure and remaining work', () => {
    const record = flight()
    const original = structuredClone(record)
    const attention = assessFlightAttention(record, evidence)
    expect(attention).toMatchObject({ state: 'resolved', remainingStage: 'evaluation-export' })
    expect(flightNeedsAttention({ ...record, attention })).toBe(false)
    expect(record).toEqual(original)
    expect(assessFlightAttention(record, evidence, 'later').revision).toBe(attention.revision)
  })
  it.each(['summaryState', 'mappingState'])('does not resolve stale %s, even at 100%%', (key) => {
    const current = evidence()
    current['specs-coverage']![key] = 'stale'
    expect(assessFlightAttention(flight(), () => current).state).toBe('actionable')
  })
  it('does not resolve missing prerequisites or an unreadable source', () => {
    const current = evidence()
    delete current['env-capture']
    expect(assessFlightAttention(flight(), () => current).remainingStage).toBe('env-capture')
    expect(assessFlightAttention(flight(), () => { throw new Error('unreadable source') })).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('Could not verify current state') })
    current['specs-coverage']!.freshnessState = 'unavailable'
    expect(assessFlightAttention(flight(), () => current).state).toBe('unavailable')
  })
  it('titles an open checkpoint by its kind and a waiting flight without one by its stage', () => {
    const waiting = (checkpoint?: FlightManifest['stages'][number]['checkpoint']) => flight({
      status: 'waiting-for-approval', pauseReason: undefined, currentStage: 'docs',
      stages: flight().stages.map((s) => s.key === 'docs' ? { key: 'docs', status: 'waiting-for-approval', checkpoint } : s),
    })
    expect(assessFlightAttention(waiting({ kind: 'prd-source', message: 'Add requirements' }), evidence)).toMatchObject({
      state: 'actionable', stage: 'docs', title: flightCheckpointTitle('prd-source'), reason: 'Answer the open checkpoint to continue.',
    })
    expect(assessFlightAttention(waiting(), evidence).title).toBe('Doc collection needs your input')
  })
  it('keeps a plain stage failure title and reports when nothing remains after it', () => {
    const plain = flight({ stages: flight().stages.map((s) => s.key === 'specs-coverage' ? { ...s, error: 'mapping timed out' } : s) })
    expect(assessFlightAttention(plain, () => evidence(45)).title).toBe('Flight paused: Tests & coverage failed')
    const complete = { ...evidence(), 'evaluation-export': { reports: 1 }, portify: { saved: true } }
    const attention = assessFlightAttention(plain, () => complete)
    expect(attention).toMatchObject({ state: 'resolved', reason: 'Current workspace evidence satisfies Tests & coverage. No remaining steps were found. Nothing has been started.' })
    expect(attention).not.toHaveProperty('remainingStage')
  })
  it('preserves ownership, deliberate pauses, and failures without completion proof', () => {
    const read = vi.fn(evidence)
    for (const record of [flight({ pauseReason: 'user' }), flight({ pauseReason: 'queued' }), flight({ opts: { ...flight().opts, stageProducer: 'external' } })]) {
      expect(assessFlightAttention(record, read).state).toBe('none')
    }
    expect(assessFlightAttention(flight({ currentStage: 'portify' }), read).state).toBe('actionable')
    expect(read).not.toHaveBeenCalled()
  })
})

it('publishes resolution, missed-event recovery and new failures without modifying the journal', () => {
  vi.useFakeTimers()
  const root = tempDir()
  const store = new FlightRunStore(root)
  store.save(flight())
  const original = fs.readFileSync(path.join(store.flightDir('fl_shop'), 'flight.json'), 'utf8')
  const bus = new WorkspaceEventBus()
  let current = evidence(45)
  const reader = new FlightAttentionReader(store, { featuresDir: root, logsDir: root }, bus, () => current)
  const received: string[] = []
  reader.onEvent(() => received.push(reader.get('fl_shop')?.attention?.state ?? 'removed'))
  reader.start()
  try {
    expect(flightNotificationSources(reader.list())[0].message?.target).toMatchObject({ stage: 'specs-coverage' })
    current = evidence()
    bus.publish({ type: 'coverage-changed', feature: 'shop' })
    vi.advanceTimersByTime(100)
    expect(received.at(-1)).toBe('resolved')
    expect(flightNotificationSources(reader.list())[0].message).toBeUndefined()
    current = evidence(20) // Direct file change with its event lost.
    vi.advanceTimersByTime(5000)
    expect(received.at(-1)).toBe('actionable')
    expect(fs.readFileSync(path.join(store.flightDir('fl_shop'), 'flight.json'), 'utf8')).toBe(original)
    const onEvent = vi.fn()
    reader.onEvent(onEvent); reader.offEvent(onEvent)
    store.remove('fl_shop')
    reader.reconcile()
    expect(reader.get('fl_shop')).toBeNull()
    expect(onEvent).not.toHaveBeenCalled()
  } finally { reader.close() }
})

it('keeps listing a flight whose record cannot be read, without inventing attention for it', () => {
  const root = tempDir()
  const store = new FlightRunStore(root)
  store.save(flight())
  fs.rmSync(path.join(store.flightDir('fl_shop'), 'flight.json'))
  const reader = new FlightAttentionReader(store, { featuresDir: root, logsDir: root }, new WorkspaceEventBus(), () => evidence())
  const changed = vi.fn()
  reader.onEvent(changed)
  expect(reader.list()).toEqual(store.list())
  expect(reader.list()[0]).toMatchObject({ flightId: 'fl_shop' })
  expect(reader.list()[0]).not.toHaveProperty('attention')
  reader.reconcile(); reader.reconcile()
  expect(changed.mock.calls).toEqual([[{ kind: 'changed', flightId: 'fl_shop' }]])
})

it('checks real workspace files and invalidates a resolution after a linked document edit', async () => {
  const fixture = await freshnessWorkspace()
  try {
    const env = path.join(fixture.featureDir, 'envsets', 'local')
    fs.mkdirSync(env, { recursive: true }); fs.writeFileSync(path.join(env, 'app.env'), 'MODE=test')
    const store = new FlightRunStore(fixture.args.logsDir)
    store.save(flight())
    const reader = new FlightAttentionReader(store, fixture.args, new WorkspaceEventBus())
    expect(reader.get('fl_shop')?.attention?.state).toBe('resolved')
    fs.appendFileSync(fixture.doc, '\nChanged requirement.')
    expect(reader.get('fl_shop')?.attention).toMatchObject({ state: 'actionable', remainingStage: 'prd-summary' })
    fs.renameSync(path.join(fixture.featureDir, 'feature.config.cjs'), path.join(fixture.root, 'removed.cjs'))
    expect(reader.get('fl_shop')?.attention?.state).toBe('unavailable')
  } finally { fixture.cleanup() }
})
