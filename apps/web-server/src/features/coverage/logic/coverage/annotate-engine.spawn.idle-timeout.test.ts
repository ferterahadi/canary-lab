import { vi, describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }))

vi.mock('child_process', () => ({ spawn: mockSpawn }))

vi.mock('../../../agent-sessions/logic/agent-idle-timer', () => ({
  startIdleTimer: vi.fn((opts: { activity?: () => number; onIdle: (ms: number) => void }) => {
    // Invoke activity immediately when provided — covers the callback body in tests.
    opts.activity?.()
    return { bump: vi.fn(), stop: vi.fn() }
  }),
}))

// Mock pickAvailableHealAgent so defaultResolveAgents is exercisable without
// requiring real agent binaries on PATH.
vi.mock('../../../runs/logic/runtime/auto-heal', () => ({
  pickAvailableHealAgent: vi.fn(() => null),
}))

// Prevent path resolution so spawn receives bare agent names.
vi.mock('../../../agent-sessions/logic/agent-binary', () => ({
  resolveAgentBinary: (agent: string) => agent,
  isAgentKind: (cmd: string) => cmd === 'claude' || cmd === 'codex',
}))

import { proposeCoverageMappings } from './annotate-engine'
import type { Requirement } from '../../../../../../../shared/coverage/types'
import { startIdleTimer } from '../../../agent-sessions/logic/agent-idle-timer'

const REQS: Requirement[] = [
  { id: 'R1', title: 'Create todo', text: 'A user can create a todo item', pathTypes: ['happy'] },
  { id: 'R2', title: 'Delete todo', text: 'A user can delete a todo item', pathTypes: ['happy'] },
]

beforeEach(() => {
  mockSpawn.mockReset()
})

describe('defaultRunAgent — onIdle fires child.kill and rejects (lines 297-298)', () => {
  it('throws (LLM-only) when the idle timer fires onIdle', async () => {
    // Override the module-level mock for this one test: call onIdle synchronously
    // so the code path at lines 297-298 (child.kill + finish(Error)) is executed.
    vi.mocked(startIdleTimer).mockImplementationOnce(
      (opts: { activity?: () => number; onIdle: (ms: number) => void }) => {
        opts.activity?.()
        opts.onIdle(300_000)  // fires the idle callback immediately
        return { bump: vi.fn(), stop: vi.fn() }
      },
    )

    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: { end: ReturnType<typeof vi.fn> }
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { end: vi.fn() }
    // Real SIGTERM closes the process; the runner resolves on close, and the
    // idled flag turns that into the idle rejection → deterministic fallback.
    child.kill = vi.fn(() => { child.emit('close', null, 'SIGTERM') })
    mockSpawn.mockReturnValue(child)

    // onIdle → kill → close → idled rejection → the only agent failed → throws.
    await expect(proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'delete removes the todo item' }],
        cwd: '/tmp/nonexistent-canary-test-dir',
      },
      { resolveAgents: () => ['claude'] },
    )).rejects.toThrow(/Coverage mapping failed/)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
