import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunStore, createRegistry } from '../../runs/logic/run-store'
import { writeManifest } from '../../runs/logic/runtime/manifest'
import { runDirFor } from '../../runs/logic/runtime/run-paths'
import { FlightRunStore } from '../../flights/logic/store'
import { PortifyRunStore } from '../../portify/logic/runtime/store'
import { CoverageJobRunStore, bridgeCoverageJobEvents } from '../../coverage/logic/coverage/jobs/store'
import { createDraft, readDraft, writeDraft, bridgeDraftEvents, deleteDraft } from '../../wizard/logic/draft-store'
import { readEvaluationExportTask, writeEvaluationExportTask, bridgeEvaluationExportEvents } from '../../evaluation/logic/evaluation-export-store'
import { WorkspaceEventBus, type WorkspaceEvent } from '../../../shared/workspace-events'
import { createGettingStartedRuntime } from './getting-started-runtime'
import type { GettingStartedSessionState, GettingStartedTarget } from './getting-started-session'

let logsDir: string
let runs: RunStore
let flights: FlightRunStore
let portify: PortifyRunStore
let coverage: CoverageJobRunStore
let events: WorkspaceEventBus
let runtime: ReturnType<typeof createGettingStartedRuntime>
const now = '2026-01-01T00:00:00Z'
const target = (kind: GettingStartedTarget['kind']): GettingStartedTarget => ({ kind, id: kind === 'export' ? 'eval-20260101-abcd' : 'target', feature: 'sample' })
const persisted = (): GettingStartedSessionState => JSON.parse(fs.readFileSync(path.join(logsDir, 'getting-started/session.json'), 'utf8'))
function run(status: 'queued' | 'running' | 'failed' | 'healing' | 'passed') {
  const dir = runDirFor(logsDir, 'target')
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(path.join(dir, 'manifest.json'), { runId: 'target', feature: 'sample', status, startedAt: now, healCycles: 0, services: [] })
}
function flight(status: 'running' | 'paused') {
  flights.save({ flightId: 'target', feature: 'sample', repoPaths: [], description: 'sample',
    opts: { env: 'local', yolo: false, coverageTarget: 100 }, status, currentStage: null,
    stages: [], createdAt: now, updatedAt: now })
}
function portification(status: 'ready-to-save' | 'saved') {
  portify.save({ workflowId: 'target', feature: 'sample', featureDir: path.join(logsDir, 'sample'),
    repos: [], agent: 'claude', branch: 'test-ports', status, attempt: 0, maxAttempts: 3, startedAt: now })
}
function mapping(status: 'running' | 'done') {
  coverage.save({ jobId: 'target', feature: 'sample', kind: 'coverage', status, startedAt: now, log: '' })
}
function exporting(status: 'running' | 'done') {
  writeEvaluationExportTask(logsDir, { taskId: 'eval-20260101-abcd', runId: 'run', feature: 'sample', mode: 'raw', status: status === 'done' ? 'completed' : status,
    createdAt: now, updatedAt: now, downloadReady: false, archiveBase: 'sample' })
}
function claim(kind: GettingStartedTarget['kind']) {
  const session = runtime.store.claim('run', 'external')
  runtime.store.attach(session.sessionId, target(kind))
  return session
}
beforeEach(() => {
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-onboarding-runtime-'))
  runs = new RunStore(logsDir, createRegistry())
  flights = new FlightRunStore(logsDir)
  portify = new PortifyRunStore(logsDir)
  coverage = new CoverageJobRunStore(logsDir)
  events = new WorkspaceEventBus()
  bridgeCoverageJobEvents(coverage, events)
  bridgeDraftEvents(logsDir, events)
  bridgeEvaluationExportEvents(logsDir, events)
  runtime = createGettingStartedRuntime({ logsDir, runStore: runs, flightStore: flights,
    portifyStore: portify, coverageJobStore: coverage, workspaceEvents: events,
    readDraft: (id) => readDraft(logsDir, id), readExport: (id) => readEvaluationExportTask(logsDir, id) })
})
afterEach(() => { runtime.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(logsDir, { recursive: true, force: true }) })

