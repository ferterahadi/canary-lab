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

describe('assistant-message apiError flag', () => {
  it('marks a stream-drop turn so the UI can render it as a termination', () => {
    const ref = writeSessionWithSubagents('sess-apierr', [
      assistantLine('2026-07-21T11:33:16.000Z', 'API Error: Connection closed mid-response.', { isApiErrorMessage: true }),
      assistantLine('2026-07-21T11:33:20.000Z', 'a normal turn'),
    ], [])
    const [dropped, normal] = loadAgentSessionLog(ref)
    expect(dropped).toMatchObject({ kind: 'assistant-message', apiError: true })
    expect(normal).toMatchObject({ kind: 'assistant-message' })
    expect((normal as { apiError?: boolean }).apiError).toBeUndefined()
  })
})

describe('claude injected-tag filtering', () => {
  const userLine = (text: string, asString = false) => JSON.stringify({
    type: 'user',
    timestamp: '2026-07-21T12:09:53.515Z',
    message: { content: asString ? text : [{ type: 'text', text }] },
  })

  it('drops harness bookkeeping the CLI injects as user turns', () => {
    for (const tag of [
      'task-notification', 'command-message', 'command-name', 'command-args',
      'local-command-stdout', 'local-command-stderr', 'local-command-caveat', 'system-reminder',
    ]) {
      expect(parseAgentSessionLine('claude', userLine(`<${tag}>\nnoise\n</${tag}>`))).toEqual([])
    }
  })

  it('drops them when the content is a bare string too', () => {
    expect(parseAgentSessionLine('claude', userLine('<task-notification>x</task-notification>', true))).toEqual([])
  })

  it('drops them with leading whitespace (the CLI is not consistent)', () => {
    expect(parseAgentSessionLine('claude', userLine('\n  <task-notification>x</task-notification>'))).toEqual([])
  })

  it('KEEPS a real prompt that merely starts with markup', () => {
    const events = parseAgentSessionLine('claude', userLine('<html>\n<body>fix this markup</body>\n</html>'))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'user-message' })
  })

  it('KEEPS a prompt that only mentions a tag mid-text', () => {
    const events = parseAgentSessionLine('claude', userLine('Explain what a <task-notification> block is.'))
    expect(events).toHaveLength(1)
  })

  it('KEEPS the collector prompt', () => {
    const events = parseAgentSessionLine('claude', userLine('You are gathering requirement material for an E2E test suite.'))
    expect(events).toHaveLength(1)
  })

  it('leaves codex parsing untouched', () => {
    const codexLine = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-21T12:00:00.000Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<task-notification>x</task-notification>' }] },
    })
    // Codex has its own injection vocabulary; this filter is claude-specific.
    expect(parseAgentSessionLine('codex', codexLine)).toHaveLength(1)
  })
})
