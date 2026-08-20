import fs from 'fs'
import path from 'path'
import { createZip } from '../../../shared/simple-zip'
import { isClientKind } from '../../../../../../shared/run-mode'
import { FileBackedTaskStore, sharedTaskStore } from '../../../../../../shared/lib/file-backed-task-store'
import { bridgeRecordEvents } from '../../../shared/store-event-bridge'
import type { WorkspaceEventPublisher } from '../../../shared/workspace-events'
import type {
  EvaluationArchiveContents,
  EvaluationExportSessionRef,
  EvaluationExportTaskRecord,
  EvaluationExportTaskView,
} from './evaluation-export-types'

export type {
  EvaluationArchiveContents,
  EvaluationExportMode,
  EvaluationExportProducer,
  EvaluationExportSessionRef,
  EvaluationExportStatus,
  EvaluationExportTaskRecord,
  EvaluationExportTaskView,
} from './evaluation-export-types'

export interface EvaluationExportTaskPaths {
  taskDir: string
  taskJson: string
  logPath: string
  zipPath: string
}

export function evaluationExportsDir(logsDir: string): string {
  return path.join(logsDir, 'evaluation-exports')
}

export function evaluationExportTaskPaths(logsDir: string, taskId: string): EvaluationExportTaskPaths | null {
  if (!isSafeTaskId(taskId)) return null
  const root = evaluationExportsDir(logsDir)
  const taskDir = path.join(root, taskId)
  return {
    taskDir,
    taskJson: path.join(taskDir, 'task.json'),
    logPath: path.join(taskDir, 'export.log'),
    zipPath: path.join(taskDir, 'export.zip'),
  }
}

export function evalTaskStatusOf(r: EvaluationExportTaskRecord): string { return r.status }

// Record I/O delegates to the shared FileBackedTaskStore. Layout
// (evaluation-exports/<taskId>/task.json) matches `evaluationExportTaskPaths` so
// the per-task sidecars (export.log, export.zip) still live alongside the record.
// The isSafeTaskId guard stays at the free-function boundary so an unsafe id
// never reaches the store's path join.
// `sharedTaskStore`, not `new`: every accessor below calls this, and the store
// is what announces an export write to the workspace bus
// (bridgeEvaluationExportEvents). A fresh instance per call would emit into a
// listener set nobody holds.
function evalStore(logsDir: string): FileBackedTaskStore<EvaluationExportTaskRecord> {
  return sharedTaskStore<EvaluationExportTaskRecord>({
    logsDir,
    dirName: 'evaluation-exports',
    recordFile: 'task.json',
    idOf: (r) => r.taskId,
    statusOf: evalTaskStatusOf,
    validate: (raw) => normalizeTaskRecord(raw as EvaluationExportTaskRecord),
    indexEntryOf: (r) => ({
      id: r.taskId,
      createdAt: r.createdAt,
      taskId: r.taskId,
      runId: r.runId,
      feature: r.feature,
      status: r.status,
    }),
    // Legacy rows (pre-`id` index shape) carry only `taskId`; fall back to it so
    // remove/prune/reconcile can address them (else they resurrect on refresh).
    idOfEntry: (e) => (typeof e.id === 'string' ? e.id : (e as { taskId?: string }).taskId),
    featureOf: (r) => r.feature,
    withFeature: (r, feature) => ({ ...r, feature }),
    sortNewestFirst: true,
  })
}

/**
 * Attach the workspace bus to the export store, once per process.
 *
 * Same rule as drafts: every writer (the REST route, the MCP export tools, the
 * background rewrite job) goes through the shared store, so the store is what
 * announces. The event carries the task VIEW because the export dialog renders
 * it straight from the push.
 */
export function bridgeEvaluationExportEvents(
  logsDir: string,
  events: WorkspaceEventPublisher | undefined,
): void {
  const store = evalStore(logsDir)
  bridgeRecordEvents<EvaluationExportTaskRecord>({
    source: store,
    events,
    knownIds: () => store.list().map((e) => String(e.id)),
    load: (id) => store.get(id),
    created: (task) => ({ type: 'evaluation-export-created', task: evaluationExportTaskView(task) }),
    updated: (task) => ({ type: 'evaluation-export-updated', task: evaluationExportTaskView(task) }),
    removed: (taskId) => ({ type: 'evaluation-export-deleted', taskId }),
  })
}

