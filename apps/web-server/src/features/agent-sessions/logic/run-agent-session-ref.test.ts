import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { buildRunPaths } from '../../runs/logic/runtime/run-paths'
import { claudeSessionLogPath } from './agent-session-paths'
import { resolveRunAgentSessionRef } from './run-agent-session-ref'

const tempDir = trackTempDirs('run-session-ref-')
let runDir: string
let refPath: string
beforeEach(() => {
  const home = tempDir()
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, 'claude'))
  vi.stubEnv('CODEX_HOME', path.join(home, 'codex'))
  runDir = path.join(home, 'run')
  fs.mkdirSync(runDir)
  refPath = buildRunPaths(runDir).agentSessionRefPath
})
afterEach(() => vi.unstubAllEnvs())

describe('resolveRunAgentSessionRef', () => {
  it('returns absence for missing, unreadable, empty, and malformed references', () => {
    expect(resolveRunAgentSessionRef(runDir)).toBeNull()
    fs.mkdirSync(refPath) // A directory is unreadable as a UTF-8 reference file.
    expect(resolveRunAgentSessionRef(runDir)).toBeNull()
    fs.rmdirSync(refPath)
    for (const raw of ['', '{', '{}']) {
      fs.writeFileSync(refPath, raw)
      expect(resolveRunAgentSessionRef(runDir)).toBeNull()
    }
  })

  it('retains a legacy reference before its log appears', () => {
    const ref = { agent: 'claude', sessionId: 'legacy', logPath: path.join(runDir, 'later.jsonl') }
    fs.writeFileSync(refPath, JSON.stringify(ref))
    expect(resolveRunAgentSessionRef(runDir)).toEqual(ref)
  })

  it('preserves active-agent and sparse multi-agent fallback selection', () => {
    const claude = { agent: 'claude', sessionId: 'c', logPath: path.join(runDir, 'c.jsonl') }
    const codex = { agent: 'codex', sessionId: 'x', logPath: path.join(runDir, 'x.jsonl') }
    for (const [record, expected] of [
      [{ activeAgent: 'claude', sessions: { claude, codex } }, claude],
      [{ sessions: { claude, codex } }, codex],
      [{ activeAgent: 'codex', sessions: { claude } }, claude],
    ]) {
      fs.writeFileSync(refPath, JSON.stringify(record))
      expect(resolveRunAgentSessionRef(runDir)).toEqual(expected)
    }
  })

  it('rediscovers newer logs and prefers them to the persisted reference', () => {
    fs.writeFileSync(refPath, JSON.stringify({ agent: 'codex', sessionId: 'stale', logPath: '/missing' }))
    const first = claudeSessionLogPath(runDir, 'first')
    fs.mkdirSync(path.dirname(first), { recursive: true })
    fs.writeFileSync(first, '')
    fs.utimesSync(first, 100, 100)
    expect(resolveRunAgentSessionRef(runDir)?.sessionId).toBe('first')
    const second = claudeSessionLogPath(runDir, 'second')
    fs.writeFileSync(second, '')
    fs.utimesSync(second, 200, 200)
    expect(resolveRunAgentSessionRef(runDir)).toEqual({ agent: 'claude', sessionId: 'second', logPath: second })
    fs.writeFileSync(refPath, '{')
    expect(resolveRunAgentSessionRef(runDir)?.sessionId).toBe('second')
  })
})
