import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createExternalEvaluationExportTask,
  evaluationArchiveBase,
  newEvaluationTaskId,
  safeFilename,
} from './external-evaluation-export'
import { readEvaluationExportTask } from './evaluation-export-store'
import { detail } from './__fixtures__/test-review-fixtures'

// The shared task-lifecycle helpers behind BOTH external-export surfaces (the
// MCP tool pair and the flight's hand-off). The completion path is exercised
// end-to-end by the flight stage tests (stages.evaluation-export.test.ts) and
// the MCP tool tests; this file pins the small argument arms those callers
// don't all reach.

let tmpDir: string
let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ext-eval-')))
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('safeFilename / archive base', () => {
  it('collapses unsafe characters and never yields an empty name', () => {
    expect(safeFilename('my feature!')).toBe('my-feature')
    expect(safeFilename('***')).toBe('export')
    expect(evaluationArchiveBase('checkout flow', 'run/1')).toBe('canary-lab-evaluation-checkout-flow-run-1')
  })

  it('mints distinct eval- task ids', () => {
    const a = newEvaluationTaskId()
    expect(a).toMatch(/^eval-/)
    expect(newEvaluationTaskId()).not.toBe(a)
  })
})

describe('createExternalEvaluationExportTask', () => {
  it('persists the full external record when every optional is supplied', () => {
    const task = createExternalEvaluationExportTask({
      logsDir,
      detail: detail({ featureDir: tmpDir }),
      sessionId: 'sess-1',
      clientKind: 'claude',
      conversationName: 'export chat',
      language: 'German',
      sessionUrl: 'https://example.test/session',
      now: () => '2026-01-01T00:00:00Z',
      newTaskId: () => 'eval-fixed',
    })
    expect(task).toMatchObject({
      taskId: 'eval-fixed',
      producer: 'external',
      mode: 'localized',
      clientKind: 'claude',
      conversationName: 'export chat',
      language: 'German',
      externalSessionUrl: 'https://example.test/session',
      archiveBase: 'canary-lab-evaluation-checkout-run-1',
    })
    // Persisted, not just returned — the flight's re-adopt reads it back.
    expect(readEvaluationExportTask(logsDir, 'eval-fixed')).toMatchObject({ sessionId: 'sess-1' })
  })

  it('does not persist blank optional external-session fields', () => {
    const task = createExternalEvaluationExportTask({
      logsDir,
      detail: detail({ featureDir: tmpDir }),
      sessionId: 'sess-2',
      clientKind: undefined,
      conversationName: '',
      language: '',
      sessionUrl: '',
      now: () => '2026-01-01T00:00:00Z',
      newTaskId: () => 'eval-minimal',
    })
    expect(task).toMatchObject({ taskId: 'eval-minimal', sessionId: 'sess-2' })
    expect(task).not.toHaveProperty('clientKind')
    expect(task).not.toHaveProperty('conversationName')
    expect(task).not.toHaveProperty('language')
    expect(task).not.toHaveProperty('externalSessionUrl')
  })
})