export function createEvaluationExportTask(
  logsDir: string,
  record: EvaluationExportTaskRecord,
): EvaluationExportTaskRecord {
  writeEvaluationExportTask(logsDir, record)
  appendEvaluationExportLog(logsDir, record.taskId, '')
  return record
}

export function readEvaluationExportTask(logsDir: string, taskId: string): EvaluationExportTaskRecord | null {
  if (!isSafeTaskId(taskId)) return null
  const record = evalStore(logsDir).get(taskId)
  return record ? withArchiveSize(logsDir, record) : null
}

/** Exports built before the contents were recorded still have their zip on disk
 *  (cleanup never prunes these), so the SIZE is recoverable with a stat — and a
 *  reports list whose older rows show no size at all is the first thing a reader
 *  notices. The video count is not recoverable without unpacking the archive, so
 *  it stays absent rather than being guessed at as zero. Backfilled on read, not
 *  persisted: the record stays a description of what the export wrote. */
function withArchiveSize(logsDir: string, record: EvaluationExportTaskRecord): EvaluationExportTaskRecord {
  if (record.archive || !record.downloadReady) return record
  try {
    // Never null here: `normalizeTaskRecord` rejects any stored record whose own
    // `taskId` fails `isSafeTaskId`, which is the only thing the path build
    // validates. Asserting rather than branching keeps an arm no test could ever
    // reach out of the file — and if that invariant is ever broken, the throw
    // lands in the same catch, which already means "no size known".
    const paths = evaluationExportTaskPaths(logsDir, record.taskId)!
    return { ...record, archive: { bytes: fs.statSync(paths.zipPath).size, videos: 0, assets: 0 } }
  } catch {
    // The archive is gone (hand-deleted logs dir) — say nothing rather than 0 B.
    return record
  }
}

export function writeEvaluationExportTask(logsDir: string, record: EvaluationExportTaskRecord): void {
  if (!isSafeTaskId(record.taskId)) throw new Error(`Invalid evaluation export task id: ${record.taskId}`)
  evalStore(logsDir).save(record)
}

export function patchEvaluationExportTask(
  logsDir: string,
  taskId: string,
  patch: Partial<Omit<EvaluationExportTaskRecord, 'taskId'>>,
): EvaluationExportTaskRecord | null {
  const current = readEvaluationExportTask(logsDir, taskId)
  if (!current) return null
  const next: EvaluationExportTaskRecord = {
    ...current,
    ...patch,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  }
  writeEvaluationExportTask(logsDir, next)
  return next
}

export function listEvaluationExportTasks(
  logsDir: string,
  opts: { runId?: string } = {},
): EvaluationExportTaskRecord[] {
  const store = evalStore(logsDir)
  return store
    .list()
    .map((e) => store.get(String(e.id)))
    .filter((task): task is EvaluationExportTaskRecord => task !== null)
    .filter((task) => !opts.runId || task.runId === opts.runId)
}

/** Follow a suite rename into export history, so past exports stay attached to
 *  the feature that produced them. Returns how many tasks moved. */
export function renameEvaluationExportFeature(logsDir: string, from: string, to: string): number {
  return evalStore(logsDir).renameFeature(from, to)
}

export function appendEvaluationExportLog(logsDir: string, taskId: string, chunk: string): void {
  const p = evaluationExportTaskPaths(logsDir, taskId)
  if (!p) return
  fs.mkdirSync(p.taskDir, { recursive: true })
  fs.appendFileSync(p.logPath, chunk, 'utf8')
}

export function readEvaluationExportLog(logsDir: string, taskId: string): string {
  const p = evaluationExportTaskPaths(logsDir, taskId)
  if (!p || !fs.existsSync(p.logPath)) return ''
  return fs.readFileSync(p.logPath, 'utf8')
}

