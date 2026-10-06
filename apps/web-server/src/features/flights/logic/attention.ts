import { flightCheckpointTitle } from '../../../../../../shared/flights/checkpoint-labels'
import { createHash } from 'crypto'
import { flightNeedsAttention, FLIGHT_ATTENTION_RECONCILE_MS, type FlightAttention } from '../../../../../../shared/flights/attention'
import { flightIndexEntry } from '../../../../../../shared/flights/index-entry'
import { recommendFlightContinuation, type FlightWorkspaceEvidence } from '../../../../../../shared/flights/continuation'
import { flightStageLabel } from '../../../../../../shared/flights/stage-labels'
import type { FlightIndexEntry, FlightManifest, FlightStageKey } from '../../../../../../shared/flights/types'
import { TaskListeners } from '../../../../../../shared/lib/file-backed-task-store'
import type { WorkspaceEventBus } from '../../../shared/workspace-events'
import type { FlightStore, FlightStoreEvent } from './store'
import { workspaceStageEvidence, type WorkspaceEvidenceDeps } from './workspace-evidence'

/** These stages have current, target-aware postconditions. Other failures stay
 * actionable until their owning workflow provides equivalent evidence. */
const VERIFIABLE_STAGES: FlightStageKey[] = ['docs', 'prd-summary', 'specs-coverage']
const PREREQUISITES: FlightStageKey[] = ['env-capture', 'docs', 'prd-summary', 'specs-coverage']
const EVIDENCE_STAGES: FlightStageKey[] = ['env-capture', 'docs', 'prd-summary', 'specs-coverage', 'run', 'evaluation-export', 'portify']
/** Workspace changes that can move an assessment without a flight event. */
const EVIDENCE_EVENTS = new Set(['coverage-changed', 'tests-changed', 'features-changed', 'envsets-changed', 'feature-created',
  'feature-deleted', 'feature-renamed', 'evaluation-export-updated', 'portify-changed'])

function actionableTitle(manifest: FlightManifest, checkpointKind: FlightIndexEntry['checkpointKind'], label: string): string {
  if (manifest.pauseReason === 'stage-failed') return `Flight paused: ${label} failed`
  if (manifest.status !== 'waiting-for-approval') return `Flight paused: ${label} was interrupted`
  return checkpointKind ? flightCheckpointTitle(checkpointKind) : `${label} needs your input`
}

type Assessment = Omit<FlightAttention, 'checkedAt' | 'revision'>

