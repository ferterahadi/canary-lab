import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  encodeClaudeProjectDir,
  claudeConfigDir,
  codexConfigDir,
  claudeSessionLogPath,
  locateClaudeSessionLog,
  findClaudeLogBySessionId,
  locateLatestClaudeSessionLog,
  locateCodexSessionLog,
  locateLatestCodexSessionLog,
  locateLatestSessionLogForAgent,
  locateMostRecentAgentSessionRef,
  loadAgentSessionLog,
  loadAgentSession,
  loadAgentSessionMeta,
  parseAgentSessionRefFile,
  renderAgentSessionContext,
  buildFullSessionTranscript,
  writeFullSessionTranscript,
  selectAgentSessionRef,
  resolveManifestSessionRef,
  writeWorkflowAgentRef,
  resolveWorkflowAgentRef,
  buildAgentSessionResponse,
  parseAgentSessionLine,
  loadSubagentThread,
  loadSubagentThreads,
  subagentDirFor,
} from './agent-session-log'

let homeDir: string

beforeEach(() => {
  homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-home-')))
})

afterEach(() => {
  try { fs.rmSync(homeDir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

// ─── Subagent threads ───────────────────────────────────────────────────────

/** Build a claude session log plus N subagent threads beside it, mirroring the
 *  real on-disk layout: <log-dir>/<uuid>/subagents/agent-<id>.{jsonl,meta.json}. */
function writeSessionWithSubagents(
  sessionId: string,
  parentLines: unknown[],
  children: Array<{ agentId: string; meta: Record<string, unknown>; lines: unknown[] }>,
): { agent: 'claude'; sessionId: string; logPath: string } {
  const projectDir = path.join(homeDir, '.claude', 'projects', 'proj')
  fs.mkdirSync(projectDir, { recursive: true })
  const logPath = path.join(projectDir, `${sessionId}.jsonl`)
  fs.writeFileSync(logPath, parentLines.map((l) => JSON.stringify(l)).join('\n'))
  const subDir = path.join(projectDir, sessionId, 'subagents')
  fs.mkdirSync(subDir, { recursive: true })
  for (const c of children) {
    fs.writeFileSync(path.join(subDir, `${c.agentId}.jsonl`), c.lines.map((l) => JSON.stringify(l)).join('\n'))
    fs.writeFileSync(path.join(subDir, `${c.agentId}.meta.json`), JSON.stringify(c.meta))
  }
  return { agent: 'claude', sessionId, logPath }
}

const assistantLine = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] }, ...extra,
})

describe('subagentDirFor', () => {
  it('derives <log-without-.jsonl>/subagents for claude', () => {
    const ref = { agent: 'claude' as const, sessionId: 's', logPath: '/logs/abc.jsonl' }
    expect(subagentDirFor(ref)).toBe(path.join('/logs/abc', 'subagents'))
  })

  it('returns null for codex — it has no subagent concept', () => {
    expect(subagentDirFor({ agent: 'codex', sessionId: 's', logPath: '/logs/x.jsonl' })).toBeNull()
  })

  it('returns null when the ref has no log path yet', () => {
    expect(subagentDirFor({ agent: 'claude', sessionId: 's', logPath: '' })).toBeNull()
  })

  it('appends to a log path that is not .jsonl-suffixed rather than truncating it', () => {
    expect(subagentDirFor({ agent: 'claude', sessionId: 's', logPath: '/logs/abc' }))
      .toBe(path.join('/logs/abc', 'subagents'))
  })
})

