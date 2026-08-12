import fs from 'fs'
import path from 'path'
import { validateFeatureTarget as validateScaffoldTarget } from '../../../../../../shared/feature-scaffold'
import type { AgentSessionRef } from '../../agent-sessions/logic/agent-session-log'
import type { ClientKind, RunProducer } from '../../../../../../shared/run-mode'
import { FileBackedTaskStore, sharedTaskStore } from '../../../../../../shared/lib/file-backed-task-store'
import { bridgeRecordEvents } from '../../../shared/store-event-bridge'
import type { WorkspaceEventPublisher } from '../../../shared/workspace-events'

// Draft storage for the Add Test wizard. Each draft lives at
// `<logsDir>/drafts/<draftId>/` with a JSON state file plus the raw PRD,
// the agent's plan output, the generated spec files, and per-stage agent
// pty logs. State transitions are guarded by `transition()` so the route
// layer can't accidentally jump from `created` straight to `accepted`.
//
// All side effects are scoped to the draft directory. Applying an authored
// feature to the project root belongs to the MCP path (apply_external_draft →
// applyExternalDraftFiles), not here.

export type DraftStatus =
  | 'created'
  | 'planning'
  | 'plan-ready'
  | 'generating'
  | 'spec-ready'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'error'

export type DraftSource = RunProducer
export type ExternalDraftStage =
  | 'scaffolding'
  | 'authoring-tests'
  | 'validating'
  | 'ready'
  | 'applied'
  | 'error'

const ALLOWED_TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  created: ['planning', 'rejected', 'cancelled', 'error'],
  planning: ['plan-ready', 'rejected', 'cancelled', 'error'],
  'plan-ready': ['generating', 'rejected', 'error'],
  generating: ['spec-ready', 'rejected', 'cancelled', 'error'],
  'spec-ready': ['accepted', 'rejected', 'error'],
  accepted: [],
  rejected: [],
  cancelled: ['rejected'],
  error: ['rejected'],
}

export interface DraftRepo {
  name: string
  localPath: string
  branch?: string
}

export interface DraftPrdDocument {
  filename: string
  contentType: string
  characters: number
  text?: string
  contentBase64?: string
}

export interface DraftRecord {
  draftId: string
  prdText: string
  additionalNotes?: string
  prdDocuments: DraftPrdDocument[]
  repos: DraftRepo[]
  featureName?: string
  producer?: DraftSource
  externalStage?: ExternalDraftStage
  externalClientKind?: ClientKind
  externalSessionId?: string
  externalConversationName?: string
  externalSessionUrl?: string
  intentSummary?: string
  activeAgentStage?: 'planning' | 'generating'
  planAgentSessionId?: string
  planAgentSessionKind?: 'claude' | 'codex'
  // Structured-session ref + spawn timestamp for the live agent-session WS.
  // Claude pins the session id at spawn so `planAgentSessionRef` is set before
  // the first byte of agent output. Codex has no equivalent flag — the WS
  // tailer discovers the rollout file post-hoc using `planAgentSpawnedAt` as
  // the lower bound and the draft dir as the cwd match.
  status: DraftStatus
  createdAt: string
  updatedAt: string
  plan?: unknown
  generatedFiles?: string[]
  devDependencies?: string[]
  errorMessage?: string
}

export interface DraftPaths {
  draftDir: string
  draftJson: string
  prdMd: string
  planJson: string
  intentMd: string
  planAgentLog: string
  specAgentLog: string
  generatedDir: string
}

export function paths(logsDir: string, draftId: string): DraftPaths {
  const draftDir = path.join(logsDir, 'drafts', draftId)
  return {
    draftDir,
    draftJson: path.join(draftDir, 'draft.json'),
    prdMd: path.join(draftDir, 'prd.md'),
    planJson: path.join(draftDir, 'plan.json'),
    intentMd: path.join(draftDir, 'intent.md'),
    planAgentLog: path.join(draftDir, 'plan-agent.log'),
    specAgentLog: path.join(draftDir, 'spec-agent.log'),
    generatedDir: path.join(draftDir, 'generated'),
  }
}

