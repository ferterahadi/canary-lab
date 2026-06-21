import { describe, it, expect } from 'vitest'
import os from 'os'
import { recoverAgentAnswer, agentActivityPath } from './agent-producer'
import { claudeSessionLogPath } from './agent-session-log'

describe('recoverAgentAnswer', () => {
  it('returns codex stdout verbatim (already the plain answer)', () => {
    expect(recoverAgentAnswer('codex', 'the answer\n')).toBe('the answer\n')
  })

  it('recovers the final message from claude stream-json stdout', () => {
    const streamJson = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
      JSON.stringify({ type: 'result', result: 'FINAL ANSWER' }),
    ].join('\n')
    expect(recoverAgentAnswer('claude', streamJson)).toBe('FINAL ANSWER')
  })
})

describe('agentActivityPath', () => {
  const cwd = '/tmp/work'
  const home = os.homedir()

  it('points at the claude session JSONL when claude + sessionId + cwd', () => {
    expect(agentActivityPath('claude', cwd, 'sess-1')).toBe(claudeSessionLogPath(cwd, 'sess-1', home))
  })

  it('falls back for codex', () => {
    expect(agentActivityPath('codex', cwd, undefined, '/tmp/agent.log')).toBe('/tmp/agent.log')
    expect(agentActivityPath('codex', cwd, 'sess-1')).toBeUndefined()
  })

  it('falls back when claude has no session id', () => {
    expect(agentActivityPath('claude', cwd, undefined, '/tmp/x.log')).toBe('/tmp/x.log')
  })

  it('falls back when cwd is empty', () => {
    expect(agentActivityPath('claude', '', 'sess-1', '/tmp/x.log')).toBe('/tmp/x.log')
  })
})
