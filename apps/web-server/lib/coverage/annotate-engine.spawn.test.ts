import { vi, describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mockSpawn }))

vi.mock('../agent-idle-timer', () => ({
  startIdleTimer: vi.fn((opts: { activity?: () => number; onIdle: (ms: number) => void }) => {
    // Invoke activity immediately when provided — covers the callback body in tests.
    opts.activity?.()
    return { bump: vi.fn(), stop: vi.fn() }
  }),
}))

// Mock pickAvailableHealAgent so defaultResolveAgents is exercisable without
// requiring real agent binaries on PATH.
vi.mock('../runtime/auto-heal', () => ({
  pickAvailableHealAgent: vi.fn(() => null),
}))

import { proposeCoverageMappings } from './annotate-engine'
import type { Requirement } from '../../../../shared/coverage/types'
import { startIdleTimer } from '../agent-idle-timer'

const REQS: Requirement[] = [
  { id: 'R1', title: 'Create todo', text: 'A user can create a todo item', pathTypes: ['happy'] },
  { id: 'R2', title: 'Delete todo', text: 'A user can delete a todo item', pathTypes: ['happy'] },
]

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
  mappings: [
    { testName: 'creates a todo', requirements: ['R1'], pathTypes: ['happy'], confidence: 0.9 },
  ],
})

beforeEach(() => {
  mockSpawn.mockReset()
})

describe('defaultRunAgent — claude success path', () => {
  it('resolves with agent-sourced mappings and fires onOutput + onSession', async () => {
    const outputChunks: string[] = []
    let capturedSession: { agent: string; sessionId: string } | undefined

    mockSpawn.mockReturnValue(makeFakeChild({ stdout: VALID_STDOUT }))

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'creates a todo' }],
        onOutput: (chunk) => outputChunks.push(chunk),
        onSession: (session) => { capturedSession = session },
      },
      {
        resolveAgents: () => ['claude'],
        // no runAgent → uses defaultRunAgent
      },
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ testName: 'creates a todo', requirements: ['R1'], source: 'agent' })
    // onSession fired with claude agent
    expect(capturedSession?.agent).toBe('claude')
    expect(typeof capturedSession?.sessionId).toBe('string')
    expect(capturedSession?.sessionId.length).toBeGreaterThan(0)
    // onOutput received something
    expect(outputChunks.length).toBeGreaterThan(0)
  })
})

describe('defaultRunAgent — claude non-zero exit', () => {
  it('falls back to deterministic on non-zero exit code', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 1, stderr: 'agent error' }))

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'delete removes the todo item' }],
      },
      { resolveAgents: () => ['claude'] },
    )

    expect(result[0].source).toBe('deterministic')
  })
})

describe('defaultRunAgent — spawn error event', () => {
  it('falls back to deterministic when child emits error', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ error: new Error('ENOENT') }))

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'create makes a new todo' }],
      },
      { resolveAgents: () => ['claude'] },
    )

    expect(result[0].source).toBe('deterministic')
  })
})

describe('defaultRunAgent — pre-aborted signal', () => {
  it('falls back to deterministic when signal is already aborted before call', async () => {
    const controller = new AbortController()
    controller.abort()

    // spawn still returns a fake child but abort path should kick in before events
    mockSpawn.mockReturnValue(makeFakeChild({ stdout: VALID_STDOUT, delayMs: 50 }))

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'create makes a new todo' }],
        signal: controller.signal,
      },
      { resolveAgents: () => ['claude'] },
    )

    expect(result[0].source).toBe('deterministic')
  })
})

describe('defaultRunAgent — abort signal during run', () => {
  it('falls back to deterministic when aborted mid-run', async () => {
    const controller = new AbortController()

    // Delay the fake child so we can abort before it resolves
    mockSpawn.mockReturnValue(makeFakeChild({ stdout: VALID_STDOUT, delayMs: 100 }))

    // Abort after a short delay, before the child would naturally close
    setTimeout(() => controller.abort(), 20)

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'delete removes the todo item' }],
        signal: controller.signal,
      },
      { resolveAgents: () => ['claude'] },
    )

    expect(result[0].source).toBe('deterministic')
  })
})

