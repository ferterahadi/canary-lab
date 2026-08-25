import { vi, describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import path from 'path'

// summarizePrd is LLM-only: it never fabricates requirements from headings, so
// every failure path below must REJECT. Which message it rejects with is the
// second half of the contract, and the two are not interchangeable:
//
//   an agent ran and failed  → `PRD summary failed: <the real cause>`
//   no agent produced output → `PRD summary requires the claude or codex agent…`
//
// Asserting the real cause is the point — the generic "is on PATH" hint used to
// mask things like an expired OAuth session. Only the three cases where no agent
// ever produced a result should expect the generic message.
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

import { summarizePrd, renderPrdSummaryMarkdown, buildPrdSummaryPrompt, readPrdSummary, PRD_SUMMARY_JSON } from './prd-summary'
import { computeDocsHash } from './docs-collection'
import type { DocsCollection } from './docs-collection'
import { startIdleTimer } from '../../../agent-sessions/logic/agent-idle-timer'

function collection(entries: { relPath: string; content: string }[]): DocsCollection {
  return { docsDir: '/tmp/docs', entries, docsHash: computeDocsHash(entries) }
}

interface FakeChildOpts {
  stdout?: string
  stderr?: string
  exitCode?: number
  error?: Error
  delayMs?: number
}

function makeFakeChild(opts: FakeChildOpts) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }
  child.kill = vi.fn()
  const delay = opts.delayMs ?? 0
  setTimeout(() => {
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout))
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr))
    if (opts.error) {
      child.emit('error', opts.error)
    } else {
      child.emit('close', opts.exitCode ?? 0, null)
    }
  }, delay)
  return child
}

const VALID_STDOUT = JSON.stringify({
  requirements: [
    { id: 'R1', title: 'Send message', text: 'A user can send a message', pathTypes: ['happy'] },
  ],
})

const TEST_COLLECTION = collection([{ relPath: 'spec.md', content: '# Send message\nA user can send a message' }])

beforeEach(() => {
  mockSpawn.mockReset()
})

describe('defaultResolveAgents — auto adapter (line 322 false branches)', () => {
  it('exercises the auto-detect path where neither claude nor codex is pinned', async () => {
    // No adapter specified → adapter defaults to 'auto' → defaultResolveAgents('auto')
    // → condition `adapter === 'claude' || adapter === 'codex'` is FALSE
    // pickAvailableHealAgent is mocked to return null → no agents → throws (LLM-only).
    await expect(summarizePrd({
      collection: TEST_COLLECTION,
      now: '2026-01-01T00:00:00.000Z',
      // no adapter → 'auto'
    })).rejects.toThrow(/requires the claude or codex agent/)

    expect(mockSpawn).not.toHaveBeenCalled()
  })
})

describe('defaultRunAgent — codex success with onSession (line 364 codex branch)', () => {
  it('fires onSession with codex agent info (covers the codex ternary branch at line 364)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ stdout: VALID_STDOUT }))
    let capturedSession: { agent: string; sessionId: string } | undefined

    const result = await summarizePrd(
      {
        collection: TEST_COLLECTION,
        now: '2026-01-01T00:00:00.000Z',
        onSession: (session) => { capturedSession = session },
      },
      { resolveAgents: () => ['codex'] },
    )

    expect(result.requirements).toHaveLength(1)
    expect(capturedSession?.agent).toBe('codex')
    expect(capturedSession?.sessionId).toBe('')
  })
})

describe('defaultRunAgent — Error thrown in catch (line 477 err.message branch)', () => {
  it('uses err.message when an Error is thrown and onOutput is provided', async () => {
    const outputChunks: string[] = []
    await expect(summarizePrd(
      {
        collection: TEST_COLLECTION,
        now: '2026-01-01T00:00:00.000Z',
        onOutput: (chunk) => outputChunks.push(chunk),
      },
      {
        resolveAgents: () => ['claude'],
        runAgent: async () => { throw new Error('prd agent exploded') },
      },
    )).rejects.toThrow(/PRD summary failed: prd agent exploded/)

    expect(outputChunks.some((c) => c.includes('prd agent exploded'))).toBe(true)
  })
})

describe('defaultRunAgent — onIdle fires child.kill and rejects (lines 394-395)', () => {
  it('throws (LLM-only) when the idle timer fires onIdle', async () => {
    // Override the module-level mock for this one test: call onIdle synchronously
    // so the code path at lines 394-395 (child.kill + finish(Error)) is executed.
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

    // onIdle rejects → the only agent failed → summarizePrd throws (LLM-only).
    await expect(summarizePrd(
      {
        collection: TEST_COLLECTION,
        now: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp/nonexistent-canary-test-dir',
      },
      { resolveAgents: () => ['claude'] },
    )).rejects.toThrow(/PRD summary failed: prd summary agent idle for/)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
