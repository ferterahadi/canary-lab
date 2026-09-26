import { describe, expect, it } from 'vitest'
import type { RunIndexEntry } from '../api/types'
import {
  initialFeatureSelection, latestFeatureRunId, reconcileRunSelection,
  refreshedFeatureSelection, workspaceRunsForFeature,
} from './workspace-selection'

const run = (runId: string, over: Partial<RunIndexEntry> = {}): RunIndexEntry => ({
  runId, feature: 'suite', status: 'passed', startedAt: '2026-01-01T00:00:00Z', ...over,
})
const suites = [{ name: 'suite' }, { name: 'other' }]

describe('workspace run selection rules', () => {
  it('keeps input order and includes verification and legacy normal runs', () => {
    const runs = [run('boot', { executionType: 'boot' }), run('legacy'),
      run('verify', { executionType: 'verify' }), run('normal', { executionType: 'run' }),
      run('benchmark', { executionType: 'benchmark' }), run('cell', { executionType: 'robustness' }),
      run('elsewhere', { feature: 'other' })]
    expect(workspaceRunsForFeature(runs, 'suite').map((entry) => entry.runId)).toEqual(['legacy', 'verify', 'normal'])
    expect(latestFeatureRunId(runs, 'suite')).toBe('legacy')
    expect(latestFeatureRunId(runs, 'missing')).toBeNull()
    expect(workspaceRunsForFeature(runs, null)).toEqual([])
  })
  it('initializes only an unhydrated workspace with an available suite', () => {
    expect(initialFeatureSelection(suites, null)).toBe('suite')
    expect(initialFeatureSelection(suites, 'other')).toBeNull()
    expect(initialFeatureSelection([], null)).toBeNull()
  })
  it('selects a preferred suite using its first eligible run', () => {
    expect(refreshedFeatureSelection(suites, [run('boot', { executionType: 'boot' }), run('first'), run('second')],
      'other', 'old', 'suite')).toEqual({ feature: 'suite', runId: 'first' })
  })
  it.each([{ runs: [] }, { runs: [run('newest'), run('history')] }])('retains explicit selections across refresh even before their row arrives: $runs', ({ runs }) => {
    expect(refreshedFeatureSelection(suites, runs, 'suite', 'history', 'suite')).toBeNull()
    expect(refreshedFeatureSelection(suites, runs, 'suite', 'history')).toBeNull()
  })
  it('selects a run when the preferred suite has no explicit selection', () => {
    expect(refreshedFeatureSelection(suites, [run('first')], 'suite', null, 'suite')).toEqual({ feature: 'suite', runId: 'first' })
  })
  it('falls back only if the selected suite is also missing', () => {
    expect(refreshedFeatureSelection(suites, [run('first')], 'deleted', 'old', 'missing')).toEqual({ feature: 'suite', runId: 'first' })
    expect(refreshedFeatureSelection(suites, [run('first')], 'other', 'old', 'missing')).toBeNull()
  })
  it('handles unselected, run-less, and empty workspaces', () => {
    expect(refreshedFeatureSelection(suites, [], null, null)).toEqual({ feature: 'suite', runId: null })
    expect(refreshedFeatureSelection([], [run('old')], 'deleted', 'old')).toEqual({ feature: null, runId: null })
  })
  it('clears both the run and its pending guard when no suite is selected', () => {
    expect(reconcileRunSelection(null, 'old', 'pending', null, null)).toEqual({ runId: null, pendingRunId: null })
  })
  it('retains a historical run when newer evidence arrives', () => {
    expect(reconcileRunSelection('suite', 'old', null, run('old'), 'new')).toEqual({ runId: 'old', pendingRunId: null })
  })
  it('clears only the pending guard that matches an indexed selection', () => {
    expect(reconcileRunSelection('suite', 'new', 'new', run('new'), 'new')).toEqual({ runId: 'new', pendingRunId: null })
    expect(reconcileRunSelection('suite', 'old', 'new', run('old'), 'new')).toEqual({ runId: 'old', pendingRunId: 'new' })
  })
  it('retains a pending selection until its row arrives', () => {
    expect(reconcileRunSelection('suite', 'pending', 'pending', null, 'old')).toEqual({ runId: 'pending', pendingRunId: 'pending' })
  })
  it('falls back after a selected run disappears, retaining an unrelated guard', () => {
    expect(reconcileRunSelection('suite', 'deleted', 'other', null, 'latest')).toEqual({ runId: 'latest', pendingRunId: 'other' })
    expect(reconcileRunSelection('suite', null, null, null, null)).toEqual({ runId: null, pendingRunId: null })
  })
})