export function draftStatusOf(r: DraftRecord): string { return r.status }

// Record I/O delegates to the shared FileBackedTaskStore. Layout (drafts/<id>/
// draft.json) matches `paths()` so the per-draft sidecars (prd.md, plan.json,
// agent logs, generated/) still live alongside the record. The draft-specific
// state machine + IllegalTransitionError stay below in `transition()`.
// `sharedTaskStore`, not `new`: every accessor below calls this, and the store
// is what announces a draft write to the workspace bus (bridgeDraftEvents).
// A fresh instance per call would emit into a listener set nobody holds.
function draftStore(logsDir: string): FileBackedTaskStore<DraftRecord> {
  return sharedTaskStore<DraftRecord>({
    logsDir,
    dirName: 'drafts',
    recordFile: 'draft.json',
    idOf: (r) => r.draftId,
    statusOf: draftStatusOf,
    indexEntryOf: (r) => ({
      id: r.draftId,
      createdAt: r.createdAt,
      draftId: r.draftId,
      status: r.status,
      ...(r.featureName ? { featureName: r.featureName } : {}),
      updatedAt: r.updatedAt,
    }),
    // Legacy rows (pre-`id` index shape) carry only `draftId`; fall back to it so
    // remove/prune/reconcile can address them (else they resurrect on refresh).
    idOfEntry: (e) => (typeof e.id === 'string' ? e.id : (e as { draftId?: string }).draftId),
    featureOf: (r) => r.featureName,
    withFeature: (r, featureName) => ({ ...r, featureName }),
    sortNewestFirst: true,
    // Crash recovery: a draft left 'planning'/'generating' by a SERVER-spawned
    // wizard agent belongs to a dead process (this one just started) — flip it
    // to error so the pill stops narrating a live "authoring" forever. External
    // drafts (producer 'external') are another process's session and survive a
    // server restart by design — never touched here.
    reconcile: {
      isInterrupted: (r) =>
        (r.status === 'planning' || r.status === 'generating') && r.producer !== 'external',
      mark: (r, now) => ({
        ...r,
        status: 'error',
        activeAgentStage: undefined,
        errorMessage: 'interrupted by a server restart — plan or generate again',
        updatedAt: now,
      }),
    },
  })
}

/**
 * Attach the workspace bus to the draft store, once per process.
 *
 * Every draft write — REST, the MCP authoring tools, the wizard agent — lands
 * in `writeDraft`/`transition`/`deleteDraft`, all of which go through the one
 * shared store above. Bridging here is what lets those callers stop announcing
 * their own writes (the rule in shared/store-event-bridge.ts); the drafts
 * dialog reads the pushed record, so the event carries it.
 */
export function bridgeDraftEvents(logsDir: string, events: WorkspaceEventPublisher | undefined): void {
  const store = draftStore(logsDir)
  bridgeRecordEvents<DraftRecord>({
    source: store,
    events,
    // Seeded from disk so a restart doesn't re-announce every existing draft as
    // newly created.
    knownIds: () => store.list().map((e) => String(e.id)),
    load: (id) => store.get(id),
    created: (draft) => ({ type: 'draft-created', draft }),
    updated: (draft) => ({ type: 'draft-updated', draft }),
    removed: (draftId) => ({ type: 'draft-deleted', draftId }),
  })
}

/** Boot-time crash recovery — see the store's `reconcile` config above. */
export function reconcileInterruptedDrafts(logsDir: string, now: () => string): void {
  draftStore(logsDir).reconcileInterrupted(now)
}

export interface CreateDraftInput {
  draftId: string
  prdText: string
  additionalNotes?: string
  prdDocuments?: DraftPrdDocument[]
  repos: DraftRepo[]
  featureName?: string
  producer?: DraftSource
  externalStage?: ExternalDraftStage
  externalClientKind?: ClientKind
  externalSessionId?: string
  externalConversationName?: string
  externalSessionUrl?: string
  now?: () => string
}

