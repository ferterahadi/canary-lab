import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  evaluationExportsDir,
  evaluationExportTaskPaths,
  createEvaluationExportTask,
  readEvaluationExportTask,
  writeEvaluationExportTask,
  patchEvaluationExportTask,
  listEvaluationExportTasks,
  appendEvaluationExportLog,
  readEvaluationExportLog,
  writeEvaluationExportZip,
  readEvaluationExportZip,
  deleteEvaluationExportTask,
  evaluationExportTaskView,
  writeEvaluationExportFilesZip,
  type EvaluationExportTaskRecord,
} from './evaluation-export-store'

let tmpDir: string
const ID = 'eval-task-abc'
const BAD = 'not-valid-id'

function makeRecord(overrides: Partial<EvaluationExportTaskRecord> = {}): EvaluationExportTaskRecord {
  return {
    taskId: ID,
    runId: 'run-1',
    feature: 'feat',
    mode: 'raw',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    downloadReady: false,
    archiveBase: 'archive',
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-export-'))
})

describe('evaluation-export-store', () => {
  it('returns null paths for invalid taskId', () => {
    expect(evaluationExportTaskPaths(tmpDir, BAD)).toBeNull()
  })

  it('writeEvaluationExportTask throws on invalid id', () => {
    expect(() => writeEvaluationExportTask(tmpDir, makeRecord({ taskId: BAD }))).toThrow()
  })

  it('writeEvaluationExportZip throws on invalid id', () => {
    expect(() => writeEvaluationExportZip(tmpDir, BAD, Buffer.from('x'))).toThrow()
  })

  it('readEvaluationExportZip returns null for invalid id and missing file', () => {
    expect(readEvaluationExportZip(tmpDir, BAD)).toBeNull()
    expect(readEvaluationExportZip(tmpDir, ID)).toBeNull()
  })

  it('readEvaluationExportLog returns empty for invalid id and missing file', () => {
    expect(readEvaluationExportLog(tmpDir, BAD)).toBe('')
    expect(readEvaluationExportLog(tmpDir, ID)).toBe('')
  })

  it('appendEvaluationExportLog no-ops for invalid id', () => {
    appendEvaluationExportLog(tmpDir, BAD, 'noop')
    expect(fs.existsSync(path.join(evaluationExportsDir(tmpDir), BAD))).toBe(false)
  })

  it('patchEvaluationExportTask returns null when task missing', () => {
    expect(patchEvaluationExportTask(tmpDir, ID, { status: 'completed' })).toBeNull()
  })

  it('readEvaluationExportTask returns null for invalid id', () => {
    expect(readEvaluationExportTask(tmpDir, BAD)).toBeNull()
  })

  it('readEvaluationExportTask returns null on malformed JSON', () => {
    const p = evaluationExportTaskPaths(tmpDir, ID)!
    fs.mkdirSync(p.taskDir, { recursive: true })
    fs.writeFileSync(p.taskJson, '{not valid json', 'utf8')
    expect(readEvaluationExportTask(tmpDir, ID)).toBeNull()
  })

  it('readEvaluationExportTask rejects non-object payloads', () => {
    const p = evaluationExportTaskPaths(tmpDir, ID)!
    fs.mkdirSync(p.taskDir, { recursive: true })
    fs.writeFileSync(p.taskJson, 'null', 'utf8')
    expect(readEvaluationExportTask(tmpDir, ID)).toBeNull()
  })

  it('readEvaluationExportTask rejects records with bad fields', () => {
    const p = evaluationExportTaskPaths(tmpDir, ID)!
    fs.mkdirSync(p.taskDir, { recursive: true })
    const variants = [
      { taskId: BAD, runId: 'r', feature: 'f', mode: 'raw', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x' },
      { taskId: ID, runId: 123, feature: 'f', mode: 'raw', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x' },
      { taskId: ID, runId: 'r', feature: 123, mode: 'raw', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x' },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'wat', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x' },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'raw', status: 'wat', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x' },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'raw', status: 'running', createdAt: 1, updatedAt: 'b', downloadReady: false, archiveBase: 'x' },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'raw', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: 'no', archiveBase: 'x' },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'raw', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 123 },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'raw', producer: 'partner', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x' },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'raw', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x', clientKind: 'browser' },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'raw', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x', sessionId: 7 },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'raw', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x', conversationName: 7 },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'raw', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x', language: 7 },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'raw', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x', externalSessionUrl: 7 },
      { taskId: ID, runId: 'r', feature: 'f', mode: 'raw', status: 'running', createdAt: 'a', updatedAt: 'b', downloadReady: false, archiveBase: 'x', error: 7 },
    ]
    for (const v of variants) {
      fs.writeFileSync(p.taskJson, JSON.stringify(v), 'utf8')
      expect(readEvaluationExportTask(tmpDir, ID)).toBeNull()
    }
  })

  it('full lifecycle: create, patch, list, log, zip, view, delete', () => {
    const created = createEvaluationExportTask(tmpDir, makeRecord())
    expect(created.taskId).toBe(ID)
    expect(readEvaluationExportTask(tmpDir, ID)).not.toBeNull()

    appendEvaluationExportLog(tmpDir, ID, 'hello\n')
    appendEvaluationExportLog(tmpDir, ID, 'world\n')
    expect(readEvaluationExportLog(tmpDir, ID)).toBe('hello\nworld\n')

    writeEvaluationExportZip(tmpDir, ID, Buffer.from('zipdata'))
    expect(readEvaluationExportZip(tmpDir, ID)?.toString()).toBe('zipdata')

    const patched = patchEvaluationExportTask(tmpDir, ID, { status: 'completed', downloadReady: true })
    expect(patched?.status).toBe('completed')
    expect(patched?.downloadReady).toBe(true)

    const patchedWithUpdated = patchEvaluationExportTask(tmpDir, ID, { updatedAt: '2026-02-02T00:00:00.000Z' })
    expect(patchedWithUpdated?.updatedAt).toBe('2026-02-02T00:00:00.000Z')

    const view = evaluationExportTaskView(patched!)
    expect(view).toMatchObject({ taskId: ID, status: 'completed', downloadReady: true })
    expect(view.error).toBeUndefined()
    const failed = evaluationExportTaskView(makeRecord({
      status: 'failed',
      error: 'boom',
      externalSessionUrl: 'https://codex.example/session',
    }))
    expect(failed.error).toBe('boom')
    expect(failed.externalSessionUrl).toBe('https://codex.example/session')

    const second = createEvaluationExportTask(tmpDir, makeRecord({ taskId: 'eval-task-zzz', runId: 'run-2' }))
    expect(second).toBeTruthy()

    // Drop a non-directory entry and a bogus directory to exercise list filters
    fs.writeFileSync(path.join(evaluationExportsDir(tmpDir), 'stray.txt'), 'x', 'utf8')
    const bogusDir = path.join(evaluationExportsDir(tmpDir), 'bogus')
    fs.mkdirSync(bogusDir, { recursive: true })

    const all = listEvaluationExportTasks(tmpDir)
    expect(all.map(t => t.taskId).sort()).toEqual(['eval-task-abc', 'eval-task-zzz'])

    const filtered = listEvaluationExportTasks(tmpDir, { runId: 'run-2' })
    expect(filtered.map(t => t.taskId)).toEqual(['eval-task-zzz'])

    expect(deleteEvaluationExportTask(tmpDir, ID)).toBe(true)
    expect(deleteEvaluationExportTask(tmpDir, ID)).toBe(false)
    expect(deleteEvaluationExportTask(tmpDir, BAD)).toBe(false)
  })

  it('listEvaluationExportTasks returns [] when root missing', () => {
    expect(listEvaluationExportTasks(tmpDir)).toEqual([])
  })

  it('validates archive paths before writing generated files zip', () => {
    expect(() => writeEvaluationExportFilesZip(tmpDir, ID, [{ path: '', content: 'x' }]))
      .toThrow('archive file path empty')
    expect(() => writeEvaluationExportFilesZip(tmpDir, ID, [{ path: '/tmp/out.txt', content: 'x' }]))
      .toThrow('must be relative')
    expect(() => writeEvaluationExportFilesZip(tmpDir, ID, [{ path: '../out.txt', content: 'x' }]))
      .toThrow('must stay inside the archive')
    expect(() => writeEvaluationExportFilesZip(tmpDir, ID, [{ path: 'nested/out.txt', content: 'x' }]))
      .not.toThrow()
    expect(readEvaluationExportZip(tmpDir, ID)).not.toBeNull()
  })

  it('accepts every external client kind in persisted task metadata', () => {
    for (const clientKind of ['claude-cli', 'claude-desktop', 'codex-cli', 'codex-desktop', 'other'] as const) {
      writeEvaluationExportTask(tmpDir, makeRecord({ taskId: `eval-${clientKind}`, clientKind }))
      expect(readEvaluationExportTask(tmpDir, `eval-${clientKind}`)?.clientKind).toBe(clientKind)
    }
  })
})
