import { describe, expect, it, vi } from 'vitest'

const { runAgentProcess, writeWorkflowAgentRef } = vi.hoisted(() => ({
  runAgentProcess: vi.fn(),
  writeWorkflowAgentRef: vi.fn(),
}))

vi.mock('../../../agent-sessions/logic/agent-process', () => ({
  runAgentProcess,
  buildClaudeAgenticArgs: () => [],
}))
vi.mock('../../../agent-sessions/logic/agent-session-paths', () => ({
  claudeSessionLogPath: () => '/tmp/claude.jsonl',
}))
vi.mock('../../../agent-sessions/logic/agent-session-log', () => ({
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
      models: { model: 'test-model', effort: 'high' },
      onAgentSession: (session) => sessions.push(session),
    })).resolves.toEqual({ text: 'completed' })

    expect(runAgentProcess).toHaveBeenCalledWith(expect.objectContaining({
      command: 'codex', cwd: '/tmp', stdin: 'do the work',
      args: ['exec', '--sandbox', 'workspace-write', '-c', 'approval_policy="on-request"', '--skip-git-repo-check', '--model', 'test-model', '-c', 'model_reasoning_effort=high', '-'],
    }))
    expect(writeWorkflowAgentRef).toHaveBeenCalledWith('/tmp/flight/docs', expect.objectContaining({ agent: 'codex', sessionId: '' }))
    expect(sessions).toEqual([expect.objectContaining({ agent: 'codex', sessionId: '' })])
  })
})