export function createDraft(logsDir: string, input: CreateDraftInput): DraftRecord {
  const now = (input.now ?? (() => new Date().toISOString()))()
  const p = paths(logsDir, input.draftId)
  fs.mkdirSync(p.draftDir, { recursive: true })
  fs.writeFileSync(p.prdMd, input.prdText, 'utf8')
  const record: DraftRecord = {
    draftId: input.draftId,
    prdText: input.prdText,
    additionalNotes: input.additionalNotes,
    prdDocuments: input.prdDocuments ?? [],
    repos: input.repos,
    featureName: input.featureName,
    producer: input.producer,
    externalStage: input.externalStage,
    externalClientKind: input.externalClientKind,
    externalSessionId: input.externalSessionId,
    externalConversationName: input.externalConversationName,
    externalSessionUrl: input.externalSessionUrl,
    status: 'created',
    createdAt: now,
    updatedAt: now,
  }
  writeDraft(logsDir, record)
  return record
}

export function readDraft(logsDir: string, draftId: string): DraftRecord | null {
  return draftStore(logsDir).get(draftId)
}

export function writeDraft(logsDir: string, record: DraftRecord, now?: () => string): void {
  const next: DraftRecord = { ...record, updatedAt: (now ?? (() => new Date().toISOString()))() }
  draftStore(logsDir).save(next)
}

export function listDrafts(logsDir: string): DraftRecord[] {
  const store = draftStore(logsDir)
  return store
    .list()
    .map((e) => store.get(String(e.id)))
    .filter((r): r is DraftRecord => r !== null)
}

/** Follow a suite rename into wizard drafts, so a draft that targeted the old
 *  name keeps pointing at the same suite. Returns how many drafts moved. */
export function renameDraftFeature(logsDir: string, from: string, to: string): number {
  return draftStore(logsDir).renameFeature(from, to)
}

export class IllegalTransitionError extends Error {
  constructor(public readonly from: DraftStatus, public readonly to: DraftStatus) {
    super(`Illegal draft transition: ${from} → ${to}`)
  }
}

export function canTransition(from: DraftStatus, to: DraftStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export interface TransitionPatch {
  plan?: unknown
  intentSummary?: string
  generatedFiles?: string[]
  devDependencies?: string[]
  featureName?: string
  producer?: DraftSource
  externalStage?: ExternalDraftStage
  externalClientKind?: ClientKind
  externalSessionId?: string
  externalConversationName?: string
  externalSessionUrl?: string
  activeAgentStage?: 'planning' | 'generating'
  planAgentSessionId?: string
  planAgentSessionKind?: 'claude' | 'codex'
  errorMessage?: string
}

export function transition(
  logsDir: string,
  draftId: string,
  to: DraftStatus,
  patch: TransitionPatch = {},
  now?: () => string,
): DraftRecord {
  const rec = readDraft(logsDir, draftId)
  if (!rec) throw new Error(`Draft ${draftId} not found`)
  if (!canTransition(rec.status, to)) throw new IllegalTransitionError(rec.status, to)
  const next: DraftRecord = { ...rec, ...patch, status: to }
  writeDraft(logsDir, next, now)
  return next
}

export function deleteDraft(logsDir: string, draftId: string): boolean {
  const p = paths(logsDir, draftId)
  if (!fs.existsSync(p.draftDir)) return false
  // Drops the draft dir (sidecars included) AND the index entry.
  draftStore(logsDir).remove(draftId)
  return true
}

export type ValidateFeatureTargetResult =
  | { ok: true; featureDir: string }
  | { ok: false; error: 'feature-exists' | 'invalid-name'; featureDir?: string }

export function validateFeatureTarget(projectRoot: string, featureName: string): ValidateFeatureTargetResult {
  const result = validateScaffoldTarget(projectRoot, featureName)
  if (result.ok) return { ok: true, featureDir: result.featureDir }
  // shared.validateFeatureTarget only emits 'feature-exists' | 'invalid-name';
  // 'invalid-scaffold' is reserved for the apply path.
  return { ok: false, error: result.error as 'feature-exists' | 'invalid-name', featureDir: result.featureDir }
}
