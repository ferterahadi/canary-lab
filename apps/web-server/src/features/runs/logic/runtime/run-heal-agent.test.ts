// Heal-agent helpers driven directly: the interject journal note, the rolling
// output tail, and the REPL spawn/exit bookkeeping. The orchestrator tests
// always inject a spawn-command builder and a short interject, so these arms
// only show up when the functions are called on their own.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  agentPtyEnv,
  appendAgentOutputTail,
  cleanupHealAgentPty,
  interjectHealAgent,
  persistAgentSessionRef,
  spawnHealAgentRepl,
} from './run-heal-agent'
import { HEAL_AGENT_TAIL_BYTES } from './heal-agent-text'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import type { RunContext } from './run-context'
import type { PtyFactory, PtyHandle } from './pty-spawner'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-agent-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** A pty whose exit handler the test can fire on demand. */
function fakePtyFactory(): {
  factory: PtyFactory
  made: Array<{ handle: PtyHandle; exit: (code: number) => void }>
  /** Spawn options as the factory received them — proves what reached the pty. */
  spawns: Array<{ env?: NodeJS.ProcessEnv }>
} {
  const made: Array<{ handle: PtyHandle; exit: (code: number) => void }> = []
  const spawns: Array<{ env?: NodeJS.ProcessEnv }> = []
  const factory: PtyFactory = (opts) => {
    spawns.push({ env: opts.env })
    let onExit: ((e: { exitCode: number }) => void) | undefined
    const handle = {
      pid: 4242,
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { onExit = cb; return { dispose: () => {} } },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    } as unknown as PtyHandle
    made.push({ handle, exit: (exitCode) => onExit?.({ exitCode }) })
    return handle
  }
  return { factory, made, spawns }
}

function ctxFor(state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  const made = makeHealLoopContext({ root: tmpDir, opts, state })
  fs.mkdirSync(made.ctx.runDir, { recursive: true })
  fs.mkdirSync(made.ctx.paths.signalsDir, { recursive: true })
  return made
}

describe('interjectHealAgent', () => {
  it('truncates a long interject in the journal note', async () => {
    const pty = { write: vi.fn() } as unknown as PtyHandle
    const { ctx } = ctxFor({ status: 'healing', healAgentPty: pty })
    const long = 'x'.repeat(500)

    await interjectHealAgent(ctx, long)

    const journal = fs.readFileSync(ctx.paths.diagnosisJournalPath, 'utf-8')
    // 200 characters plus the ellipsis — not the whole 500.
    expect(journal).toContain('x'.repeat(200) + '…')
    expect(journal).not.toContain('x'.repeat(201))
  })

  it('keeps a short interject verbatim', async () => {
    const pty = { write: vi.fn() } as unknown as PtyHandle
    const { ctx } = ctxFor({ status: 'healing', healAgentPty: pty })

    await interjectHealAgent(ctx, 'check the cart total')

    expect(fs.readFileSync(ctx.paths.diagnosisJournalPath, 'utf-8'))
      .toContain('User interjected mid-heal: check the cart total')
  })
})

describe('appendAgentOutputTail', () => {
  it('keeps the whole output while it fits in the tail budget', () => {
    const { ctx } = ctxFor()

    appendAgentOutputTail(ctx, 'first ')
    appendAgentOutputTail(ctx, 'second')

    expect(ctx.healAgentOutputTail).toBe('first second')
  })

  it('drops the oldest bytes once the tail overflows', () => {
    const { ctx } = ctxFor()
    ctx.healAgentOutputTail = 'A'.repeat(HEAL_AGENT_TAIL_BYTES)

    appendAgentOutputTail(ctx, 'THE-END')

    expect(ctx.healAgentOutputTail).toHaveLength(HEAL_AGENT_TAIL_BYTES)
    expect(ctx.healAgentOutputTail.endsWith('THE-END')).toBe(true)
    expect(ctx.healAgentOutputTail.startsWith('A')).toBe(true)
  })
})