export function writeEvaluationExportZip(logsDir: string, taskId: string, zip: Buffer): void {
  const p = evaluationExportTaskPaths(logsDir, taskId)
  if (!p) throw new Error(`Invalid evaluation export task id: ${taskId}`)
  fs.mkdirSync(p.taskDir, { recursive: true })
  fs.writeFileSync(p.zipPath, zip)
}

export function writeEvaluationExportFilesZip(
  logsDir: string,
  taskId: string,
  files: Array<{ path: string; content: string }>,
): void {
  const entries = files.map((file) => {
    const normalized = validateArchivePath(file.path)
    return { filename: normalized, data: Buffer.from(file.content, 'utf8') }
  })
  writeEvaluationExportZip(logsDir, taskId, createZip(entries))
}

export function readEvaluationExportZip(logsDir: string, taskId: string): Buffer | null {
  const p = evaluationExportTaskPaths(logsDir, taskId)
  if (!p || !fs.existsSync(p.zipPath)) return null
  return fs.readFileSync(p.zipPath)
}

export function deleteEvaluationExportTask(logsDir: string, taskId: string): boolean {
  const p = evaluationExportTaskPaths(logsDir, taskId)
  if (!p || !fs.existsSync(p.taskDir)) return false
  // Drops the task dir (export.log/export.zip included) AND the index entry.
  evalStore(logsDir).remove(taskId)
  return true
}

export function evaluationExportTaskView(record: EvaluationExportTaskRecord): EvaluationExportTaskView {
  return {
    taskId: record.taskId,
    runId: record.runId,
    feature: record.feature,
    mode: record.mode,
    producer: record.producer ?? 'internal',
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    downloadReady: record.downloadReady,
    ...(record.clientKind ? { clientKind: record.clientKind } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.conversationName ? { conversationName: record.conversationName } : {}),
    ...(record.language ? { language: record.language } : {}),
    ...(record.externalSessionUrl ? { externalSessionUrl: record.externalSessionUrl } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.sessionRef ? { sessionRef: record.sessionRef } : {}),
    ...(record.archive ? { archive: record.archive } : {}),
  }
}

function normalizeTaskRecord(value: EvaluationExportTaskRecord): EvaluationExportTaskRecord | null {
  if (!value || typeof value !== 'object') return null
  if (!isSafeTaskId(value.taskId)) return null
  if (typeof value.runId !== 'string') return null
  if (typeof value.feature !== 'string') return null
  if (value.mode !== 'raw' && value.mode !== 'localized') return null
  if (value.producer !== undefined && value.producer !== 'internal' && value.producer !== 'external') return null
  if (value.status !== 'running' && value.status !== 'completed' && value.status !== 'failed') return null
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null
  if (typeof value.downloadReady !== 'boolean') return null
  if (typeof value.archiveBase !== 'string') return null
  if (value.clientKind !== undefined && !isClientKind(value.clientKind)) return null
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') return null
  if (value.conversationName !== undefined && typeof value.conversationName !== 'string') return null
  if (value.language !== undefined && typeof value.language !== 'string') return null
  if (value.externalSessionUrl !== undefined && typeof value.externalSessionUrl !== 'string') return null
  if (value.error !== undefined && typeof value.error !== 'string') return null
  if (value.sessionRef !== undefined && !isSessionRef(value.sessionRef)) return null
  if (value.archive !== undefined && !isArchiveContents(value.archive)) return null
  return { ...value, producer: value.producer ?? 'internal' }
}

function isSafeTaskId(taskId: string): boolean {
  return /^eval-[a-z0-9-]+$/.test(taskId)
}

function isSessionRef(value: unknown): value is EvaluationExportSessionRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  return (ref.agent === 'claude' || ref.agent === 'codex') && typeof ref.sessionId === 'string'
}

function isArchiveContents(value: unknown): value is EvaluationArchiveContents {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return typeof c.bytes === 'number' && typeof c.videos === 'number' && typeof c.assets === 'number'
}

function validateArchivePath(filePath: string): string {
  if (!filePath) throw new Error('archive file path empty')
  if (path.isAbsolute(filePath)) throw new Error(`archive file path "${filePath}" must be relative`)
  const normalized = path.posix.normalize(filePath.split(path.sep).join('/'))
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`archive file path "${filePath}" must stay inside the archive`)
  }
  return normalized
}
