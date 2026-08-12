import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentJobRunStore, agentJobStore, bridgeAgentJobEvents } from './store'
import type { AgentJobManifest } from './types'
import type { WorkspaceEvent } from '../../../../shared/workspace-events'

// The record half of "an agent is a first-class thing". The interesting behaviour
// is not save/get — the shared store owns that — but what a record says after the
// process that wrote it is gone.

let logsDir: string

beforeEach(() => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agentjobs-')))
})

afterEach(() => fs.rmSync(logsDir, { recursive: true, force: true }))

const job = (over: Partial<AgentJobManifest> = {}): AgentJobManifest => ({
  jobId: 'fl-1:scout',
  flightId: 'fl-1',
  feature: 'checkout',
  stage: 'scout',
  agent: 'claude',
  sessionId: 'sess-1',
  scope: '/flights/fl-1/scout',
  startedAt: '2026-01-01T00:00:00.000Z',
  status: 'running',
  ...over,
})

describe('AgentJobRunStore', () => {
  it('saves and reads back a record', () => {
    const store = new AgentJobRunStore(logsDir)
    store.save(job())
    expect(store.get('fl-1:scout')).toMatchObject({ stage: 'scout', status: 'running', sessionId: 'sess-1' })
    expect(store.list()).toEqual([expect.objectContaining({ jobId: 'fl-1:scout', status: 'running' })])
  })

  it('keeps the public index row free of the shared store\'s bookkeeping mirrors', () => {
    const store = new AgentJobRunStore(logsDir)
    store.save(job())
    const row = store.list()[0] as Record<string, unknown>
    expect(row).not.toHaveProperty('id')
    expect(row).not.toHaveProperty('createdAt')
  })

  it('answers which of a flight\'s agents are live', () => {
    const store = new AgentJobRunStore(logsDir)
    store.save(job())
    store.save(job({ jobId: 'fl-1:docs', stage: 'docs', status: 'done' }))
    store.save(job({ jobId: 'fl-2:scout', flightId: 'fl-2' }))
    expect(store.forFlight('fl-1').map((r) => r.jobId).sort()).toEqual(['fl-1:docs', 'fl-1:scout'])
    expect(store.liveForFlight('fl-1').map((r) => r.jobId)).toEqual(['fl-1:scout'])
  })

  it('indexes a spawn that belongs to no flight', () => {
    // Not every agent Canary spawns is a flight stage's — portify's editing agent
    // and the benchmark sabotage agent have no flightId/feature/stage, and their
    // rows must not carry empty keys for fields they do not have.
    const store = new AgentJobRunStore(logsDir)
    store.save({ jobId: 'standalone-1', agent: 'codex', startedAt: '2026-01-01T00:00:00.000Z', status: 'running' })
    const row = store.list()[0] as Record<string, unknown>
    expect(row).toEqual({ jobId: 'standalone-1', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' })
    expect(store.forFlight('fl-1')).toEqual([])
  })

  it('reconciles an interrupted record to an honest tombstone, not something resumable', () => {
    // The whole reason this status exists. The child died with the server, so there
    // is nothing to re-attach to — but the row is still worth keeping, because its
    // sessionId points at the transcript of what the agent did before it died.
    const store = new AgentJobRunStore(logsDir)
    store.save(job())
    store.reconcileInterrupted(() => '2026-01-02T00:00:00.000Z')
    const after = store.get('fl-1:scout')!
    expect(after.status).toBe('orphaned')
    expect(after.endedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(after.note).toContain('server exited')
    expect(after.note).toContain('Nothing here is resumable')
    // The join to the transcript survives — that is what makes the tombstone
    // information rather than clutter.
    expect(after.sessionId).toBe('sess-1')
  })

  it('leaves already-settled records alone on reconcile', () => {
    const store = new AgentJobRunStore(logsDir)
    store.save(job({ jobId: 'fl-1:docs', status: 'done', endedAt: '2026-01-01T00:05:00.000Z' }))
    store.reconcileInterrupted(() => '2026-01-02T00:00:00.000Z')
    expect(store.get('fl-1:docs')).toMatchObject({ status: 'done', endedAt: '2026-01-01T00:05:00.000Z' })
  })

  it('drops every record for one flight (delete + restart wipe)', () => {
    const store = new AgentJobRunStore(logsDir)
    store.save(job())
    store.save(job({ jobId: 'fl-1:docs', stage: 'docs' }))
    store.save(job({ jobId: 'fl-2:scout', flightId: 'fl-2' }))
    expect(store.removeForFlight('fl-1')).toBe(2)
    expect(store.list().map((r) => r.jobId)).toEqual(['fl-2:scout'])
  })

  it('re-homes records when a suite is renamed', () => {
    // Without this a rename orphans the agent history behind the old suite name.
    const store = new AgentJobRunStore(logsDir)
    store.save(job())
    expect(store.renameFeature('checkout', 'checkout-v2')).toBe(1)
    expect(store.get('fl-1:scout')!.feature).toBe('checkout-v2')
  })

  it('patches a live record terminal', () => {
    const store = new AgentJobRunStore(logsDir)
    store.save(job())
    store.patch('fl-1:scout', { status: 'stopped', stoppedBy: 'user' })
    expect(store.get('fl-1:scout')).toMatchObject({ status: 'stopped', stoppedBy: 'user' })
  })

  it('memoizes one wrapper per logs dir, so the workspace bridge is not lost', () => {
    // The bridge attaches to the WRAPPER's listener set; a fresh wrapper per call
    // site would miss it and pile up forwarding listeners underneath.
    expect(agentJobStore(logsDir)).toBe(agentJobStore(logsDir))
  })

  it('announces every change so a viewer updates without a refresh', () => {
    const events: WorkspaceEvent[] = []
    const store = new AgentJobRunStore(logsDir)
    bridgeAgentJobEvents(store, { publish: (e) => events.push(e) })
    store.save(job())
    expect(events).toContainEqual({ type: 'agent-jobs-changed', jobId: 'fl-1:scout' })
  })

  it('survives a listener that throws — persistence is not a listener\'s to break', () => {
    const store = new AgentJobRunStore(logsDir)
    store.onEvent(() => { throw new Error('bad listener') })
    expect(() => store.save(job())).not.toThrow()
    expect(store.get('fl-1:scout')).not.toBeNull()
  })

  it('stops notifying a removed listener', () => {
    const seen: string[] = []
    const store = new AgentJobRunStore(logsDir)
    const fn = (e: { jobId: string }): void => { seen.push(e.jobId) }
    store.onEvent(fn)
    store.save(job())
    store.offEvent(fn)
    store.save(job({ jobId: 'fl-1:docs', stage: 'docs' }))
    expect(seen).toEqual(['fl-1:scout'])
  })
})
