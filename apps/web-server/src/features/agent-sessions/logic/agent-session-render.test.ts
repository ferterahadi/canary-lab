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

describe('renderAgentSessionContext', () => {
  it('renders normalized prior-session events into a compact text block', () => {
    const file = path.join(homeDir, 'claude-context.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-05-11T07:00:00.000Z',
        message: { content: 'please inspect the fallback path' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-11T07:01:00.000Z',
        message: { content: [{ type: 'text', text: 'The issue is in the CNS base URL split.' }] },
      }),
    ].join('\n') + '\n')

    const rendered = renderAgentSessionContext({
      agent: 'claude',
      sessionId: 'sid-1',
      logPath: file,
    })

    expect(rendered).toContain('Previous claude session sid-1:')
    expect(rendered).toContain('USER: please inspect the fallback path')
    expect(rendered).toContain('ASSISTANT: The issue is in the CNS base URL split.')
  })

  it('returns an empty string when the referenced session log cannot be read', () => {
    expect(renderAgentSessionContext({
      agent: 'codex',
      sessionId: 'missing',
      logPath: '/no/such.jsonl',
    })).toBe('')
  })

  it('renders thinking, tool calls, tool errors, and truncates long context', () => {
    const file = path.join(homeDir, 'claude-context-tools.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'assistant',
        timestamp: 't1',
        message: {
          content: [
            { type: 'thinking', thinking: '  many   details  ' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.txt' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: 't2',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(1_400), is_error: true },
          ],
        },
      }),
    ].join('\n') + '\n')

    const rendered = renderAgentSessionContext({
      agent: 'claude',
      sessionId: 'sid-tools',
      logPath: file,
    }, 260)

    expect(rendered).toContain('THINKING: many details')
    expect(rendered).toContain('TOOL CALL Read: {"file_path":"/tmp/a.txt"}')
    expect(rendered).toContain('[Previous session context truncated — full transcript:')
    // Even when truncated, the receiving agent is pointed at the full transcript.
    const transcript = file.replace(/\.jsonl$/, '.transcript.txt')
    expect(rendered).toContain(transcript)
  })

  it('points at a full transcript (envelope stripped, uncapped) even when not truncated', () => {
    const file = path.join(homeDir, 'claude-context-pointer.jsonl')
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant',
      timestamp: 't1',
      message: { content: [{ type: 'text', text: 'short reply' }] },
    }) + '\n')

    const rendered = renderAgentSessionContext({
      agent: 'claude',
      sessionId: 'sid-pointer',
      logPath: file,
    })

    const transcript = path.join(homeDir, 'claude-context-pointer.transcript.txt')
    expect(rendered).toContain('ASSISTANT: short reply')
    expect(rendered).toContain(`[Full session transcript (untruncated): ${transcript}]`)
    expect(rendered).not.toContain('context truncated')
    // The transcript file is materialized on disk with the full content.
    expect(fs.existsSync(transcript)).toBe(true)
    expect(fs.readFileSync(transcript, 'utf-8')).toContain('ASSISTANT: short reply')
  })

  it('writes an uncapped, newline-preserving transcript that drops the JSONL envelope', () => {
    const file = path.join(homeDir, 'claude-context-full.jsonl')
    const longText = 'line one\nline two\n' + 'x'.repeat(5_000)
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant',
      timestamp: 't1',
      message: { content: [{ type: 'text', text: longText }] },
    }) + '\n')

    const out = writeFullSessionTranscript({ agent: 'claude', sessionId: 'sid-full', logPath: file })
    expect(out).toBe(path.join(homeDir, 'claude-context-full.transcript.txt'))
    const body = fs.readFileSync(out!, 'utf-8')
    // Uncapped (> the 1200-char digest cap) and newlines preserved (not collapsed).
    expect(body.length).toBeGreaterThan(5_000)
    expect(body).toContain('line one\nline two')
  })

  it('renders tool results with and without error markers when timestamps are absent', () => {
    const file = path.join(homeDir, 'claude-context-results.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'failed', is_error: true },
          ],
        },
      }),
    ].join('\n') + '\n')

    const rendered = renderAgentSessionContext({
      agent: 'claude',
      sessionId: 'sid-results',
      logPath: file,
    })

    expect(rendered).toContain('TOOL RESULT: ok')
    expect(rendered).toContain('TOOL RESULT ERROR: failed')
    expect(rendered).not.toContain('[] TOOL RESULT')
  })

  it('omits empty rendered event lines from prior-session context', () => {
    const file = path.join(homeDir, 'codex-context-empty.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'not-array' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'real output' }] } }),
    ].join('\n') + '\n')

    const rendered = renderAgentSessionContext({
      agent: 'codex',
      sessionId: 'sid-codex',
      logPath: file,
    })

    expect(rendered).toContain('ASSISTANT: real output')
    expect(rendered).not.toContain('not-array')
  })

  it('falls back to ref.logPath when writeFullSessionTranscript fails (line 481 ?? branch)', () => {
    // Create a valid log file whose sibling transcript cannot be written:
    // name the log file so that its base name (stripped of .jsonl) is a path
    // into a directory that exists as a FILE, making writeFileSync fail.
    //
    // file = <homeDir>/blocker.transcript.txt (created as a file)
    // logPath = <homeDir>/blocker.transcript.txt.jsonl
    // transcript write target = <homeDir>/blocker.transcript.txt.transcript.txt
    // → that path is unwritable because homeDir/<blocker.transcript.txt> is already a file,
    //   so the sub-path doesn't exist and the write fails.
    //
    // Actually simpler: create a directory at the transcript path location.
    const transcriptPath = path.join(homeDir, 'fs-block.transcript.txt')
    // Make the transcript target path into a DIRECTORY so writeFileSync throws EISDIR.
    fs.mkdirSync(transcriptPath, { recursive: true })
    const logFile = path.join(homeDir, 'fs-block.jsonl')
    fs.writeFileSync(logFile, JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello fs-block' }] },
    }) + '\n')
    const rendered = renderAgentSessionContext({ agent: 'claude', sessionId: 'fs-block-sid', logPath: logFile })
    // writeFullSessionTranscript fails (EISDIR) → falls back to ref.logPath (line 481 ?? branch).
    expect(rendered).toContain(logFile)
  })
})

