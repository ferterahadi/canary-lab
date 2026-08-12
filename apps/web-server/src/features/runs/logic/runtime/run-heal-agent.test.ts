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
  createHealActivityClock,
  interjectHealAgent,
  persistAgentSessionRef,
  runHealAgent,
  spawnHealAgentRepl,
  waitForHealSignal,
} from './run-heal-agent'
import { HEAL_AGENT_TAIL_BYTES } from './heal-agent-text'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import type { RunContext } from './run-context'
import type { PtyFactory, PtyHandle } from './pty-spawner'

let tmpDir: string

// cleanupHealAgentPty calls the REAL killTree + scheduleSigkillFallback, which
// signal process GROUPS via process.kill(-pid). Block the real process.kill so
// a fake pty can never reach one (same convention as boot-probe.test.ts — a
// fake `pid: 1` here once became kill(-1), a SIGTERM to every user process).
// The fixtures below keep `pid: 1` DELIBERATELY: pids ≤ 1 are refused by the
// helpers' own pgid guard, so even the unref'd 2s SIGKILL-fallback timer that
// fires after this suite's mocks are restored stays inert.
beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('blocked in test') })
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

  it('uses Claude fullscreen rendering only for its own Claude heal REPL', () => {
    const { ctx: claude } = ctxFor({}, { autoHeal: { agent: 'claude', maxCycles: 1 } })
    const { ctx: codex } = ctxFor({}, { autoHeal: { agent: 'codex', maxCycles: 1 } })

    expect(agentPtyEnv(claude).CLAUDE_CODE_NO_FLICKER).toBe('1')
    expect(agentPtyEnv(codex).CLAUDE_CODE_NO_FLICKER).toBeUndefined()
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
      autoHeal: { agent: 'claude', maxCycles: 1 },
    })

    spawnHealAgentRepl(ctx)

    expect(spawns[0].env?.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe('1')
    expect(spawns[0].env?.CLAUDE_CODE_NO_FLICKER).toBe('1')
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

// The clock behind both the idle give-up and the prompt re-send. It exists
// because the pty stream lies: an idle claude REPL repaints its footer forever,
// so `lastAgentDataAt` keeps advancing for an agent that stopped working
// minutes ago. Every test here pins the difference between the two sources.
describe('createHealActivityClock', () => {
  /** Point the run's session-ref store at `logPath` the way a real cycle does. */
  function writeSessionRef(ctx: RunContext, logPath: string): void {
    fs.writeFileSync(ctx.paths.agentSessionRefPath, JSON.stringify({
      activeAgent: 'claude',
      sessions: { claude: { agent: 'claude', sessionId: 'sess-1', logPath } },
    }))
  }

  it('falls back to the pty clock before a session log has been located', () => {
    // Cycle 1 legitimately has no ref yet — it is written when the first
    // cycle's wait ends — so the pty is all there is to go on.
    const { ctx } = ctxFor({ lastAgentDataAt: 5_000 }, { autoHeal: { agent: 'claude', maxCycles: 1 } })

    expect(createHealActivityClock(ctx, 1_000)()).toBe(5_000)
  })

  it('reports session-log growth and ignores pty chatter', () => {
    const logPath = path.join(tmpDir, 'session.jsonl')
    fs.writeFileSync(logPath, '{"type":"user"}\n')
    const { ctx } = ctxFor({ lastAgentDataAt: 5_000 }, { autoHeal: { agent: 'claude', maxCycles: 1 } })
    writeSessionRef(ctx, logPath)
    const clock = createHealActivityClock(ctx, 1_000)

    const firstReading = clock()
    // A repainting TUI moves the pty clock. The agent has written nothing, so
    // the reading must not move with it.
    ctx.lastAgentDataAt = 9_000_000
    expect(clock()).toBe(firstReading)

    fs.appendFileSync(logPath, '{"type":"assistant"}\n')
    expect(clock()).toBeGreaterThanOrEqual(firstReading)
    expect(clock()).not.toBe(9_000_000)
  })

  it('counts a shrinking log as activity, not a stall', () => {
    const logPath = path.join(tmpDir, 'session.jsonl')
    fs.writeFileSync(logPath, 'x'.repeat(500))
    const { ctx } = ctxFor({ lastAgentDataAt: 1 }, { autoHeal: { agent: 'claude', maxCycles: 1 } })
    writeSessionRef(ctx, logPath)
    const clock = createHealActivityClock(ctx, 1_000)
    const before = clock()

    fs.writeFileSync(logPath, 'x')
    const after = clock()

    // Growth-only tracking would read a truncation as "nothing happened" and
    // start counting down to a give-up while the agent was still writing.
    expect(after).toBeGreaterThanOrEqual(before)
    expect(after).not.toBe(1)
  })

  it('falls back to the pty clock when the ref points at a missing file', () => {
    const { ctx } = ctxFor({ lastAgentDataAt: 7_000 }, { autoHeal: { agent: 'claude', maxCycles: 1 } })
    writeSessionRef(ctx, path.join(tmpDir, 'not-written-yet.jsonl'))

    expect(createHealActivityClock(ctx, 1_000)()).toBe(7_000)
  })
})

describe('waitForHealSignal activity source', () => {
  /** A ctx whose session log exists and never grows — a REPL sitting idle. */
  function stalledAgentCtx(over: Record<string, unknown> = {}) {
    const made = ctxFor(
      { healAgentPty: { write: vi.fn() } as unknown as PtyHandle },
      {
        autoHeal: { agent: 'claude', maxCycles: 1 },
        healSignalPollMs: 2,
        healAgentTimeoutMs: 10_000,
        healAgentIdleTimeoutMs: 150,
        healAgentPromptNudgeMs: 40,
        ...over,
      },
    )
    const logPath = path.join(tmpDir, 'stalled.jsonl')
    fs.writeFileSync(logPath, '{"type":"system"}\n')
    fs.writeFileSync(made.ctx.paths.agentSessionRefPath, JSON.stringify({
      activeAgent: 'claude',
      sessions: { claude: { agent: 'claude', sessionId: 'sess-1', logPath } },
    }))
    return made
  }

  it('gives up on a stalled agent even while the pty keeps emitting', async () => {
    const { ctx } = stalledAgentCtx()
    // Stand in for the TUI footer repaint: a chunk every few ms, forever.
    const repaint = setInterval(() => { ctx.lastAgentDataAt = Date.now() }, 5)

    try {
      const { signal, reason } = await waitForHealSignal(ctx)
      // Reading the pty alone, this wait never ends — the idle window is reset
      // faster than it elapses, and the cycle burns the full hard ceiling.
      expect(reason).toBe('idle-timeout')
      expect(signal).toBeNull()
    } finally {
      clearInterval(repaint)
    }
  })

  it('re-sends the cycle prompt on silence, capped at two attempts', async () => {
    const { ctx } = stalledAgentCtx()
    const onSilence = vi.fn()

    const { reason } = await waitForHealSignal(ctx, undefined, undefined, true, onSilence)

    // The nudge window (40ms) fits three times inside the idle window (150ms);
    // the cap, not the clock, is what stops the third re-send.
    expect(reason).toBe('idle-timeout')
    expect(onSilence).toHaveBeenCalledTimes(2)
  })

  it('does not re-send while the agent is still writing', async () => {
    const { ctx } = stalledAgentCtx()
    const logPath = path.join(tmpDir, 'stalled.jsonl')
    const onSilence = vi.fn()
    // Real work: a line every 10ms, comfortably inside the 40ms nudge window.
    // A working agent has no timeout to hit, so the wait is ended from the
    // outside once it has outlived several nudge windows — the point is what
    // did NOT happen during them.
    const writing = setInterval(() => { fs.appendFileSync(logPath, '{"type":"assistant"}\n') }, 10)
    const stop = setTimeout(() => { ctx.stopped = true }, 200)

    try {
      const { reason } = await waitForHealSignal(ctx, undefined, undefined, true, onSilence)
      expect(reason).toBe('stopped')
    } finally {
      clearInterval(writing)
      clearTimeout(stop)
    }

    expect(onSilence).not.toHaveBeenCalled()
  })
})

describe('runHealAgent cycle-prompt re-send', () => {
  /** A cycle-2 context: the REPL is already alive, so `runHealAgent` re-prompts
   *  it over stdin instead of spawning, and its session log is on disk and
   *  still — the shape in which a swallowed paste strands the cycle. */
  function cycleTwoCtx(write: PtyHandle['write']) {
    const made = ctxFor(
      { healAgentPty: { write } as unknown as PtyHandle },
      {
        autoHeal: { agent: 'claude', maxCycles: 2, buildCyclePrompt: () => 'prompt' },
        healSignalPollMs: 2,
        healAgentTimeoutMs: 10_000,
        healAgentIdleTimeoutMs: 150,
        healAgentPromptNudgeMs: 40,
      },
    )
    const logPath = path.join(tmpDir, 'cycle-two.jsonl')
    fs.writeFileSync(logPath, '{"type":"system"}\n')
    fs.writeFileSync(made.ctx.paths.agentSessionRefPath, JSON.stringify({
      activeAgent: 'claude',
      sessions: { claude: { agent: 'claude', sessionId: 'sess-1', logPath } },
    }))
    return made
  }

  it('re-sends the prompt and says so when the agent never picks the cycle up', async () => {
    const write = vi.fn()
    const { ctx, events } = cycleTwoCtx(write)

    const { reason } = await runHealAgent(ctx, { cycle: 2, failedSlugs: ['a'] })

    expect(reason).toBe('idle-timeout')
    // The opening send plus both re-sends, all carrying the same instruction.
    expect(write).toHaveBeenCalledTimes(3)
    expect(write.mock.calls.every(([chunk]) => String(chunk).includes('continue the auto-heal cycle now'))).toBe(true)
    const notices = events.filter((e) =>
      JSON.stringify(e.payload).includes('re-sent the cycle prompt'))
    // Silent recovery would leave the operator reading a stalled cycle with no
    // explanation for the duplicate prompt in the pane.
    expect(notices).toHaveLength(2)
  })

  it('stays quiet when the re-send cannot reach a dead REPL', async () => {
    let sends = 0
    const write = vi.fn(() => {
      sends += 1
      // The opening send lands; the REPL dies before the first re-send.
      if (sends > 1) throw new Error('pty gone')
    })
    const { ctx, events } = cycleTwoCtx(write as unknown as PtyHandle['write'])

    const { reason } = await runHealAgent(ctx, { cycle: 2, failedSlugs: ['a'] })

    // A throw out of the re-send would reject the wait and take the heal loop
    // with it, so the failure has to stay contained.
    expect(reason).toBe('idle-timeout')
    expect(events.some((e) => JSON.stringify(e.payload).includes('re-sent the cycle prompt'))).toBe(false)
  })
})
