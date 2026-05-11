import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  encodeClaudeProjectDir,
  locateClaudeSessionLog,
  locateCodexSessionLog,
  loadAgentSessionLog,
} from './agent-session-log'

let homeDir: string

beforeEach(() => {
  homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-home-')))
})

afterEach(() => {
  try { fs.rmSync(homeDir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('encodeClaudeProjectDir', () => {
  it('replaces every / with - so /Users/oddle/foo becomes -Users-oddle-foo', () => {
    expect(encodeClaudeProjectDir('/Users/oddle/foo')).toBe('-Users-oddle-foo')
  })

  it('preserves dots, hyphens, and underscores', () => {
    expect(encodeClaudeProjectDir('/a/b-c.d_e/2026-05-11')).toBe('-a-b-c.d_e-2026-05-11')
  })
})

describe('locateClaudeSessionLog', () => {
  it('returns the path when the predicted JSONL exists', () => {
    const runDir = '/Users/test/canary/logs/runs/r1'
    const sessionId = '01234567-89ab-cdef-0123-456789abcdef'
    const encoded = encodeClaudeProjectDir(runDir)
    const projectDir = path.join(homeDir, '.claude', 'projects', encoded)
    fs.mkdirSync(projectDir, { recursive: true })
    const jsonl = path.join(projectDir, `${sessionId}.jsonl`)
    fs.writeFileSync(jsonl, '')

    expect(locateClaudeSessionLog(runDir, sessionId, homeDir)).toBe(jsonl)
  })

  it('returns null when the file is missing', () => {
    expect(locateClaudeSessionLog('/no/such', 'sid', homeDir)).toBeNull()
  })

  it('returns null when sessionId is falsy', () => {
    expect(locateClaudeSessionLog('/some/dir', '', homeDir)).toBeNull()
  })
})

describe('locateCodexSessionLog', () => {
  function writeCodexSession(opts: {
    yyyy: string
    mm: string
    dd: string
    fileBase: string
    payload: { id: string; cwd: string; timestamp: string }
  }): string {
    const dir = path.join(homeDir, '.codex', 'sessions', opts.yyyy, opts.mm, opts.dd)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${opts.fileBase}.jsonl`)
    const meta = {
      timestamp: opts.payload.timestamp,
      type: 'session_meta',
      payload: opts.payload,
    }
    fs.writeFileSync(file, JSON.stringify(meta) + '\n')
    return file
  }

  it('finds the session whose cwd + timestamp match', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-23-45-aaaa',
      payload: { id: 'sess-aaaa', cwd: runDir, timestamp: '2026-05-11T01:23:45.000Z' },
    })

    const ref = locateCodexSessionLog(runDir, '2026-05-11T01:23:00.000Z', homeDir)
    expect(ref).toEqual({ agent: 'codex', sessionId: 'sess-aaaa', logPath: expected })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('skips sessions started before cycleStartedAt', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-00-00-old',
      payload: { id: 'sess-old', cwd: runDir, timestamp: '2026-05-11T01:00:00.000Z' },
    })

    const ref = locateCodexSessionLog(runDir, '2026-05-11T02:00:00.000Z', homeDir)
    expect(ref).toBeNull()

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('skips sessions whose cwd does not match the runDir', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-23-45-other',
      payload: { id: 'sess-other', cwd: '/some/unrelated/dir', timestamp: '2026-05-11T01:23:45.000Z' },
    })

    const ref = locateCodexSessionLog(runDir, '2026-05-11T01:23:00.000Z', homeDir)
    expect(ref).toBeNull()

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('ignores malformed Codex session metadata while selecting the newest valid match', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-10-00-wrong-type',
      payload: { id: 'sess-wrong-type', cwd: runDir, timestamp: '2026-05-11T01:10:00.000Z' },
    })
    const malformedDir = path.join(homeDir, '.codex', 'sessions', '2026', '05', '11')
    fs.writeFileSync(path.join(malformedDir, 'rollout-2026-05-11T01-12-00-not-meta.jsonl'), JSON.stringify({ type: 'event_msg' }) + '\n')
    fs.writeFileSync(path.join(malformedDir, 'notes.txt'), 'not a session')
    fs.symlinkSync(
      path.join(malformedDir, 'missing-target.jsonl'),
      path.join(malformedDir, 'rollout-2026-05-11T01-12-30-dangling.jsonl'),
    )
    fs.writeFileSync(path.join(malformedDir, 'rollout-2026-05-11T01-13-00-bad-payload.jsonl'), JSON.stringify({
      type: 'session_meta',
      payload: { id: 123, cwd: runDir, timestamp: '2026-05-11T01:13:00.000Z' },
    }) + '\n')
    fs.writeFileSync(path.join(malformedDir, 'rollout-2026-05-11T01-14-00-bad-json.jsonl'), '{not-json\n')
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-20-00-newest',
      payload: { id: 'sess-newest', cwd: runDir, timestamp: '2026-05-11T01:20:00.000Z' },
    })

    const ref = locateCodexSessionLog(runDir, '2026-05-11T01:00:00.000Z', homeDir)
    expect(ref).toEqual({ agent: 'codex', sessionId: 'sess-newest', logPath: expected })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('keeps the newest Codex session when an older match is scanned later', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: '000-newer',
      payload: { id: 'sess-newer', cwd: runDir, timestamp: '2026-05-11T01:20:00.000Z' },
    })
    writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: '999-older',
      payload: { id: 'sess-older', cwd: runDir, timestamp: '2026-05-11T01:10:00.000Z' },
    })

    const ref = locateCodexSessionLog(runDir, '2026-05-11T01:00:00.000Z', homeDir)
    expect(ref).toEqual({ agent: 'codex', sessionId: 'sess-newer', logPath: expected })

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('ignores close errors while reading Codex session metadata', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '11',
      fileBase: 'rollout-2026-05-11T01-20-00-close-error',
      payload: { id: 'sess-close-error', cwd: runDir, timestamp: '2026-05-11T01:20:00.000Z' },
    })
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation(() => {
      throw new Error('close failed')
    })
    try {
      const ref = locateCodexSessionLog(runDir, '2026-05-11T01:00:00.000Z', homeDir)
      expect(ref).toEqual({ agent: 'codex', sessionId: 'sess-close-error', logPath: expected })
    } finally {
      closeSpy.mockRestore()
      try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('returns null when the Codex sessions root is missing', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    expect(locateCodexSessionLog(runDir, '2026-05-11T01:00:00.000Z', homeDir)).toBeNull()
    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('crosses UTC date boundaries (scans next day too)', () => {
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asl-run-')))
    const expected = writeCodexSession({
      yyyy: '2026',
      mm: '05',
      dd: '12',
      fileBase: 'rollout-2026-05-12T00-30-00-next-day',
      payload: { id: 'sess-next', cwd: runDir, timestamp: '2026-05-12T00:30:00.000Z' },
    })

    // Cycle started late on the 11th; session ended up in the 12th's bucket.
    const ref = locateCodexSessionLog(runDir, '2026-05-11T23:50:00.000Z', homeDir)
    expect(ref?.logPath).toBe(expected)

    try { fs.rmSync(runDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns null when cycleStartedAt is unparseable', () => {
    expect(locateCodexSessionLog('/some/dir', 'not-a-date', homeDir)).toBeNull()
  })
})

describe('loadAgentSessionLog (claude)', () => {
  function writeClaudeLog(lines: object[]): string {
    const file = path.join(homeDir, 'claude.jsonl')
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return file
  }

  it('normalizes a user string message + assistant text + tool_use + tool_result', () => {
    const file = writeClaudeLog([
      {
        type: 'user',
        timestamp: '2026-05-11T07:00:00.000Z',
        message: { content: '@/path/to/prompt.md' },
      },
      {
        type: 'assistant',
        timestamp: '2026-05-11T07:00:01.000Z',
        message: {
          content: [
            { type: 'thinking', thinking: 'pondering' },
            { type: 'text', text: "I'll read the index." },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x.md' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-05-11T07:00:02.000Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' },
          ],
        },
      },
    ])

    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'user-message', timestamp: '2026-05-11T07:00:00.000Z', text: '@/path/to/prompt.md' },
      { kind: 'assistant-thinking', timestamp: '2026-05-11T07:00:01.000Z', text: 'pondering' },
      { kind: 'assistant-message', timestamp: '2026-05-11T07:00:01.000Z', text: "I'll read the index." },
      { kind: 'tool-call', timestamp: '2026-05-11T07:00:01.000Z', toolId: 'toolu_1', name: 'Read', input: { file_path: '/x.md' } },
      { kind: 'tool-result', timestamp: '2026-05-11T07:00:02.000Z', toolId: 'toolu_1', output: 'file body' },
    ])
  })

  it('defaults malformed Claude assistant tool_use identifiers', () => {
    const file = writeClaudeLog([
      {
        type: 'assistant',
        timestamp: 't',
        message: {
          content: [
            { type: 'text', text: '   ' },
            { type: 'thinking', thinking: '   ' },
            { type: 'tool_use', id: 123, name: null, input: { path: 'x' } },
          ],
        },
      },
    ])

    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-call', timestamp: 't', toolId: '', name: '', input: { path: 'x' } },
    ])
  })

  it('skips Claude assistant records whose content is not an array', () => {
    const file = writeClaudeLog([
      {
        type: 'assistant',
        timestamp: 't',
        message: { content: 'not-array' },
      },
      {
        type: 'assistant',
        timestamp: 't',
        message: {
          content: [{ type: 'text', text: 'real text' }],
        },
      },
    ])

    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'assistant-message', timestamp: 't', text: 'real text' },
    ])
  })

  it('handles tool_result content that is an array of text/image blocks', () => {
    const file = writeClaudeLog([
      {
        type: 'user',
        timestamp: 't',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: [
                { type: 'text', text: 'line one' },
                { type: 'image' },
                { type: 'text', text: 'line two' },
              ],
              is_error: true,
            },
          ],
        },
      },
    ])
    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-result', timestamp: 't', toolId: 'toolu_2', output: 'line one\n[image]\nline two', isError: true },
    ])
  })

  it('handles non-string Claude tool_result content without output text', () => {
    const file = writeClaudeLog([
      {
        type: 'user',
        timestamp: 't',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_object', content: { structured: true } },
            { type: 'tool_result', tool_use_id: 'toolu_image', content: [{ type: 'image' }, null] },
          ],
        },
      },
    ])
    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-result', timestamp: 't', toolId: 'toolu_object', output: '' },
      { kind: 'tool-result', timestamp: 't', toolId: 'toolu_image', output: '[image]' },
    ])
  })

  it('defaults malformed Claude tool_result identifiers and preserves false errors as non-error results', () => {
    const file = writeClaudeLog([
      {
        type: 'user',
        timestamp: 't',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 123, content: 'ok', is_error: false },
          ],
        },
      },
    ])
    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'tool-result', timestamp: 't', toolId: '', output: 'ok' },
    ])
  })

  it('normalizes non-empty user text blocks in array content', () => {
    const file = writeClaudeLog([
      {
        type: 'user',
        timestamp: 't',
        message: {
          content: [
            { type: 'text', text: '   ' },
            { type: 'text', text: 'review this plan' },
          ],
        },
      },
    ])
    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'user-message', timestamp: 't', text: 'review this plan' },
    ])
  })

  it('skips metadata-only event types and malformed lines', () => {
    const file = path.join(homeDir, 'claude.jsonl')
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'last-prompt' }),
        JSON.stringify({ type: 'permission-mode' }),
        JSON.stringify({ type: 'file-history-snapshot' }),
        JSON.stringify(null),
        'not-json-at-all',
        '',
        JSON.stringify({ type: 'user', timestamp: 't', message: { content: '   ' } }),
        JSON.stringify({ type: 'user', timestamp: 't', message: { content: 123 } }),
        JSON.stringify({ type: 'user', timestamp: 't', message: { content: 'hi' } }),
      ].join('\n'),
    )
    const events = loadAgentSessionLog({ agent: 'claude', sessionId: 'sid', logPath: file })
    expect(events).toEqual([
      { kind: 'user-message', timestamp: 't', text: 'hi' },
    ])
  })
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
