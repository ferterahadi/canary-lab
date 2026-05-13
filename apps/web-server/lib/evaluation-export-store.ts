import fs from 'fs'
import path from 'path'

export type EvaluationExportMode = 'raw' | 'localized'
export type EvaluationExportStatus = 'running' | 'completed' | 'failed'

export interface EvaluationExportTaskRecord {
  taskId: string
  runId: string
  feature: string
  mode: EvaluationExportMode
  status: EvaluationExportStatus
  createdAt: string
  updatedAt: string
  downloadReady: boolean
  archiveBase: string
  error?: string
}

export interface EvaluationExportTaskView {
  taskId: string
  runId: string
  feature: string
  mode: EvaluationExportMode
  status: EvaluationExportStatus
  createdAt: string
  updatedAt: string
  downloadReady: boolean
  error?: string
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
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    downloadReady: record.downloadReady,
    ...(record.error ? { error: record.error } : {}),
  }
}

function normalizeTaskRecord(value: EvaluationExportTaskRecord): EvaluationExportTaskRecord | null {
  if (!value || typeof value !== 'object') return null
  if (!isSafeTaskId(value.taskId)) return null
  if (typeof value.runId !== 'string') return null
  if (typeof value.feature !== 'string') return null
  if (value.mode !== 'raw' && value.mode !== 'localized') return null
  if (value.status !== 'running' && value.status !== 'completed' && value.status !== 'failed') return null
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null
  if (typeof value.downloadReady !== 'boolean') return null
  if (typeof value.archiveBase !== 'string') return null
  if (value.error !== undefined && typeof value.error !== 'string') return null
  return value
}

function isSafeTaskId(taskId: string): boolean {
  return /^eval-[a-z0-9-]+$/.test(taskId)
}
