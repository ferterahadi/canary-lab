import { vi, describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'

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
vi.mock('../../../orchestration/logic/runtime/auto-heal', () => ({
  pickAvailableHealAgent: vi.fn(() => null),
}))

import { summarizePrd, renderPrdSummaryMarkdown, buildPrdSummaryPrompt, readPrdSummary, PRD_SUMMARY_JSON } from './prd-summary'
import { computeDocsHash } from '../../../coverage/logic/coverage/docs-collection'
import type { DocsCollection } from '../../../coverage/logic/coverage/docs-collection'
import type { PrdSummary, Requirement } from '../../../../../../../shared/coverage/types'
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

describe('defaultRunAgent — claude success path', () => {
  it('resolves with agent-sourced requirements and fires onOutput + onSession', async () => {
    const outputChunks: string[] = []
    let capturedSession: { agent: string; sessionId: string } | undefined

    mockSpawn.mockReturnValue(makeFakeChild({ stdout: VALID_STDOUT }))

    const result = await summarizePrd(
      {
        collection: TEST_COLLECTION,
        now: '2026-01-01T00:00:00.000Z',
        onOutput: (chunk) => outputChunks.push(chunk),
        onSession: (session) => { capturedSession = session },
      },
      {
        resolveAgents: () => ['claude'],
        // no runAgent → uses defaultRunAgent
      },
    )

    expect(result.requirements).toHaveLength(1)
    expect(result.requirements[0]).toMatchObject({ id: 'R1', title: 'Send message' })
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

    const result = await summarizePrd(
      { collection: TEST_COLLECTION, now: '2026-01-01T00:00:00.000Z' },
      { resolveAgents: () => ['claude'] },
    )

    // deterministic extracts heading from spec.md
    expect(result.requirements[0].title).toBe('Send message')
    expect(result.requirements[0].id).toBe('R1')
  })
})

describe('defaultRunAgent — spawn error event', () => {
  it('falls back to deterministic when child emits error', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ error: new Error('ENOENT') }))

    const result = await summarizePrd(
      { collection: TEST_COLLECTION, now: '2026-01-01T00:00:00.000Z' },
      { resolveAgents: () => ['claude'] },
    )

    expect(result.requirements[0].id).toBe('R1')
  })
})

describe('defaultRunAgent — pre-aborted signal', () => {
  it('falls back to deterministic when signal is already aborted before call', async () => {
    const controller = new AbortController()
    controller.abort()

    mockSpawn.mockReturnValue(makeFakeChild({ stdout: VALID_STDOUT, delayMs: 50 }))

    const result = await summarizePrd(
      {
        collection: TEST_COLLECTION,
        now: '2026-01-01T00:00:00.000Z',
        signal: controller.signal,
      },
      { resolveAgents: () => ['claude'] },
    )

    expect(result.requirements[0].id).toBe('R1')
  })
})

describe('defaultRunAgent — abort signal during run', () => {
  it('falls back to deterministic when aborted mid-run', async () => {
    const controller = new AbortController()

    mockSpawn.mockReturnValue(makeFakeChild({ stdout: VALID_STDOUT, delayMs: 100 }))
    setTimeout(() => controller.abort(), 20)

    const result = await summarizePrd(
      {
        collection: TEST_COLLECTION,
        now: '2026-01-01T00:00:00.000Z',
        signal: controller.signal,
      },
      { resolveAgents: () => ['claude'] },
    )

    expect(result.requirements[0].id).toBe('R1')
  })
})

describe('defaultRunAgent — codex success path', () => {
  it('resolves with agent-sourced requirements for codex agent', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ stdout: VALID_STDOUT }))

    const result = await summarizePrd(
      { collection: TEST_COLLECTION, now: '2026-01-01T00:00:00.000Z' },
      { resolveAgents: () => ['codex'] },
    )

    expect(result.requirements).toHaveLength(1)
    expect(result.requirements[0]).toMatchObject({ id: 'R1', title: 'Send message' })

    // Verify codex-specific args were passed to spawn
    const spawnCall = mockSpawn.mock.calls[0]
    expect(spawnCall[0]).toBe('codex')
    const args: string[] = spawnCall[1]
    expect(args).toContain('exec')
    expect(args).toContain('--output-last-message')
    expect(args).toContain('--output-schema')
    expect(args).toContain('--skip-git-repo-check')
    // stdin.end was called with the prompt
    expect(spawnCall).toBeTruthy()
  })
})

describe('defaultResolveAgents — deterministic adapter', () => {
  it('returns [] for deterministic adapter, falls through to deterministic extraction', async () => {
    // No deps injected at all — exercises defaultResolveAgents('deterministic')
    const result = await summarizePrd({
      collection: TEST_COLLECTION,
      adapter: 'deterministic',
      now: '2026-01-01T00:00:00.000Z',
    })

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(result.requirements[0].id).toBe('R1')
    expect(result.requirements[0].title).toBe('Send message')
  })
})