function assess(manifest: FlightManifest, readEvidence: () => FlightWorkspaceEvidence): Assessment {
  const stage = manifest.currentStage
  const label = stage ? flightStageLabel(stage) : 'Flight'
  const entry = flightIndexEntry({ ...manifest, attention: undefined })
  if (!flightNeedsAttention(entry)) return { state: 'none', stage, title: '', reason: '' }
  const actionable: Assessment = {
    state: 'actionable', stage,
    title: actionableTitle(manifest, entry.checkpointKind, label),
    reason: manifest.status === 'waiting-for-approval'
      ? 'Answer the open checkpoint to continue.' : 'Resume retries the unfinished step and continues the flight.',
  }
  if (manifest.pauseReason !== 'stage-failed' || !stage || !VERIFIABLE_STAGES.includes(stage)) return actionable

  const failed = manifest.stages.find((s) => s.key === stage)
  if (failed?.error?.includes('agent exited')) actionable.title = `Flight paused: ${label} agent failed`
  try {
    const evidence = readEvidence()
    const coverage = evidence['specs-coverage']
    if (coverage?.freshnessState === 'unavailable' || !coverage?.summaryState) {
      throw new Error('Current requirements and coverage could not be verified')
    }
    const next = recommendFlightContinuation(evidence, manifest.opts.coverageTarget)
    const nextAt = next ? PREREQUISITES.indexOf(next.fromStage) : -1
    if (next && nextAt >= 0 && nextAt <= PREREQUISITES.indexOf(stage)) {
      return { ...actionable, reason: next.reason, remainingStage: next.fromStage }
    }
    const remaining = next ? ` Remaining: ${flightStageLabel(next.fromStage)} — ${next.reason}.` : ' No remaining steps were found.'
    return {
      ...actionable,
      state: 'resolved',
      title: 'Earlier failure resolved by current evidence.',
      reason: `Current workspace evidence satisfies ${label}.${remaining} Nothing has been started.`,
      ...(next ? { remainingStage: next.fromStage } : {}),
    }
  } catch (error) {
    return { ...actionable, state: 'unavailable', reason: `Could not verify current state: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function assessFlightAttention(
  manifest: FlightManifest,
  readEvidence: () => FlightWorkspaceEvidence,
  now = new Date().toISOString(),
): FlightAttention {
  const result = assess(manifest, readEvidence)
  return { ...result, checkedAt: now, revision: createHash('sha256').update(JSON.stringify([manifest.updatedAt, result])).digest('hex') }
}

/** One owner for attention across REST, sockets, inbox and agent reads. The
 * underlying FlightStore remains the unmodified execution journal. */
export class FlightAttentionReader {
  private readonly events = new TaskListeners<FlightStoreEvent>()
  private readonly revisions = new Map<string, string>()
  private timer?: ReturnType<typeof setInterval>
  private pending?: ReturnType<typeof setTimeout>
  private unsubscribe?: () => void
  constructor(
    private readonly store: Pick<FlightStore, 'get' | 'list' | 'onEvent' | 'offEvent'>,
    paths: WorkspaceEvidenceDeps,
    private readonly workspaceEvents: WorkspaceEventBus,
    private readonly readEvidence = (m: FlightManifest) => workspaceStageEvidence(paths, m.feature, EVIDENCE_STAGES, m.opts.env, true),
  ) {}

  get(flightId: string): FlightManifest | null {
    const manifest = this.store.get(flightId)
    return manifest ? { ...manifest, attention: assessFlightAttention(manifest, () => this.readEvidence(manifest)) } : null
  }

  list() {
    return this.store.list().map((entry) => {
      const manifest = this.get(entry.flightId)
      return manifest ? { ...entry, attention: manifest.attention } : entry
    })
  }

  reconcile = (): void => {
    const present = new Set<string>()
    for (const entry of this.list()) {
      present.add(entry.flightId)
      const revision = entry.attention?.revision ?? ''
      if (this.revisions.get(entry.flightId) === revision) continue
      this.revisions.set(entry.flightId, revision)
      this.events.emit({ kind: 'changed', flightId: entry.flightId })
    }
    for (const id of this.revisions.keys()) {
      if (present.has(id)) continue
      this.revisions.delete(id)
      this.events.emit({ kind: 'removed', flightId: id })
    }
  }

  private onStore = (event: FlightStoreEvent): void => {
    // Execution/log changes must reach readers even when attention is unchanged.
    this.events.emit(event)
    this.schedule()
  }
  private schedule(): void {
    if (this.pending) return
    this.pending = setTimeout(() => { this.pending = undefined; this.reconcile() }, 100)
    this.pending.unref()
  }
  start(): void {
    this.reconcile()
    this.store.onEvent(this.onStore)
    this.unsubscribe = this.workspaceEvents.subscribe((event) => {
      if (EVIDENCE_EVENTS.has(event.type)) this.schedule()
    })
    this.timer = setInterval(this.reconcile, FLIGHT_ATTENTION_RECONCILE_MS)
    this.timer.unref()
  }
  close(): void {
    clearInterval(this.timer)
    clearTimeout(this.pending)
    this.unsubscribe?.()
    this.store.offEvent(this.onStore)
  }
  onEvent(fn: (event: FlightStoreEvent) => void): void { this.events.add(fn) }
  offEvent(fn: (event: FlightStoreEvent) => void): void { this.events.delete(fn) }
}