describe('defaultRunAgent — codex success path', () => {
  it('resolves with agent-sourced mappings for codex agent and fires onSession with codex (line 266 branch)', async () => {
    // Codex reads from stdout (no output file written in fake scenario).
    // Passing onSession exercises the `agent === 'codex'` branch of the ternary at line 266.
    mockSpawn.mockReturnValue(makeFakeChild({ stdout: VALID_STDOUT }))
    let capturedSession: { agent: string; sessionId: string } | undefined

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'creates a todo' }],
        onSession: (session) => { capturedSession = session },
      },
      { resolveAgents: () => ['codex'] },
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ testName: 'creates a todo', requirements: ['R1'], source: 'agent' })
    // onSession fired with codex agent (covers the ternary's codex branch)
    expect(capturedSession?.agent).toBe('codex')
    expect(capturedSession?.sessionId).toBe('')

    // Verify codex-specific args were passed to spawn
    const spawnCall = mockSpawn.mock.calls[0]
    expect(spawnCall[0]).toBe('codex')
    const args: string[] = spawnCall[1]
    expect(args).toContain('exec')
    expect(args).toContain('--output-last-message')
    expect(args).toContain('--output-schema')
    expect(args).toContain('--skip-git-repo-check')
  })
})

describe('defaultResolveAgents — deterministic adapter', () => {
  it('returns [] for deterministic adapter, falls through to deterministic mappings', async () => {
    // No deps injected at all — exercises defaultResolveAgents('deterministic')
    const result = await proposeCoverageMappings({
      requirements: REQS,
      tests: [{ name: 'create makes a new todo' }],
      adapter: 'deterministic',
    })

    // spawn should NOT be called (no agents resolved)
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(result[0].source).toBe('deterministic')
  })
})

describe('defaultResolveAgents — auto adapter (line 232 false branch)', () => {
  it('exercises the auto-detect path where neither claude nor codex is pinned', async () => {
    // No adapter specified → adapter defaults to 'auto' → defaultResolveAgents('auto')
    // → condition `adapter === 'claude' || adapter === 'codex'` is FALSE
    // → pickAvailableHealAgent() (no arg) called instead.
    // pickAvailableHealAgent is mocked to return null → no agents → deterministic.
    const result = await proposeCoverageMappings({
      requirements: REQS,
      tests: [{ name: 'create makes a new todo' }],
      // no adapter → 'auto'
    })

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(result[0].source).toBe('deterministic')
  })
})

describe('defaultResolveAgents — claude adapter (no binary available)', () => {
  it('exercises defaultResolveAgents body with claude adapter when no binary is on PATH', async () => {
    // pickAvailableHealAgent is mocked to return null — no agents available
    // defaultResolveAgents('claude') will be called and return []
    const result = await proposeCoverageMappings({
      requirements: REQS,
      tests: [{ name: 'create makes a new todo' }],
      adapter: 'claude',
    })

    // spawn should NOT be called (no agents resolved)
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(result[0].source).toBe('deterministic')
  })
})

describe('defaultRunAgent — codex output file is read when --output-last-message file exists (non-empty)', () => {
  it('uses file contents as finalOutput when output file is written before close', async () => {
    // Intercept spawn: capture outputPath from args, write the JSON file, then close(0)
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const outputLastMsgIdx = args.indexOf('--output-last-message')
      const outputPath = outputLastMsgIdx !== -1 ? args[outputLastMsgIdx + 1] : undefined

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

      setTimeout(() => {
        // Write the output file BEFORE emitting close — covers lines 327-329
        if (outputPath) {
          fs.writeFileSync(outputPath, VALID_STDOUT)
        }
        child.emit('close', 0, null)
      }, 0)
      return child
    })

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'creates a todo' }],
      },
      { resolveAgents: () => ['codex'] },
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ testName: 'creates a todo', requirements: ['R1'], source: 'agent' })
  })
})

describe('defaultRunAgent — codex output file empty falls back to stdout', () => {
  it('keeps stdout as finalOutput when output file exists but is empty', async () => {
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const outputLastMsgIdx = args.indexOf('--output-last-message')
      const outputPath = outputLastMsgIdx !== -1 ? args[outputLastMsgIdx + 1] : undefined

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

      setTimeout(() => {
        // Emit valid stdout first, then write an EMPTY output file — covers the
        // `if (fromFile.trim())` FALSE branch (line 329 not taken, stdout kept)
        child.stdout.emit('data', Buffer.from(VALID_STDOUT))
        if (outputPath) {
          fs.writeFileSync(outputPath, '   ')  // whitespace-only → trim() is falsy
        }
        child.emit('close', 0, null)
      }, 0)
      return child
    })

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'creates a todo' }],
      },
      { resolveAgents: () => ['codex'] },
    )

    // Still resolves from stdout (which held VALID_STDOUT)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ testName: 'creates a todo', requirements: ['R1'], source: 'agent' })
  })
})