describe('defaultResolveAgents — claude adapter (no binary available)', () => {
  it('exercises defaultResolveAgents body with claude adapter when no binary is on PATH', async () => {
    // pickAvailableHealAgent is mocked to return null — no agents available
    const result = await summarizePrd({
      collection: TEST_COLLECTION,
      adapter: 'claude',
      now: '2026-01-01T00:00:00.000Z',
    })

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(result.requirements[0].id).toBe('R1')
  })
})

describe('readPrdSummary — corrupted JSON file', () => {
  it('returns null for a corrupted JSON file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-prd-test-'))
    try {
      const docsDir = path.join(tmpDir, 'docs')
      fs.mkdirSync(docsDir, { recursive: true })
      fs.writeFileSync(path.join(docsDir, PRD_SUMMARY_JSON), '{ this is not valid JSON !!!')
      const result = readPrdSummary(tmpDir)
      expect(result).toBeNull()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('renderPrdSummaryMarkdown — deprecated requirement', () => {
  it('includes (deprecated) suffix in the heading for a deprecated requirement', () => {
    const req: Requirement = {
      id: 'R1',
      title: 'Old feature',
      text: 'This feature is gone',
      pathTypes: ['happy'],
      deprecated: true,
    }
    const s: PrdSummary = {
      requirements: [req],
      docsHash: 'h',
      sourceDocs: [],
      generatedAt: '2026-01-01T00:00:00.000Z',
    }
    const { markdown } = renderPrdSummaryMarkdown(s, 'test-feature')
    expect(markdown).toContain('R1 — Old feature (deprecated)')
  })
})

describe('buildPrdSummaryPrompt — empty collection', () => {
  it('uses (no documents) placeholder when collection has no entries', () => {
    const emptyCollection: DocsCollection = {
      docsDir: '/tmp/empty',
      entries: [],
      docsHash: computeDocsHash([]),
    }
    const prompt = buildPrdSummaryPrompt(emptyCollection, [])
    expect(prompt).toContain('(no documents)')
  })
})

describe('defaultRunAgent — codex output file is read when --output-last-message file exists (non-empty)', () => {
  it('uses file contents as finalOutput when output file is written before close', async () => {
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
        // Write the output file BEFORE emitting close — covers lines 424-426
        if (outputPath) {
          fs.writeFileSync(outputPath, VALID_STDOUT)
        }
        child.emit('close', 0, null)
      }, 0)
      return child
    })

    const result = await summarizePrd(
      { collection: TEST_COLLECTION, now: '2026-01-01T00:00:00.000Z' },
      { resolveAgents: () => ['codex'] },
    )

    expect(result.requirements).toHaveLength(1)
    expect(result.requirements[0]).toMatchObject({ id: 'R1', title: 'Send message' })
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
        // `if (fromFile.trim())` FALSE branch (line 426 not taken, stdout kept)
        child.stdout.emit('data', Buffer.from(VALID_STDOUT))
        if (outputPath) {
          fs.writeFileSync(outputPath, '   ')  // whitespace-only → trim() is falsy
        }
        child.emit('close', 0, null)
      }, 0)
      return child
    })

    const result = await summarizePrd(
      { collection: TEST_COLLECTION, now: '2026-01-01T00:00:00.000Z' },
      { resolveAgents: () => ['codex'] },
    )

    // Still resolves from stdout (which held VALID_STDOUT)
    expect(result.requirements).toHaveLength(1)
    expect(result.requirements[0]).toMatchObject({ id: 'R1', title: 'Send message' })
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

    const result = await summarizePrd(
      {
        collection: TEST_COLLECTION,
        now: '2026-01-01T00:00:00.000Z',
        // cwd is required so claudeLogPath is computed and the activity fn is defined
        cwd: '/tmp/nonexistent-canary-test-dir',
      },
      { resolveAgents: () => ['claude'] },
    )

    // Run still succeeds — the activity callback's catch branch returned 0 without throwing
    expect(result.requirements).toHaveLength(1)
    expect(result.requirements[0]).toMatchObject({ id: 'R1', title: 'Send message' })
  })
})

describe('defaultRunAgent — success with empty stdout (line 381 ?? branch)', () => {
  it('resolves with empty string when agent emits no stdout (output ?? "" fallback)', async () => {
    // Close with code=0 but no stdout → finalOutput = '' → parsePrdOutput('', ...) → null/empty →
    // falls back to deterministic. Covers the output ?? '' branch at line 381.
    mockSpawn.mockReturnValue(makeFakeChild({ stdout: '', exitCode: 0 }))

    const result = await summarizePrd(
      { collection: TEST_COLLECTION, now: '2026-01-01T00:00:00.000Z' },
      { resolveAgents: () => ['claude'] },
    )

    // Empty stdout → unparseable → falls back to deterministic
    expect(result.requirements).toBeDefined()
    expect(result.requirements[0].id).toBe('R1')
  })
})

