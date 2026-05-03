import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveLogPath } from './pane-stream'
import { writeManifest } from '../lib/runtime/manifest'
import { runDirFor, buildRunPaths } from '../lib/runtime/run-paths'

let logsDir: string
const runId = 'r-pane-test'

beforeEach(() => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-pane-')))
  const dir = runDirFor(logsDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(path.join(dir, 'manifest.json'), {
    runId,
    feature: 'foo',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'passed',
    healCycles: 0,
    services: [
      { name: 'api', safeName: 'api', command: 'noop', cwd: '/', logPath: '/tmp/x', healthUrl: undefined },
    ],
  })
})

describe('resolveLogPath', () => {
  it('returns null when run dir is missing', () => {
    expect(resolveLogPath(logsDir, 'no-such-run', 'playwright')).toBeNull()
  })

  it('maps "playwright" to playwright.log', () => {
    const expected = buildRunPaths(runDirFor(logsDir, runId)).playwrightStdoutPath
    expect(resolveLogPath(logsDir, runId, 'playwright')).toBe(expected)
  })

  it('maps "agent" to agent-transcript.log', () => {
    const expected = buildRunPaths(runDirFor(logsDir, runId)).agentTranscriptPath
    expect(resolveLogPath(logsDir, runId, 'agent')).toBe(expected)
  })

  it('maps "service:<safeName>" to svc-<safeName>.log when service is in manifest', () => {
    const expected = buildRunPaths(runDirFor(logsDir, runId)).serviceLog('api')
    expect(resolveLogPath(logsDir, runId, 'service:api')).toBe(expected)
  })

  it('returns null for service paneId not present in manifest (no path traversal)', () => {
    expect(resolveLogPath(logsDir, runId, 'service:../../etc/passwd')).toBeNull()
    expect(resolveLogPath(logsDir, runId, 'service:unknown')).toBeNull()
  })

  it('returns null for empty service safeName', () => {
    expect(resolveLogPath(logsDir, runId, 'service:')).toBeNull()
  })

  it('returns null for unknown paneId', () => {
    expect(resolveLogPath(logsDir, runId, 'random')).toBeNull()
  })
})
