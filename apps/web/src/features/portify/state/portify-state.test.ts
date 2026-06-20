import { describe, it, expect } from 'vitest'
import {
  portifyReducer,
  initialPortifyState,
  frameToAction,
  isActivePortify,
} from './portify-state'
import type { PortifyManifest } from '../../../shared/api/client'

function m(over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'w1',
    feature: 'cns',
    repos: [{ name: 'app', path: '~/app' }],
    agent: 'claude',
    branch: 'canary/dynamic-ports-cns',
    status: 'verifying',
    attempt: 1,
    maxAttempts: 3,
    startedAt: '2026-06-08T00:00:00.000Z',
    ...over,
  }
}

describe('portifyReducer', () => {
  it('snapshot sets workflows + details', () => {
    const s = portifyReducer(initialPortifyState, {
      type: 'snapshot',
      workflows: [{ workflowId: 'w1', feature: 'cns', status: 'verifying', startedAt: 't' }],
      details: { w1: m() },
    })
    expect(s.workflows).toHaveLength(1)
    expect(s.details.w1.feature).toBe('cns')
  })

  it('update upserts the detail and derives a newest-first index entry', () => {
    let s = portifyReducer(initialPortifyState, { type: 'update', workflowId: 'w1', manifest: m({ startedAt: '2026-06-08T00:00:00.000Z' }) })
    s = portifyReducer(s, { type: 'update', workflowId: 'w2', manifest: m({ workflowId: 'w2', startedAt: '2026-06-08T01:00:00.000Z' }) })
    expect(s.workflows.map((w) => w.workflowId)).toEqual(['w2', 'w1'])
    expect(s.details.w2.workflowId).toBe('w2')
    expect(s.workflows.find((w) => w.workflowId === 'w1')?.status).toBe('verifying')
  })

  it('removed drops the workflow + its detail', () => {
    let s = portifyReducer(initialPortifyState, { type: 'update', workflowId: 'w1', manifest: m() })
    s = portifyReducer(s, { type: 'removed', workflowId: 'w1' })
    expect(s.workflows).toHaveLength(0)
    expect(s.details.w1).toBeUndefined()
  })

  it('carries endedAt into the index entry and keeps both on a startedAt tie', () => {
    let s = portifyReducer(initialPortifyState, {
      type: 'update', workflowId: 'a',
      manifest: m({ workflowId: 'a', status: 'saved', startedAt: '2026-06-08T00:00:00.000Z', endedAt: '2026-06-08T00:05:00.000Z' }),
    })
    s = portifyReducer(s, {
      type: 'update', workflowId: 'b',
      manifest: m({ workflowId: 'b', status: 'saved', startedAt: '2026-06-08T00:00:00.000Z', endedAt: '2026-06-08T00:06:00.000Z' }),
    })
    expect(s.workflows.find((w) => w.workflowId === 'a')?.endedAt).toBe('2026-06-08T00:05:00.000Z')
    expect(s.workflows.map((w) => w.workflowId).sort()).toEqual(['a', 'b'])
  })

  it('orders an older update after a newer one (ascending compare branch)', () => {
    let s = portifyReducer(initialPortifyState, { type: 'update', workflowId: 'newer', manifest: m({ workflowId: 'newer', startedAt: '2026-06-08T02:00:00.000Z' }) })
    s = portifyReducer(s, { type: 'update', workflowId: 'older', manifest: m({ workflowId: 'older', startedAt: '2026-06-08T01:00:00.000Z' }) })
    expect(s.workflows.map((w) => w.workflowId)).toEqual(['newer', 'older'])
  })

  it('connection sets the connection state', () => {
    expect(portifyReducer(initialPortifyState, { type: 'connection', status: 'live' }).connection).toBe('live')
  })
})

describe('frameToAction', () => {
  it('maps a snapshot frame to a snapshot action', () => {
    const workflows = [{ workflowId: 'w1', feature: 'cns', status: 'verifying' as const, startedAt: 't' }]
    const details = { w1: m() }
    expect(frameToAction({ type: 'snapshot', workflows, details })).toEqual({ type: 'snapshot', workflows, details })
  })

  it('maps an update frame to an update action', () => {
    const manifest = m()
    expect(frameToAction({ type: 'update', workflowId: 'w1', manifest })).toEqual({ type: 'update', workflowId: 'w1', manifest })
  })

  it('maps removed and ignores unknown frames', () => {
    expect(frameToAction({ type: 'removed', workflowId: 'w1' })).toEqual({ type: 'removed', workflowId: 'w1' })
    // @ts-expect-error — forwards-compat unknown frame
    expect(frameToAction({ type: 'nope' })).toBeNull()
  })
})

describe('isActivePortify', () => {
  it('treats planning/editing/verifying/ready-to-commit as active, terminal otherwise', () => {
    for (const s of ['planning', 'editing', 'verifying', 'ready-to-save'] as const) {
      expect(isActivePortify(s)).toBe(true)
    }
    for (const s of ['saved', 'failed', 'aborted'] as const) {
      expect(isActivePortify(s)).toBe(false)
    }
  })
})