describe('Getting Started runtime', () => {
  it.each(['queued', 'running', 'healing'] as const)('keeps %s runs claimed and settles from run events', (status) => {
    runtime.start()
    run(status)
    claim('run')
    expect(runtime.store.read().active).not.toBeNull()
    runs.patchManifest('target', { status: 'passed' })
    expect(persisted()).toMatchObject({ active: null, completed: { run: { status: 'passed', owner: 'external' } } })
  })
  it('keeps running Flights claimed and settles on pause', () => {
    runtime.start(); flight('running'); claim('flight')
    expect(runtime.store.read().active).not.toBeNull()
    flight('paused')
    expect(persisted()).toMatchObject({ active: null, completed: { run: { status: 'paused' } } })
  })
  it('keeps Portify claimed until its ready-to-save decision is made', () => {
    runtime.start(); portification('ready-to-save'); claim('portify')
    expect(runtime.store.read().active).not.toBeNull()
    portification('saved')
    expect(persisted()).toMatchObject({ active: null, completed: { run: { status: 'saved' } } })
  })
  it('keeps spec-ready drafts claimed and settles through the production event bridge', () => {
    runtime.start()
    const draft = createDraft(logsDir, { draftId: 'target', prdText: 'sample', repos: [] })
    writeDraft(logsDir, { ...draft, status: 'spec-ready' })
    claim('draft')
    expect(runtime.store.read().active).not.toBeNull()
    writeDraft(logsDir, { ...draft, status: 'accepted' })
    expect(persisted()).toMatchObject({ active: null, completed: { run: { status: 'accepted' } } })
  })
  it.each(['coverage-job', 'export'] as const)('settles %s through its production workspace bridge', (kind) => {
    runtime.start()
    const write = kind === 'coverage-job' ? mapping : exporting
    write('running'); claim(kind)
    expect(runtime.store.read().active).not.toBeNull()
    write('done')
    expect(persisted()).toMatchObject({ active: null, completed: { run: { status: kind === 'export' ? 'completed' : 'done' } } })
  })
  it.each(['run', 'flight', 'draft', 'coverage-job', 'portify', 'export'] as const)('preserves existing missing-record behavior for %s', (kind) => {
    runtime.start(); claim(kind)
    const state = runtime.store.read()
    // Draft and Portify deliberately retain the pre-refactor negative terminal
    // checks: even an unknown status is active. Changing that policy is separate.
    if (kind === 'draft' || kind === 'portify') expect(state.active).not.toBeNull()
    else expect(state).toMatchObject({ active: null, completed: { run: { status: 'missing' } } })
  })
  it('waits for startup recovery before reconciling persisted work', () => {
    run('queued'); claim('run')
    expect(persisted().active).not.toBeNull()
    run('passed')
    runtime.start()
    expect(persisted()).toMatchObject({ active: null, completed: { run: { status: 'passed' } } })
  })
  it('clears a claim whose start was interrupted before attaching a target', () => {
    runtime.store.claim('run', 'external')
    runtime.start()
    expect(persisted().active).toBeNull()
  })
  it('retains the failed-to-healing grace period and later settles a genuine failure', async () => {
    vi.useFakeTimers()
    runtime.start(); run('running'); claim('run')
    runs.patchManifest('target', { status: 'failed' })
    runs.patchManifest('target', { status: 'healing' })
    await vi.advanceTimersByTimeAsync(500)
    expect(persisted().active).not.toBeNull()
    runs.patchManifest('target', { status: 'failed' })
    await vi.advanceTimersByTimeAsync(500)
    expect(persisted()).toMatchObject({ active: null, completed: { run: { status: 'failed' } } })
  })
  it('filters self-events and unrelated workspace changes', () => {
    runtime.start(); run('queued'); claim('run')
    run('passed')
    events.publish({ type: 'getting-started-changed' })
    events.publish({ type: 'features-changed' })
    expect(persisted().active).not.toBeNull()
    events.publish({ type: 'coverage-changed', feature: 'sample' })
    expect(persisted().active).toBeNull()
  })
  it.each(['run', 'flight', 'portify', 'coverage-job'] as const)('detaches %s delivery on disposal', (kind) => {
    runtime.start()
    if (kind === 'run') run('queued')
    else if (kind === 'flight') flight('running')
    else if (kind === 'portify') portification('ready-to-save')
    else mapping('running')
    claim(kind); runtime.dispose()
    if (kind === 'run') runs.patchManifest('target', { status: 'passed' })
    else if (kind === 'flight') flight('paused')
    else if (kind === 'portify') portification('saved')
    else mapping('done')
    expect(persisted().active).not.toBeNull()
  })
  it('can be disposed before startup', () => { expect(() => runtime.dispose()).not.toThrow() })
  it('responds to all draft and export event forms', () => {
    runtime.start()
    const draft = createDraft(logsDir, { draftId: 'target', prdText: 'sample', repos: [] })
    const changes: WorkspaceEvent[] = [
      { type: 'draft-created', draft }, { type: 'draft-updated', draft }, { type: 'draft-deleted', draftId: 'target' },
      { type: 'evaluation-export-created', task: { taskId: 'task' } as Extract<WorkspaceEvent, { type: 'evaluation-export-created' }>['task'] },
      { type: 'evaluation-export-updated', task: { taskId: 'task' } as Extract<WorkspaceEvent, { type: 'evaluation-export-updated' }>['task'] },
      { type: 'evaluation-export-deleted', taskId: 'task' },
    ]
    for (const event of changes) {
      run('queued'); claim('run'); run('passed')
      events.publish(event)
      expect(persisted().active).toBeNull()
    }
    deleteDraft(logsDir, draft.draftId)
  })
})
