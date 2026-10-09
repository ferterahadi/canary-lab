import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { formatHistoricalPaneReplay, replayLogFile, resolveLogPath, shouldPreferLogReplay, shouldReplayLogFile } from './pane-stream'
import { writeManifest } from '../logic/runtime/manifest'
import { runDirFor, buildRunPaths } from '../logic/runtime/run-paths'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-pane-')

let logsDir: string
const runId = 'r-pane-test'

beforeEach(() => {
  logsDir = tempDir()
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

  it('returns null for "agent" — the historical view reads the agent CLI session log via /api/runs/:runId/agent-session', () => {
    expect(resolveLogPath(logsDir, runId, 'agent')).toBeNull()
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

describe('shouldReplayLogFile', () => {
  it('uses on-disk logs for terminal runs so replay is not capped by the live broker buffer', () => {
    expect(shouldReplayLogFile(logsDir, runId)).toBe(true)
  })

  it('keeps active runs on the live broker', () => {
    writeManifest(path.join(runDirFor(logsDir, runId), 'manifest.json'), {
      runId,
      feature: 'foo',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'healing',
      healCycles: 1,
      services: [],
    })

    expect(shouldReplayLogFile(logsDir, runId)).toBe(false)
  })
})

describe('shouldPreferLogReplay', () => {
  it('does not replay the historical log while a restarted heal orchestrator is active', () => {
    expect(shouldPreferLogReplay(logsDir, runId, true)).toBe(false)
  })

  it('replays the historical log for terminal runs with no active orchestrator', () => {
    expect(shouldPreferLogReplay(logsDir, runId, false)).toBe(true)
  })
})

describe('formatHistoricalPaneReplay', () => {
  it('returns the raw bytes unchanged for every paneId — historical agent view goes through the structured route', () => {
    expect(formatHistoricalPaneReplay('playwright', '\x1b[31mred\x1b[0m')).toBe('\x1b[31mred\x1b[0m')
    expect(formatHistoricalPaneReplay('service:api', '\x1b[31mred\x1b[0m')).toBe('\x1b[31mred\x1b[0m')
  })
})

describe('replayLogFile', () => {
  it('does not throw when the socket closed before the replay sends — the closed socket gets no retry send', () => {
    fs.writeFileSync(buildRunPaths(runDirFor(logsDir, runId)).playwrightStdoutPath, 'line\n')
    const attempts: string[] = []
    let closed = 0
    const socket = {
      send: (message: string) => { attempts.push(message); throw new Error('socket closed') },
      close: () => { closed += 1 },
    }

    expect(replayLogFile(socket, logsDir, runId, 'playwright')).toBe(true)
    expect(attempts.map((m) => JSON.parse(m).type)).toEqual(['data', 'exit'])
    expect(closed).toBe(1)
  })

  it('reports an unreadable log as an error frame', () => {
    const logPath = buildRunPaths(runDirFor(logsDir, runId)).playwrightStdoutPath
    fs.mkdirSync(logPath, { recursive: true })
    const frames: unknown[] = []
    const socket = { send: (message: string) => { frames.push(JSON.parse(message)) }, close: () => {} }

    expect(replayLogFile(socket, logsDir, runId, 'playwright')).toBe(true)
    expect(frames).toEqual([{ type: 'error', error: 'log not available' }])
  })
})