describe('defaultRunAgent — claudeLogPath activity callback is invoked', () => {
  it('calls activity() when cwd is provided for claude agent (covers statSync catch path)', async () => {
    // The agent-idle-timer mock (top of file) calls opts.activity?.() immediately.
    // With cwd set, claudeLogPath is non-undefined → activity arrow is defined →
    // mock calls it → statSync throws (log file does not exist) → catch returns 0.
    mockSpawn.mockReturnValue((() => {
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
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(VALID_STDOUT))
        child.emit('close', 0, null)
      }, 0)
      return child
    })())

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'creates a todo' }],
        // cwd is required so claudeLogPath is computed and the activity fn is defined
        cwd: '/tmp/nonexistent-canary-test-dir',
      },
      { resolveAgents: () => ['claude'] },
    )

    // Run still succeeds — the activity callback's catch branch returned 0 without throwing
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ testName: 'creates a todo', requirements: ['R1'], source: 'agent' })
  })
})

describe('defaultRunAgent — settled guard: finish called twice (line 278 true branch)', () => {
  it('second call to finish is a no-op when already settled', async () => {
    // The idle timer fires synchronously (via mock) before any child events:
    // 1. onIdle → finish(Error) → settled=true, promise rejects
    // 2. child.emit('close', 0) then fires → finish(undefined, stdout) → if (settled) return
    // This exercises the TRUE branch of `if (settled) return` at line 278.
    vi.mocked(startIdleTimer).mockImplementationOnce(
      (opts: { activity?: () => number; onIdle: (ms: number) => void }) => {
        opts.activity?.()
        opts.onIdle(300_000)  // settled → true
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
    child.kill = vi.fn()
    // Emit close AFTER the promise settles via onIdle → triggers the settled guard
    setTimeout(() => child.emit('close', 0, null), 0)
    mockSpawn.mockReturnValue(child)

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'delete removes the todo item' }],
        cwd: '/tmp/nonexistent-canary-test-dir',
      },
      { resolveAgents: () => ['claude'] },
    )

    expect(result[0].source).toBe('deterministic')
  })
})

describe('defaultRunAgent — close with non-null signal (line 323 ?? branch)', () => {
  it('includes the signal name in the error when close fires with a signal', async () => {
    // Emit close(null, 'SIGTERM') — code is null, sig is 'SIGTERM' →
    // the sig ?? `exit code ${code}` branch uses sig, not the fallback.
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
    setTimeout(() => child.emit('close', null, 'SIGTERM'), 0)
    mockSpawn.mockReturnValue(child)

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'delete removes the todo item' }],
      },
      { resolveAgents: () => ['claude'] },
    )

    // Non-zero / signal exit → falls back to deterministic
    expect(result[0].source).toBe('deterministic')
  })
})

describe('defaultRunAgent — Error thrown in catch (line 377 err.message branch)', () => {
  it('uses err.message when an Error is thrown and onOutput is provided', async () => {
    // Inject a runAgent that throws a real Error.
    // proposeCoverageMappings catches → args.onOutput is provided → ternary evaluated
    // → err instanceof Error is TRUE → err.message is used.
    const outputChunks: string[] = []
    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'delete removes the todo item' }],
        onOutput: (chunk) => outputChunks.push(chunk),
      },
      {
        resolveAgents: () => ['claude'],
        runAgent: async () => { throw new Error('agent exploded') },
      },
    )

    // Exception caught → fell back to deterministic
    expect(result[0].source).toBe('deterministic')
    // onOutput received the err.message
    expect(outputChunks.some((c) => c.includes('agent exploded'))).toBe(true)
  })
})

describe('defaultRunAgent — non-Error thrown in catch (line 377 String(err) branch)', () => {
  it('uses String(err) when a non-Error value is thrown by the injected runAgent', async () => {
    // Use the injected runAgent hook to throw a non-Error (a plain string).
    // proposeCoverageMappings catches → calls onOutput with String(err).
    const outputChunks: string[] = []
    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'delete removes the todo item' }],
        onOutput: (chunk) => outputChunks.push(chunk),
      },
      {
        resolveAgents: () => ['claude'],
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        runAgent: async () => { throw 'non-error string' },
      },
    )

    // Exception caught → fell back to deterministic
    expect(result[0].source).toBe('deterministic')
    // onOutput received the String(err) message
    expect(outputChunks.some((c) => c.includes('non-error string'))).toBe(true)
  })
})

describe('defaultRunAgent — onIdle fires child.kill and rejects (lines 297-298)', () => {
  it('falls back to deterministic when the idle timer fires onIdle', async () => {
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
    child.kill = vi.fn()
    // Do NOT emit close — the rejection comes from onIdle
    mockSpawn.mockReturnValue(child)

    const result = await proposeCoverageMappings(
      {
        requirements: REQS,
        tests: [{ name: 'delete removes the todo item' }],
        cwd: '/tmp/nonexistent-canary-test-dir',
      },
      { resolveAgents: () => ['claude'] },
    )

    // onIdle rejects → proposeCoverageMappings catches → falls back to deterministic
    expect(result[0].source).toBe('deterministic')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
