import { describe, expect, it, vi } from 'vitest'

const { runAgentProcess, writeWorkflowAgentRef } = vi.hoisted(() => ({
  runAgentProcess: vi.fn(),
  writeWorkflowAgentRef: vi.fn(),
}))

vi.mock('../../../agent-sessions/logic/agent-process', () => ({
  runAgentProcess,
  buildClaudeAgenticArgs: () => [],
}))
vi.mock('../../../agent-sessions/logic/agent-session-log', () => ({
  claudeSessionLogPath: () => '/tmp/claude.jsonl',
  resolveWorkflowAgentRef: () => undefined,
  writeWorkflowAgentRef,
}))

import { defaultSpawnAgent } from './context'

describe('default flight spawner', () => {
  it('records a Codex spawn before execution even though Codex has no session id', async () => {
    runAgentProcess.mockReturnValue({
      stop: vi.fn(),
      done: Promise.resolve({ code: 0, stdout: 'completed', stderr: '' }),
    })
    const sessions: unknown[] = []

    await expect(defaultSpawnAgent({
      prompt: 'do the work', cwd: '/tmp', stageDir: '/tmp/flight/docs', agent: 'codex',
      onAgentSession: (session) => sessions.push(session),
    })).resolves.toEqual({ text: 'completed' })

    expect(writeWorkflowAgentRef).toHaveBeenCalledWith('/tmp/flight/docs', expect.objectContaining({ agent: 'codex', sessionId: '' }))
    expect(sessions).toEqual([expect.objectContaining({ agent: 'codex', sessionId: '' })])
  })
})
