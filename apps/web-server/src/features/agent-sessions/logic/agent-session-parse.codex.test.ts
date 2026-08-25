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

describe('loadAgentSessionLog (codex)', () => {
  function writeCodexLog(lines: object[]): string {
    const file = path.join(homeDir, 'codex.jsonl')
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return file
  }

  it('normalizes user/assistant messages, function_call, function_call_output', () => {
    const file = writeCodexLog([
      { timestamp: 't1', type: 'response_item', payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'fix the bug' }],
      } },
      { timestamp: 't2', type: 'response_item', payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'on it' }],
      } },
      { timestamp: 't3', type: 'response_item', payload: {
        type: 'function_call', call_id: 'call_1', name: 'exec_command',
        arguments: '{"cmd":"ls"}',
      } },
      { timestamp: 't4', type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'call_1',
        output: 'a\nb\nc',
      } },
    ])
    const events = loadAgentSessionLog({ agent: 'codex', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'user-message', timestamp: 't1', text: 'fix the bug' },
      { kind: 'assistant-message', timestamp: 't2', text: 'on it' },
      { kind: 'tool-call', timestamp: 't3', toolId: 'call_1', name: 'exec_command', input: { cmd: 'ls' } },
      { kind: 'tool-result', timestamp: 't4', toolId: 'call_1', output: 'a\nb\nc' },
    ])
  })

  it('skips developer messages and the auto-injected environment_context user msg', () => {
    const file = writeCodexLog([
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'developer',
        content: [{ type: 'input_text', text: '<permissions instructions>...</permissions instructions>' }],
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/foo</cwd>\n</environment_context>' }],
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'real prompt' }],
      } },
    ])
    const events = loadAgentSessionLog({ agent: 'codex', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'user-message', timestamp: 't', text: 'real prompt' },
    ])
  })

  it('ignores event_msg lines (they duplicate response_item data)', () => {
    const file = writeCodexLog([
      { timestamp: 't', type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: 't', type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'hi' }],
      } },
    ])
    const events = loadAgentSessionLog({ agent: 'codex', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'assistant-message', timestamp: 't', text: 'hi' },
    ])
  })

  it('preserves the raw arguments string when JSON.parse fails', () => {
    const file = writeCodexLog([
      { timestamp: 't', type: 'response_item', payload: {
        type: 'function_call', call_id: 'c', name: 'tool',
        arguments: 'not json',
      } },
    ])
    const events = loadAgentSessionLog({ agent: 'codex', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-call', timestamp: 't', toolId: 'c', name: 'tool', input: 'not json' },
    ])
  })

  it('skips empty/machine Codex payloads and defaults malformed tool fields', () => {
    const file = writeCodexLog([
      { timestamp: 123, type: 'response_item' },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'user',
        content: 'not-array',
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: '   ' }],
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'tool',
        content: [{ type: 'output_text', text: 'not a chat message' }],
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'reasoning', content: [{ type: 'output_text', text: 'hidden' }],
      } },
      { timestamp: 123, type: 'response_item', payload: {
        type: 'function_call',
        call_id: 42,
        name: null,
        arguments: { ok: true },
      } },
      { timestamp: 456, type: 'response_item', payload: {
        type: 'function_call_output',
        call_id: 42,
        output: { lines: 2 },
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'function_call_output',
        output: null,
      } },
      { timestamp: 't', type: 'response_item', payload: {
        type: 'message', role: 'assistant',
        content: [
          { type: 'output_text', text: 'first' },
          { type: 'image', text: 'ignored' },
          { type: 'output_text', text: 'second' },
        ],
      } },
    ])

    const events = loadAgentSessionLog({ agent: 'codex', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-call', timestamp: '', toolId: '', name: '', input: { ok: true } },
      { kind: 'tool-result', timestamp: '', toolId: '', output: '{"lines":2}' },
      { kind: 'tool-result', timestamp: 't', toolId: '', output: '""' },
      { kind: 'assistant-message', timestamp: 't', text: 'first\nsecond' },
    ])
  })
})

describe('loadAgentSessionLog edge cases', () => {
  it('returns [] when the log file is missing', () => {
    expect(loadAgentSessionLog({ agent: 'claude', sessionId: 'x', logPath: '/no/such.jsonl' })).toEqual([])
  })
})

describe('session metadata (model / effort)', () => {
  function writeLog(lines: object[]): string {
    const file = path.join(homeDir, `meta-${lines.length}-${Math.abs(JSON.stringify(lines).length)}.jsonl`)
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return file
  }

  it('extracts model + effort from a codex turn_context line', () => {
    const file = writeLog([
      { type: 'session_meta', payload: { id: 's', cwd: '/x', timestamp: 't' } },
      { type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'high', summary: 'auto' } },
    ])
    expect(loadAgentSessionMeta({ agent: 'codex', sessionId: 's', logPath: file })).toEqual({
      model: 'gpt-5.5',
      effort: 'high',
    })
  })

  it('takes the last codex turn_context when the model/effort changes mid-session', () => {
    const file = writeLog([
      { type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'low' } },
      { type: 'turn_context', payload: { model: 'gpt-5.5-codex', effort: 'high' } },
    ])
    expect(loadAgentSessionMeta({ agent: 'codex', sessionId: 's', logPath: file })).toEqual({
      model: 'gpt-5.5-codex',
      effort: 'high',
    })
  })

  it('extracts model from claude assistant lines and leaves effort undefined', () => {
    const file = writeLog([
      { type: 'user', timestamp: 't', message: { content: 'hi' } },
      { type: 'assistant', timestamp: 't', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }] } },
    ])
    const meta = loadAgentSessionMeta({ agent: 'claude', sessionId: 's', logPath: file })
    expect(meta.model).toBe('claude-opus-4-8')
    expect(meta.effort).toBeUndefined()
  })

  it('returns empty meta when no model/effort lines are present', () => {
    const file = writeLog([{ type: 'event_msg', payload: { type: 'task_started' } }])
    expect(loadAgentSessionMeta({ agent: 'codex', sessionId: 's', logPath: file })).toEqual({})
  })

  it('ignores a turn_context whose model/effort are empty strings or non-strings', () => {
    // Each guard is `typeof x === 'string' && x` — empty strings fail the
    // truthiness arm, non-strings fail the typeof arm. Neither sets meta.
    const file = writeLog([
      { type: 'turn_context', payload: { model: '', effort: '' } },
      { type: 'turn_context', payload: { model: 123, effort: 456 } },
    ])
    expect(loadAgentSessionMeta({ agent: 'codex', sessionId: 's', logPath: file })).toEqual({})
  })

  it('returns empty meta when the log file is missing', () => {
    expect(loadAgentSessionMeta({ agent: 'codex', sessionId: 'x', logPath: '/no/such.jsonl' })).toEqual({})
  })

  it('loadAgentSession returns events and meta from a single read', () => {
    const file = writeLog([
      { type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'medium' } },
      { type: 'response_item', timestamp: 't', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    ])
    const { events, meta } = loadAgentSession({ agent: 'codex', sessionId: 's', logPath: file })
    expect(meta).toEqual({ model: 'gpt-5.5', effort: 'medium' })
    expect(events).toEqual([{ kind: 'assistant-message', timestamp: 't', text: 'done' }])
  })
})