describe('loadSubagentThreads', () => {
  it('joins each thread to its parent tool call by toolUseId', () => {
    const ref = writeSessionWithSubagents('sess-sub', [assistantLine('2026-07-21T11:31:12.000Z', 'spawning')], [
      {
        agentId: 'agent-aaa',
        meta: { agentType: 'Explore', description: 'search mpass', toolUseId: 'toolu_1', spawnDepth: 1 },
        lines: [assistantLine('2026-07-21T11:31:20.000Z', 'looking')],
      },
      {
        agentId: 'agent-bbb',
        meta: { agentType: 'Explore', description: 'search fnb', toolUseId: 'toolu_2', spawnDepth: 1 },
        lines: [assistantLine('2026-07-21T11:31:22.000Z', 'reading')],
      },
    ])
    const threads = loadSubagentThreads(ref)
    expect(threads.map((t) => t.parentToolId)).toEqual(['toolu_1', 'toolu_2'])
    expect(threads[0].agentType).toBe('Explore')
    expect(threads[0].description).toBe('search mpass')
    expect(threads[0].events).toHaveLength(1)
    expect(threads[1].events[0]).toMatchObject({ kind: 'assistant-message', text: 'reading' })
  })

  it('drops a thread whose meta carries no toolUseId — it has no parent to hang under', () => {
    const ref = writeSessionWithSubagents('sess-nojoin', [], [
      { agentId: 'agent-orphan', meta: { agentType: 'Explore' }, lines: [assistantLine('2026-07-21T11:00:00.000Z', 'hi')] },
    ])
    expect(loadSubagentThreads(ref)).toEqual([])
  })

  it('returns empty for codex and for a session that spawned nothing', () => {
    const ref = writeSessionWithSubagents('sess-none', [], [])
    expect(loadSubagentThreads(ref)).toEqual([])
    expect(loadSubagentThreads({ agent: 'codex', sessionId: 'c', logPath: ref.logPath })).toEqual([])
  })

  it('defaults agentType and spawnDepth when the meta omits them', () => {
    const ref = writeSessionWithSubagents('sess-defaults', [], [
      { agentId: 'agent-min', meta: { toolUseId: 'toolu_9' }, lines: [] },
    ])
    const [thread] = loadSubagentThreads(ref)
    expect(thread).toMatchObject({ agentType: 'agent', description: '', spawnDepth: 1 })
  })
})

describe('loadSubagentThread', () => {
  it('returns null for a non-jsonl path and for unreadable meta', () => {
    expect(loadSubagentThread('/tmp/not-a-log.txt')).toBeNull()
    expect(loadSubagentThread('/tmp/missing-everything.jsonl')).toBeNull()
  })

  // A half-written subagent pair is normal while a fan-out is live, so every
  // malformed shape has to read as "not ready yet", never as a crash.
  it('returns null for meta that is not parseable, or not an object', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-subagent-meta-'))
    for (const [name, meta] of [['broken', '{ not json'], ['scalar', '42'], ['nul', 'null']] as const) {
      const jsonl = path.join(dir, `${name}.jsonl`)
      fs.writeFileSync(jsonl, '')
      fs.writeFileSync(path.join(dir, `${name}.meta.json`), meta)
      expect(loadSubagentThread(jsonl)).toBeNull()
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when the meta is complete but the jsonl itself is unreadable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-subagent-jsonl-'))
    const jsonl = path.join(dir, 'agent-x.jsonl')
    fs.writeFileSync(path.join(dir, 'agent-x.meta.json'), JSON.stringify({ toolUseId: 'toolu_1' }))
    // Meta present, transcript not written yet.
    expect(loadSubagentThread(jsonl)).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('buildAgentSessionResponse', () => {
  it('returns the parent timeline and its subagent threads together', () => {
    const ref = writeSessionWithSubagents('sess-resp', [assistantLine('2026-07-21T11:31:12.000Z', 'parent')], [
      { agentId: 'agent-c1', meta: { toolUseId: 'toolu_x' }, lines: [assistantLine('2026-07-21T11:31:30.000Z', 'child')] },
    ])
    const res = buildAgentSessionResponse(ref)
    expect(res.agent).toBe('claude')
    expect(res.sessionId).toBe('sess-resp')
    expect(res.events).toHaveLength(1)
    expect(res.subagents).toHaveLength(1)
    expect(res.subagents[0].parentToolId).toBe('toolu_x')
  })
})