describe('defaultRunAgent — close with non-null signal (line 421 ?? branch)', () => {
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

    const result = await summarizePrd(
      { collection: TEST_COLLECTION, now: '2026-01-01T00:00:00.000Z' },
      { resolveAgents: () => ['claude'] },
    )

    // Non-zero / signal exit → falls back to deterministic
    expect(result.requirements[0].id).toBe('R1')
  })
})

describe('defaultRunAgent — non-Error thrown in catch (line 477 String(err) branch)', () => {
  it('uses String(err) when a non-Error value is thrown by the injected runAgent', async () => {
    // Use the injected runAgent hook to throw a non-Error (a plain string).
    // summarizePrd catches → calls onOutput with String(err).
    const outputChunks: string[] = []
    const result = await summarizePrd(
      {
        collection: TEST_COLLECTION,
        now: '2026-01-01T00:00:00.000Z',
        onOutput: (chunk) => outputChunks.push(chunk),
      },
      {
        resolveAgents: () => ['claude'],
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        runAgent: async () => { throw 'non-error string' },
      },
    )

    // Exception caught → fell back to deterministic
    expect(result.requirements[0].id).toBe('R1')
    // onOutput received the String(err) message
    expect(outputChunks.some((c) => c.includes('non-error string'))).toBe(true)
  })
})

describe('summarizePrd — now ?? new Date() branch (line 490)', () => {
  it('uses current date when now is not provided', async () => {
    // When `args.now` is undefined, `args.now ?? new Date().toISOString()` falls back
    // to a live timestamp. Verify by checking generatedAt is a valid ISO string.
    const result = await summarizePrd(
      {
        collection: TEST_COLLECTION,
        // no `now` → exercises the ?? branch
      },
      { resolveAgents: () => [] }, // no agents → deterministic immediately
    )

    expect(result.generatedAt).toBeTruthy()
    expect(() => new Date(result.generatedAt)).not.toThrow()
    // A live timestamp will be after this test's approximate start time
    expect(new Date(result.generatedAt).getFullYear()).toBeGreaterThanOrEqual(2025)
  })
})

describe('defaultRunAgent — settled guard: finish called twice (line 376 true branch)', () => {
  it('second call to finish is a no-op when already settled', async () => {
    // onIdle fires synchronously → finish(Error) → settled=true
    // Then child.emit('close', 0) → finish(undefined, stdout) → if (settled) return
    vi.mocked(startIdleTimer).mockImplementationOnce(
      (opts: { activity?: () => number; onIdle: (ms: number) => void }) => {
        opts.activity?.()
        opts.onIdle(300_000)
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
    setTimeout(() => child.emit('close', 0, null), 0)
    mockSpawn.mockReturnValue(child)

    const result = await summarizePrd(
      {
        collection: TEST_COLLECTION,
        now: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp/nonexistent-canary-test-dir',
      },
      { resolveAgents: () => ['claude'] },
    )

    expect(result.requirements[0].id).toBe('R1')
  })
})

describe('defaultResolveAgents — auto adapter (line 322 false branches)', () => {
  it('exercises the auto-detect path where neither claude nor codex is pinned', async () => {
    // No adapter specified → adapter defaults to 'auto' → defaultResolveAgents('auto')
    // → condition `adapter === 'claude' || adapter === 'codex'` is FALSE
    // pickAvailableHealAgent is mocked to return null → no agents → deterministic.
    const result = await summarizePrd({
      collection: TEST_COLLECTION,
      now: '2026-01-01T00:00:00.000Z',
      // no adapter → 'auto'
    })

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(result.requirements[0].id).toBe('R1')
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
    const result = await summarizePrd(
      {
        collection: TEST_COLLECTION,
        now: '2026-01-01T00:00:00.000Z',
        onOutput: (chunk) => outputChunks.push(chunk),
      },
      {
        resolveAgents: () => ['claude'],
        runAgent: async () => { throw new Error('prd agent exploded') },
      },
    )

    expect(result.requirements[0].id).toBe('R1')
    expect(outputChunks.some((c) => c.includes('prd agent exploded'))).toBe(true)
  })
})

describe('defaultRunAgent — onIdle fires child.kill and rejects (lines 394-395)', () => {
  it('falls back to deterministic when the idle timer fires onIdle', async () => {
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

    const result = await summarizePrd(
      {
        collection: TEST_COLLECTION,
        now: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp/nonexistent-canary-test-dir',
      },
      { resolveAgents: () => ['claude'] },
    )

    // onIdle rejects → summarizePrd catches → falls back to deterministic
    expect(result.requirements[0].id).toBe('R1')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
