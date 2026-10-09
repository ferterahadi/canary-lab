import { describe, expect, it, vi } from 'vitest'
import type { RunDetail } from '../../../../../../shared/run-detail'
import type { RunIndexEntry } from '../../../../../../shared/run-index'
import { selectRunForFeature } from './active-run-selection'
import { findActiveRunForFeature } from '../routes/runs-route-support'
import type { RunStore } from './run-store'

function detail(runId: string, env = 'local', manifest: Partial<RunDetail['manifest']> = {}): RunDetail {
  return { runId, manifest: { runId, feature: 'checkout', env, status: 'healing', startedAt: '2026-01-01', healCycles: 0, services: [], ...manifest } } as RunDetail
}

function row(runId: string, overrides: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return { runId, feature: 'checkout', startedAt: '2026-01-01', status: 'healing', ...overrides }
}

function store(rows: RunIndexEntry[], details: RunDetail[]) {
  return {
    list: vi.fn(({ feature }: { feature?: string } = {}) => rows.filter((entry) => entry.feature === feature)),
    get: vi.fn((runId: string) => details.find((entry) => entry.runId === runId) ?? null),
    settleIfOrphaned: vi.fn((_runId: string) => false),
  }
}

const healing = (entry: RunIndexEntry) => entry.status === 'healing'
const anyDetail = () => true

describe('selectRunForFeature', () => {
  it('returns no selection for empty, missing, or ineligible details without loading rejected index rows', () => {
    const source = store([row('done', { status: 'passed' }), row('missing'), row('boot')], [detail('boot', 'local', { executionType: 'boot' })])
    expect(selectRunForFeature(source, 'checkout', undefined, healing, (entry) => entry.manifest.executionType !== 'boot')).toBeNull()
    expect(source.get.mock.calls).toEqual([['missing'], ['boot']])
    expect(selectRunForFeature(store([], []), 'checkout', undefined, healing, anyDetail)).toBeNull()
  })

  it('filters by feature and environment, treating an absent or empty environment as unrestricted', () => {
    const local = detail('local')
    const staging = detail('staging', 'staging')
    const source = store([row('other', { feature: 'other' }), row('local'), row('staging')], [detail('other'), local, staging])
    expect(selectRunForFeature(source, 'checkout', 'staging', healing, anyDetail)).toBe(staging)
    expect(selectRunForFeature(source, 'checkout', undefined, healing, anyDetail)).toBe(local)
    expect(selectRunForFeature(source, 'checkout', '', healing, anyDetail)).toBe(local)
    expect(source.list).toHaveBeenCalledWith({ feature: 'checkout' })
    expect(source.get).not.toHaveBeenCalledWith('other')
  })

  it('prefers waiting-for-signal over a newer healing run and uses index timestamps to break priority ties', () => {
    const waiting = detail('waiting', 'local', { lifecycle: { phase: 'waiting-for-signal', headline: 'Waiting', updatedAt: '2026-01-01' } })
    const old = detail('old', 'local', { startedAt: '2026-12-31' })
    const recent = detail('recent')
    const rows = [row('old'), row('recent', { startedAt: '2026-01-03' }), row('waiting', { startedAt: '2025-01-01' })]
    expect(selectRunForFeature(store(rows, [old, recent, waiting]), 'checkout', undefined, healing, anyDetail)).toBe(waiting)
    expect(selectRunForFeature(store(rows.slice(0, 2), [old, recent]), 'checkout', undefined, healing, anyDetail)).toBe(recent)
  })

  it('keeps the first equally ranked entry and preserves eligibility when manifest status has drifted', () => {
    const stale = detail('stale', 'local', { status: 'passed' })
    const first = detail('first')
    const second = detail('second')
    const rows = [row('stale'), row('first'), row('second')]
    expect(selectRunForFeature(store(rows, [stale, first, second]), 'checkout', undefined, healing, anyDetail)).toBe(first)
    expect(selectRunForFeature(store([row('stale')], [stale]), 'checkout', undefined, healing, anyDetail)).toBe(stale)
  })

  it('settles an eligible run whose server exited instead of handing it out', () => {
    // start_run used to answer reused:true for a healing run nothing drove.
    const orphan = detail('orphan', 'local', { lifecycle: { phase: 'waiting-for-signal', headline: 'Waiting', updatedAt: '2026-01-01' } })
    const live = detail('live')
    const source = store([row('orphan'), row('live'), row('done', { status: 'passed' })], [orphan, live])
    source.settleIfOrphaned.mockImplementation((runId) => runId === 'orphan')
    expect(selectRunForFeature(source, 'checkout', undefined, healing, anyDetail)).toBe(live)
    expect(source.settleIfOrphaned.mock.calls).toEqual([['orphan'], ['live']])
    expect(source.get).not.toHaveBeenCalledWith('orphan')
  })
})

it('HTTP restart keeps healing index eligibility without adding a boot or manifest-status filter', () => {
  const running = detail('running')
  const boot = detail('boot', 'local', { executionType: 'boot', status: 'failed' })
  const source = store([row('running', { status: 'running' }), row('boot')], [running, boot])
  expect(findActiveRunForFeature(source as unknown as RunStore, 'checkout', undefined)).toBe(boot)
  expect(source.get).not.toHaveBeenCalledWith('running')
})