describe('buildFullSessionTranscript', () => {
  it('returns empty string when events array is empty (line 497 branch)', () => {
    const ref = { agent: 'claude' as const, sessionId: 'sid', logPath: '/fake/path.jsonl' }
    expect(buildFullSessionTranscript(ref, [])).toBe('')
  })

  it('returns a non-empty transcript when events are provided', () => {
    const ref = { agent: 'claude' as const, sessionId: 'sid-t', logPath: '/fake/t.jsonl' }
    const events = [{ kind: 'user-message' as const, timestamp: '2026-05-11T01:23:45.000Z', text: 'ping' }]
    const result = buildFullSessionTranscript(ref, events)
    expect(result).toContain('claude session sid-t')
    expect(result).toContain('ping')
  })
})

describe('writeFullSessionTranscript', () => {
  it('returns null when transcript is empty (line 512 branch — events array is empty)', () => {
    const ref = { agent: 'claude' as const, sessionId: 'sid', logPath: path.join(homeDir, 'empty.jsonl') }
    // Pass empty events → buildFullSessionTranscript returns '' → if (!transcript) return null
    expect(writeFullSessionTranscript(ref, [])).toBeNull()
  })

  it('uses logPath as base when logPath does not end with .jsonl (line 513 else branch)', () => {
    // The ternary `ref.logPath.endsWith('.jsonl') ? ... : ref.logPath` else branch:
    // when logPath has no .jsonl extension, base = ref.logPath and transcript is written to
    // <logPath>.transcript.txt.
    const logNoExt = path.join(homeDir, 'session-log')
    const events = [{ kind: 'user-message' as const, timestamp: '2026-05-11T01:23:45.000Z', text: 'no-ext test' }]
    const result = writeFullSessionTranscript({ agent: 'claude', sessionId: 'sid-ne', logPath: logNoExt }, events)
    expect(result).toBe(`${logNoExt}.transcript.txt`)
    if (result) expect(fs.existsSync(result)).toBe(true)
  })
})

describe('writeFullSessionTranscript — catch branch (line 521)', () => {
  it('returns null when the transcript file cannot be written', () => {
    // Pass events directly so buildFullSessionTranscript produces a non-empty transcript
    // (otherwise line 512 `if (!transcript) return null` fires first and the catch is never reached).
    // Then point logPath at a directory that doesn't exist → writeFileSync throws → catch returns null.
    const missingParent = path.join(homeDir, 'no-such-dir', 'claude.jsonl')
    const events = [{ kind: 'user-message' as const, timestamp: '2026-05-11T01:23:45.000Z', text: 'hello' }]
    const result = writeFullSessionTranscript(
      { agent: 'claude', sessionId: 'sid', logPath: missingParent },
      events,
    )
    expect(result).toBeNull()
  })
})