describe('agentPtyEnv', () => {
  it('forces transcript persistence so an inherited child-session marker cannot silence the agent', () => {
    const { ctx } = ctxFor()

    // Load-bearing, not cosmetic: an interactive claude REPL that inherits
    // `CLAUDE_CODE_CHILD_SESSION` (which it does whenever the UI server was itself
    // launched from a Claude Code session) writes no session JSONL at all. That
    // leaves AgentSessionView blank and Restart Heal's `--resume` with nothing to
    // resume — both reading as an agent that did nothing.
    expect(agentPtyEnv(ctx).CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe('1')
  })
})

describe('spawnHealAgentRepl', () => {
  it('refuses to spawn when the run has no auto-heal config', () => {
    const { ctx } = ctxFor()
    expect(() => spawnHealAgentRepl(ctx)).toThrow('autoHeal not configured')
  })

  it('hands back the live REPL instead of spawning a second one', () => {
    const existing = { write: vi.fn() } as unknown as PtyHandle
    const { ctx } = ctxFor({ healAgentPty: existing }, { autoHeal: { agent: 'codex', maxCycles: 1 } })

    expect(spawnHealAgentRepl(ctx)).toBe(existing)
  })

  it('falls back to the built-in spawn command when the run pins none', () => {
    const { factory, made } = fakePtyFactory()
    const { ctx } = ctxFor({}, {
      ptyFactory: factory,
      autoHeal: { agent: 'codex', maxCycles: 1 },
    })

    const pty = spawnHealAgentRepl(ctx)

    expect(pty).toBe(made[0].handle)
    expect(ctx.healAgentPty).toBe(made[0].handle)
    expect(ctx.healAgentStartedAt).toEqual(expect.any(String))
  })

  it('carries the transcript-persistence override through to the pty it spawns', () => {
    const { factory, spawns } = fakePtyFactory()
    const { ctx } = ctxFor({}, {
      ptyFactory: factory,
      autoHeal: { agent: 'codex', maxCycles: 1 },
    })

    spawnHealAgentRepl(ctx)

    expect(spawns[0].env?.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe('1')
  })

  it('clears the handle and reports the exit when its own REPL dies', () => {
    const { factory, made } = fakePtyFactory()
    const { ctx, events } = ctxFor({}, {
      ptyFactory: factory,
      autoHeal: { agent: 'codex', maxCycles: 1 },
    })
    spawnHealAgentRepl(ctx)

    made[0].exit(3)

    expect(ctx.healAgentPty).toBeNull()
    expect(events).toContainEqual({ event: 'agent-exit', payload: { exitCode: 3 } })
  })

  it('stays quiet when a superseded REPL exits after cleanup swapped the handle', () => {
    const { factory, made } = fakePtyFactory()
    const { ctx, events } = ctxFor({}, {
      ptyFactory: factory,
      autoHeal: { agent: 'codex', maxCycles: 1 },
    })
    spawnHealAgentRepl(ctx)
    // cleanupHealAgentPty (or a later spawn) already re-pointed the field; the
    // stale pty's exit must not clear it or emit a second agent-exit.
    const replacement = { write: vi.fn() } as unknown as PtyHandle
    ctx.healAgentPty = replacement

    made[0].exit(1)

    expect(ctx.healAgentPty).toBe(replacement)
    expect(events.filter((e) => e.event === 'agent-exit')).toEqual([])
  })
})

describe('cleanupHealAgentPty', () => {
  it('is a no-op when no REPL is attached', () => {
    const { ctx, events } = ctxFor()
    expect(() => cleanupHealAgentPty(ctx)).not.toThrow()
    expect(events).toEqual([])
  })

  it('tears the REPL down and reports the exit once', () => {
    const write = vi.fn()
    const pty = { write, kill: vi.fn(), pid: 1 } as unknown as PtyHandle
    const { ctx, events } = ctxFor({ healAgentPty: pty }, { autoHeal: { agent: 'codex', maxCycles: 1 } })

    cleanupHealAgentPty(ctx)

    // Field cleared FIRST so the spawn-time onExit handler skips its own emit.
    expect(ctx.healAgentPty).toBeNull()
    expect(write).toHaveBeenCalledWith('/exit\r')
    expect(events).toContainEqual({ event: 'agent-exit', payload: { exitCode: 0 } })
  })

  it('skips artifact capping when no MCP output dir was ever pinned', () => {
    // Only a claude spawn pins one; a codex run reaches cleanup with it unset.
    const pty = { write: vi.fn(), kill: vi.fn(), pid: 1 } as unknown as PtyHandle
    const { ctx } = ctxFor(
      { healAgentPty: pty, healAgentMcpOutputDir: undefined },
      { autoHeal: { agent: 'codex', maxCycles: 1 } },
    )

    expect(() => cleanupHealAgentPty(ctx)).not.toThrow()
    expect(ctx.healAgentMcpOutputDir).toBeUndefined()
  })

  it('caps the artifacts when a dir was pinned, and survives a capping failure', () => {
    const pty = { write: vi.fn(), kill: vi.fn(), pid: 1 } as unknown as PtyHandle
    // A path that is a FILE, so the capper's directory walk throws.
    const notADir = path.join(tmpDir, 'mcp-out')
    fs.writeFileSync(notADir, 'not a directory')
    const { ctx } = ctxFor(
      { healAgentPty: pty, healAgentMcpOutputDir: notADir },
      { autoHeal: { agent: 'claude', maxCycles: 1 } },
    )

    expect(() => cleanupHealAgentPty(ctx)).not.toThrow()
    expect(ctx.healAgentMcpOutputDir).toBeUndefined()
    expect(ctx.healAgentSessionId).toBeNull()
  })
})

describe('persistAgentSessionRef', () => {
  it('does nothing when the run has no auto-heal config', () => {
    const { ctx } = ctxFor()
    const persistActive = vi.spyOn(ctx.agentSessionRefs, 'persistActive')

    persistAgentSessionRef(ctx)

    expect(persistActive).not.toHaveBeenCalled()
  })

  it('records the agent plus whichever pointers this run captured', () => {
    const { ctx } = ctxFor(
      { healAgentSessionId: 'sess-1', healAgentStartedAt: '2026-08-03T11:00:00.000Z' },
      { autoHeal: { agent: 'claude', maxCycles: 1 } },
    )
    const persistActive = vi.spyOn(ctx.agentSessionRefs, 'persistActive').mockImplementation(() => {})

    persistAgentSessionRef(ctx)

    expect(persistActive).toHaveBeenCalledWith({
      agent: 'claude',
      sessionId: 'sess-1',
      startedAt: '2026-08-03T11:00:00.000Z',
    })
  })
})
