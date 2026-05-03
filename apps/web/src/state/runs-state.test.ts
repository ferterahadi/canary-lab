import { describe, it, expect } from 'vitest'
import {
  errorMessage,
  frameToAction,
  initialRunsState,
  runsReducer,
  type RunsState,
} from './runs-state'
import { ApiError } from '../api/client'
import type { RunDetail, RunIndexEntry } from '../api/types'

// Helpers — small constructors for the shapes the reducer tests need.

function entry(overrides: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    runId: 'r1',
    feature: 'foo',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'running',
    ...overrides,
  }
}

function detail(overrides: Partial<RunDetail['manifest']> = {}): RunDetail {
  return {
    runId: overrides.runId ?? 'r1',
    manifest: {
      runId: 'r1',
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      ...overrides,
    },
  }
}

describe('runsReducer', () => {
  it('snapshot replaces runs and details', () => {
    const next = runsReducer(initialRunsState, {
      type: 'snapshot',
      runs: [entry({ runId: 'a' }), entry({ runId: 'b' })],
      details: { a: detail({ runId: 'a' }) },
    })
    expect(next.runs).toHaveLength(2)
    expect(next.details.a.runId).toBe('a')
  })

  it('update inserts a new entry sorted by startedAt desc and merges detail', () => {
    const start: RunsState = {
      ...initialRunsState,
      runs: [entry({ runId: 'old', startedAt: '2026-01-01T00:00:00Z' })],
    }
    const next = runsReducer(start, {
      type: 'update',
      runId: 'new',
      detail: detail({ runId: 'new', startedAt: '2026-02-01T00:00:00Z' }),
    })
    expect(next.runs.map((r) => r.runId)).toEqual(['new', 'old'])
    expect(next.details.new.runId).toBe('new')
  })

  it('update replaces an existing entry rather than duplicating it', () => {
    const start: RunsState = {
      ...initialRunsState,
      runs: [entry({ runId: 'r1', status: 'running' })],
      details: { r1: detail({ status: 'running' }) },
    }
    const next = runsReducer(start, {
      type: 'update',
      runId: 'r1',
      detail: detail({ status: 'passed', endedAt: '2026-01-01T00:05:00Z' }),
    })
    expect(next.runs).toHaveLength(1)
    expect(next.runs[0].status).toBe('passed')
    expect(next.runs[0].endedAt).toBe('2026-01-01T00:05:00Z')
    expect(next.details.r1.manifest.status).toBe('passed')
  })

  it('removed drops the run from runs, details, transients, and errors', () => {
    const start: RunsState = {
      runs: [entry({ runId: 'r1' }), entry({ runId: 'r2' })],
      details: { r1: detail(), r2: detail({ runId: 'r2' }) },
      transients: { r1: 'aborting', r2: 'deleting' },
      errors: { r1: 'oops' },
      connection: 'live',
    }
    const next = runsReducer(start, { type: 'removed', runId: 'r1' })
    expect(next.runs.map((r) => r.runId)).toEqual(['r2'])
    expect(next.details).toEqual({ r2: detail({ runId: 'r2' }) })
    expect(next.transients).toEqual({ r2: 'deleting' })
    expect(next.errors).toEqual({})
  })

  it('list-changed replaces runs but preserves details', () => {
    const start: RunsState = {
      ...initialRunsState,
      runs: [entry({ runId: 'old' })],
      details: { old: detail({ runId: 'old' }) },
    }
    const next = runsReducer(start, {
      type: 'list-changed',
      runs: [entry({ runId: 'fresh' })],
    })
    expect(next.runs.map((r) => r.runId)).toEqual(['fresh'])
    expect(next.details.old).toBeDefined()
  })

  it('connection updates only the connection field', () => {
    const next = runsReducer(initialRunsState, { type: 'connection', status: 'reconnecting' })
    expect(next.connection).toBe('reconnecting')
    expect(next.runs).toBe(initialRunsState.runs)
  })

  it('transient-set / transient-clear toggle the per-run flag', () => {
    let s = runsReducer(initialRunsState, { type: 'transient-set', runId: 'r1', action: 'aborting' })
    expect(s.transients).toEqual({ r1: 'aborting' })
    s = runsReducer(s, { type: 'transient-set', runId: 'r2', action: 'deleting' })
    expect(s.transients).toEqual({ r1: 'aborting', r2: 'deleting' })
    s = runsReducer(s, { type: 'transient-clear', runId: 'r1' })
    expect(s.transients).toEqual({ r2: 'deleting' })
  })

  it('error-set / error-clear toggle the per-run error string', () => {
    let s = runsReducer(initialRunsState, { type: 'error-set', runId: 'r1', message: 'boom' })
    expect(s.errors).toEqual({ r1: 'boom' })
    s = runsReducer(s, { type: 'error-clear', runId: 'r1' })
    expect(s.errors).toEqual({})
  })

  it('http-list overwrites runs (HTTP fallback path)', () => {
    const next = runsReducer(initialRunsState, {
      type: 'http-list',
      runs: [entry({ runId: 'x' })],
    })
    expect(next.runs.map((r) => r.runId)).toEqual(['x'])
  })

  it('http-detail merges a single run detail (HTTP fallback path)', () => {
    const next = runsReducer(initialRunsState, {
      type: 'http-detail',
      runId: 'r1',
      detail: detail(),
    })
    expect(next.details.r1).toBeDefined()
  })
})

describe('frameToAction', () => {
  it('maps each frame type to its corresponding action', () => {
    expect(frameToAction({ type: 'snapshot', runs: [], details: {} })).toEqual({
      type: 'snapshot', runs: [], details: {},
    })
    expect(frameToAction({ type: 'update', runId: 'r1', detail: detail() })).toEqual({
      type: 'update', runId: 'r1', detail: detail(),
    })
    expect(frameToAction({ type: 'removed', runId: 'r1' })).toEqual({
      type: 'removed', runId: 'r1',
    })
    expect(frameToAction({ type: 'list-changed', runs: [] })).toEqual({
      type: 'list-changed', runs: [],
    })
  })
})

describe('errorMessage', () => {
  it('prefers `reason` from a structured ApiError body', () => {
    expect(errorMessage(new ApiError(409, { reason: 'no-failures-yet' }))).toBe('no-failures-yet')
  })

  it('falls back to `error` when there is no `reason`', () => {
    expect(errorMessage(new ApiError(404, { error: 'run not found' }))).toBe('run not found')
  })

  it('falls back to the ApiError message when the body has neither field', () => {
    expect(errorMessage(new ApiError(500, null))).toBe('HTTP 500')
  })

  it('translates network-failure TypeErrors to a user-readable message', () => {
    expect(errorMessage(new TypeError('Failed to fetch'))).toContain('Lost connection')
    expect(errorMessage(new TypeError('Load failed'))).toContain('Lost connection')
    expect(errorMessage(new TypeError('NetworkError when attempting to fetch resource'))).toContain('Lost connection')
  })

  it('returns plain Error.message for generic errors', () => {
    expect(errorMessage(new Error('something broke'))).toBe('something broke')
  })

  it('stringifies non-Error throws', () => {
    expect(errorMessage('plain string')).toBe('plain string')
  })
})
