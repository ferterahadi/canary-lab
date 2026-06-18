import fs from 'fs'
import path from 'path'
import { createZip } from './simple-zip'
import type { ExternalHealClientKind } from './runtime/manifest'

export type EvaluationExportMode = 'raw' | 'localized'
export type EvaluationExportStatus = 'running' | 'completed' | 'failed'
export type EvaluationExportProducer = 'internal' | 'external'

export interface EvaluationExportTaskRecord {
  taskId: string
  runId: string
  feature: string
  mode: EvaluationExportMode
  producer?: EvaluationExportProducer
  status: EvaluationExportStatus
  createdAt: string
  updatedAt: string
  downloadReady: boolean
  archiveBase: string
  clientKind?: ExternalHealClientKind
  sessionId?: string
  conversationName?: string
  language?: string
  externalSessionUrl?: string
  error?: string
  /** Set once the localized-rewrite agent is spawned, so the export dialog can
   *  stream its JSONL through AgentSessionView (claude: a pinned session id;
   *  codex: '' — located by cwd + start). Absent for raw/external/cached runs,
   *  which have no live agent and keep the text progress panel. */
  sessionRef?: EvaluationExportSessionRef
}

export interface EvaluationExportSessionRef {
  agent: 'claude' | 'codex'
  sessionId: string
}

export interface EvaluationExportTaskView {
  taskId: string
  runId: string
  feature: string
  mode: EvaluationExportMode
  producer: EvaluationExportProducer
  status: EvaluationExportStatus
  createdAt: string
  updatedAt: string
  downloadReady: boolean
  clientKind?: ExternalHealClientKind
  sessionId?: string
  conversationName?: string
  language?: string
  externalSessionUrl?: string
  error?: string
  sessionRef?: EvaluationExportSessionRef
}

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

export function createEvaluationExportTask(
  logsDir: string,
  record: EvaluationExportTaskRecord,
): EvaluationExportTaskRecord {
  writeEvaluationExportTask(logsDir, record)
  appendEvaluationExportLog(logsDir, record.taskId, '')
  return record
}

export function readEvaluationExportTask(logsDir: string, taskId: string): EvaluationExportTaskRecord | null {
  const p = evaluationExportTaskPaths(logsDir, taskId)
  if (!p || !fs.existsSync(p.taskJson)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(p.taskJson, 'utf8')) as EvaluationExportTaskRecord
    return normalizeTaskRecord(parsed)
  } catch {
    return null
  }
}

export function writeEvaluationExportTask(logsDir: string, record: EvaluationExportTaskRecord): void {
  const p = evaluationExportTaskPaths(logsDir, record.taskId)
  if (!p) throw new Error(`Invalid evaluation export task id: ${record.taskId}`)
  fs.mkdirSync(p.taskDir, { recursive: true })
  const tmp = `${p.taskJson}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, p.taskJson)
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
  const root = evaluationExportsDir(logsDir)
  if (!fs.existsSync(root)) return []
  const out: EvaluationExportTaskRecord[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const task = readEvaluationExportTask(logsDir, entry.name)
    if (!task) continue
    if (opts.runId && task.runId !== opts.runId) continue
    out.push(task)
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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
  fs.rmSync(p.taskDir, { recursive: true, force: true })
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
  if (value.clientKind !== undefined && !isExternalHealClientKind(value.clientKind)) return null
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') return null
  if (value.conversationName !== undefined && typeof value.conversationName !== 'string') return null
  if (value.language !== undefined && typeof value.language !== 'string') return null
  if (value.externalSessionUrl !== undefined && typeof value.externalSessionUrl !== 'string') return null
  if (value.error !== undefined && typeof value.error !== 'string') return null
  if (value.sessionRef !== undefined && !isSessionRef(value.sessionRef)) return null
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

function validateArchivePath(filePath: string): string {
  if (!filePath) throw new Error('archive file path empty')
  if (path.isAbsolute(filePath)) throw new Error(`archive file path "${filePath}" must be relative`)
  const normalized = path.posix.normalize(filePath.split(path.sep).join('/'))
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`archive file path "${filePath}" must stay inside the archive`)
  }
  return normalized
}

function isExternalHealClientKind(value: unknown): value is ExternalHealClientKind {
  return value === 'claude-cli' ||
    value === 'claude-desktop' ||
    value === 'codex-cli' ||
    value === 'codex-desktop' ||
    value === 'other'
}
