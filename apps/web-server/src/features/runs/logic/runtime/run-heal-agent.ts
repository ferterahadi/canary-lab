// Driving the heal agent's terminal: spawning the REPL once per heal session,
// handing it each cycle's prompt, streaming its output to the pane and the tail
// file, waiting for the signal it writes, and tearing it down. The REPL persists
// across cycles by design — cycle handoff is a stdin write, not a respawn.
// Split out of orchestrator.ts; the bodies are unchanged.
import { type RunContext } from './run-context'
import type { InterjectResult } from './orchestrator'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { type HealEnd, type HealSignal } from '../../../../../../../shared/run-state'
import { classifyHealFailure } from './heal-failure-classifier'
import { ensureClaudeWorkspaceTrusted } from '../../../agent-sessions/logic/agent-workspace-trust'
import type { PtyHandle } from './pty-spawner'
import { HealCycleState } from './heal-cycle'
import { ESCALATION_THRESHOLD } from './heal-escalation'
import {
  resolveMcpOutputDir,
  ensureMcpOutputDir,
  capArtifacts,
} from './playwright-mcp-artifacts'
import { BRACKETED_PASTE_BEGIN, BRACKETED_PASTE_END, defaultSpawnCommand, killTree, scheduleSigkillFallback } from './run-spawn'
import { HEAL_AGENT_TAIL_BYTES, defaultHealPrompt, formatUserInterjectBlock } from './heal-agent-text'
import { appendJournalIteration, recordLifecycle } from './run-manifest-writer'

/**
 * Interrupt & Redirect — drop the user's correction into the live REPL's
 * stdin. The agent absorbs it like any other typed message: Esc interrupts
 * any in-flight generation, then the text is sent followed by Enter. The
 * run stays in `healing` throughout; verification does not begin until the
 * agent writes a `.rerun` / `.restart` / `.heal` signal.
 *
 * No respawn, no session-id race — the REPL is alive across cycles, and
 * everything we'd previously rebuild from `--resume <sid>` is just the
 * existing conversation.
 *
 *   - `no-agent-running`: REPL hasn't spawned (cycle 0) or has exited
 *     (cancel, crash, manual mode).
 */
export async function interjectHealAgent(ctx: RunContext, text: string): Promise<InterjectResult> {
  const pty = ctx.healAgentPty
  if (!pty) return { ok: false, reason: 'no-agent-running' }

  echoUserInterject(ctx, text)

  // Best-effort journal note so the interject is part of run history.
  try {
    const truncated = text.length > 200 ? text.slice(0, 200) + '…' : text
    appendJournalIteration(ctx, {
      signal: '.rerun',
      hypothesis: `User interjected mid-heal: ${truncated}`,
      fixDescription: `Sent text to live REPL stdin.`,
      runId: ctx.runId,
      manifestPath: ctx.paths.manifestPath,
      summaryPath: ctx.paths.summaryPath,
      journalPath: ctx.paths.diagnosisJournalPath,
    })
  } catch { /* journal append is best-effort */ }

  // Esc first to interrupt any in-flight generation, then the text as a
  // bracketed paste followed by Enter. Bracketed paste keeps the REPL's
  // input editor from re-rendering the text word-by-word — same reason
  // `runHealAgent` uses it for cycle prompts. Esc is harmless when idle;
  // claude/codex treat it as "cancel current generation".
  try {
    pty.write('')
    pty.write(BRACKETED_PASTE_BEGIN + text + BRACKETED_PASTE_END + '\r')
  } catch {
    return { ok: false, reason: 'no-agent-running' }
  }
  ctx.emit('agent-started', { cycle: ctx.healCycles, command: '<repl-redirect>', redirect: true })
  return { ok: true }
}

// Forward raw REPL output (ANSI from xterm.js's perspective) into the
// `agent-output` event — the pane broker pushes those chunks to live
// xterm subscribers. Historical replay no longer reads from a raw
// transcript file; the structured-view route reads the agent CLI's own
// JSONL session log instead.
//
// Each chunk bumps `lastAgentDataAt` so `waitForHealSignal` can detect
// an idle REPL (no output for `healAgentIdleTimeoutMs`) while not
// killing an actively-thinking one.
export function attachAgentDataHandlers(ctx: RunContext, pty: PtyHandle): void {
  pty.onData((chunk) => {
    ctx.lastAgentDataAt = Date.now()
    appendAgentOutputTail(ctx, chunk)
    ctx.emit('agent-output', { chunk })
  })
}

// Keep only the last HEAL_AGENT_TAIL_BYTES of agent output. A usage-limit /
// auth banner is always near the end (the agent prints it and stops), so the
// tail is where the classifier finds its evidence.
export function appendAgentOutputTail(ctx: RunContext, chunk: string): void {
  const combined = ctx.healAgentOutputTail + chunk
  ctx.healAgentOutputTail =
    combined.length > HEAL_AGENT_TAIL_BYTES
      ? combined.slice(combined.length - HEAL_AGENT_TAIL_BYTES)
      : combined
}

// Persist the captured tail and classify why the agent went quiet. Called
// only from the no-signal give-up path. Best-effort: a failed write still
// lets the loop end cleanly, it just leaves `agentCause` unclassified.
export function captureHealAgentCause(ctx: RunContext): HealEnd['agentCause'] {
  const tail = ctx.healAgentOutputTail
  if (tail.trim() !== '') {
    try {
      fs.writeFileSync(ctx.paths.healAgentTailPath, tail)
    } catch { /* tail persistence is best-effort */ }
  }
  return classifyHealFailure(tail, ctx.autoHeal?.agent)
}

// Write the typed give-up reason to the manifest so the Test Run surface can
// state it plainly. One writer, called at each give-up site in the loop.
export function recordHealEnd(ctx: RunContext, healEnd: HealEnd): void {
  ctx.stateSink.patchManifest(ctx.runId, { healEnd })
}

export function echoUserInterject(ctx: RunContext, text: string): void {
  const block = formatUserInterjectBlock(text, ctx.startedAt)
  ctx.emit('agent-output', { chunk: block })
}

export function emitAgentSystemMessage(ctx: RunContext, message: string): void {
  ctx.emit('agent-output', { chunk: `\n[orchestrator] ${message}\n` })
}

/**
 * Grant the claude CLI folder trust over the project root so the heal pty
 * opens straight into the REPL. Trust inherits down, so one entry covers every
 * future run directory (see agent-workspace-trust.ts for the measured rules).
 *
 * This grants NO tool permissions — the REPL still asks before each call. Set
 * `CANARY_LAB_NO_WORKSPACE_TRUST=1` to leave the prompt in place and answer it
 * by hand in the agent pane.
 *
 * Both outcomes are announced in the transcript: a silent edit to the user's
 * CLI config would be the wrong kind of helpful, and a silent failure would
 * leave the next stall unexplained.
 */
export function ensureHealWorkspaceTrusted(ctx: RunContext): void {
  if (process.env.CANARY_LAB_NO_WORKSPACE_TRUST === '1') return
  if (!ctx.projectRoot) return
  const result = ensureClaudeWorkspaceTrusted(ctx.projectRoot)
  if (result.outcome === 'granted') {
    emitAgentSystemMessage(
      ctx,
      `Marked ${result.trustedPath} as a trusted folder for the claude CLI — without it the agent stops at its first-run trust prompt before reading anything. Tool approval is unchanged.`,
    )
  } else if (result.outcome === 'unavailable') {
    emitAgentSystemMessage(
      ctx,
      `Could not pre-trust the workspace for the claude CLI (${result.reason}). If the agent stalls on "Is this a project you created or one you trust?", answer it in the agent pane.`,
    )
  }
}

export function agentPtyEnv(ctx: RunContext): Record<string, string> {
  return {
    CANARY_LAB_PROJECT_ROOT: ctx.feature.featureDir,
    // Kept as a hint for tools or shell rc files that want to surface the
    // session id — the orchestrator writes the UUID to this path itself
    // (no formatter sidecar in REPL mode).
    CANARY_LAB_AGENT_SESSION_ID_FILE: ctx.paths.agentSessionIdPath,
    // Keep the agent's own JSONL transcript on disk. An interactive claude REPL
    // stops writing one the moment it sees an inherited `CLAUDE_CODE_CHILD_SESSION`
    // marker, and that marker rides in on `process.env` whenever the UI server was
    // itself launched from a Claude Code session — Desktop, an MCP client, or the
    // local `canary-apply` cycle. Measured on 2.1.220: the pane prints "Transcript
    // saving is off" and no `<session-id>.jsonl` is ever created.
    //
    // Canary depends on that file twice: AgentSessionView renders the heal agent
    // by tailing it, and Restart Heal continues the prior investigation with
    // `--resume <uuid>`. Both fail silently — as an agent that produced nothing
    // rather than a transcript we failed to find.
    //
    // This overrides the inherited-marker rule only. A user who deliberately turned
    // transcripts off (`CLAUDE_CODE_SKIP_PROMPT_HISTORY`, or the setting) still
    // wins, because the CLI resolves those causes first. The headless `-p` spawns
    // in `runAgentProcess` need nothing here: suppression is gated on the session
    // being interactive, confirmed by spawning both kinds with the marker set.
    CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
  }
}

// Block until a signal lands or we give up. Returns a tagged result so the
// caller can react to *why* the wait ended:
//   - signal:       agent wrote `.restart` / `.rerun` / `.heal`
//   - pty-died:     REPL exited (clean /exit, crash, or external kill),
//                   plus a short grace window so a write-then-exit signal
//                   isn't lost to the watcher race
//   - idle-timeout: REPL is alive but hasn't emitted any output for
//                   `healAgentIdleTimeoutMs` — usually a wedged REPL
//   - hard-timeout: REPL is alive and producing output but has been
//                   running for `healAgentTimeoutMs` (the absolute upper
//                   bound on a single cycle)
//   - stopped:      orchestrator aborted (full stop)
//   - cancelled:    user clicked Stop Heal mid-cycle
// The signal watcher feeds `signalGate`; this wait consumes one accepted
// signal and lets the gate audit duplicates or late files.
export async function waitForHealSignal(ctx: RunContext, 
  hardTimeoutMs: number = ctx.healAgentTimeoutMs,
  idleTimeoutMs: number = ctx.healAgentIdleTimeoutMs,
  requiresAgent: boolean = true,
): Promise<{
  signal: HealSignal | null
  reason: 'signal' | 'pty-died' | 'idle-timeout' | 'hard-timeout' | 'stopped' | 'cancelled'
}> {
  const startedAt = Date.now()
  // Seed the idle clock at the start of the wait so the first chunk-less
  // poll doesn't insta-trip the idle timeout.
  ctx.lastAgentDataAt = startedAt
  ctx.signalGate.beginWaiting()
  recordLifecycle(ctx, 'waiting-for-signal', 'Waiting for heal signal', {
    detail: 'The runner is waiting for .restart, .rerun, or .heal.',
    activeCycle: ctx.healCycles,
  })
  const hardDeadline = startedAt + hardTimeoutMs
  // Always yield to the macrotask queue here — this loop runs concurrently
  // with the signal-watcher setInterval, and a microtask-only delay would
  // starve the timer queue.
  const yieldOnce = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))
  // When the pty dies before we've seen a signal, give the signal-watcher
  // a short grace window to surface any `.heal`/`.rerun`/`.restart` file
  // the agent wrote just before exiting. Without this, the wait races the
  // watcher's polling and bails immediately, losing signals from agents
  // that write-then-exit. 1s is plenty — the watcher polls at
  // `healSignalPollMs` (≤1s in production).
  let postExitDeadline: number | null = null
  try {
    while (true) {
      if (ctx.stopped) return { signal: null, reason: 'stopped' }
      if (ctx.healCancelled) return { signal: null, reason: 'cancelled' }
      const sig = ctx.signalGate.consume()
      if (sig) {
        return { signal: sig, reason: 'signal' }
      }
      if (requiresAgent && !ctx.healAgentPty) {
        // Pty is dead: the `pty-died` grace owns the exit. Don't let the
        // hard/idle timeouts steal it — they describe a still-alive REPL,
        // which we no longer have.
        if (postExitDeadline === null) {
          postExitDeadline = Date.now() + 1000
        } else if (Date.now() >= postExitDeadline) {
          return { signal: null, reason: 'pty-died' }
        }
        await yieldOnce(Math.max(1, ctx.healSignalPollMs))
        continue
      }
      const now = Date.now()
      if (now >= hardDeadline) return { signal: null, reason: 'hard-timeout' }
      if (now - ctx.lastAgentDataAt >= idleTimeoutMs) {
        return { signal: null, reason: 'idle-timeout' }
      }
      await yieldOnce(Math.max(1, ctx.healSignalPollMs))
    }
  } finally {
    ctx.signalGate.endWaiting()
  }
}

/**
 * Run one heal cycle inside the persistent REPL.
 *
 * - On the first call (or after a cancel/crash), spawns the long-lived
 *   `claude` / `codex` REPL with `--session-id <uuid>` (claude) and the
 *   playwright MCP wired up.
 * - Renders the cycle prompt and writes it to the REPL's stdin —
 *   subsequent cycles all flow through the same conversation, so the
 *   agent retains context from prior cycles.
 * - Awaits a `.heal` / `.rerun` / `.restart` signal file (or cancel /
 *   timeout / full abort). Returns the signal the caller will interpret.
 *
 * `exitCode` in the return is 0 when the REPL is still alive when we
 * resolve, 1 when it died during the cycle (crash or kill). The auto-heal
 * loop uses it only to surface unexpected exits in the transcript.
 */
export async function runHealAgent(ctx: RunContext, args: {
  cycle: number
  failedSlugs: readonly string[]
  userGuidance?: string
  /**
   * Streak counter from `HealCycleState.snapshot().consecutiveSameFailures`,
   * captured by the caller right after `observeFailures`. Threaded through
   * to the cycle prompt builder so the stuck-cycle escalation block can
   * fire when the agent has had two failed attempts on the same set.
   */
  consecutiveSameFailures?: number
  /** Flake-tolerant stuck set from `HealCycleState.stuckSlugs(ESCALATION_THRESHOLD)`. */
  stuckSlugs?: string[]
  /** Longest per-test failure streak, from `HealCycleState.snapshot().maxSlugStreak`. */
  maxSlugStreak?: number
}): Promise<{
  exitCode: number
  signal: { kind: 'restart' | 'rerun' | 'heal'; body: Record<string, unknown> } | null
  // No `spawn-failed`: a heal-agent spawn failure throws out of the loop
  // instead of settling the cycle with a reason. Add it back here (and in the
  // heal loop's give-up handling) if that ever becomes a caught outcome.
  reason: 'signal' | 'pty-died' | 'idle-timeout' | 'hard-timeout' | 'stopped' | 'cancelled'
}> {
  const cfg = ctx.autoHeal
  if (!cfg) throw new Error('autoHeal not configured')

  // Write the cycle prompt to `<runDir>/heal-prompt.md` BEFORE we spawn
  // (or before we ask the live REPL to re-read). The wired
  // `buildOrchestratorHealPrompt` writes the file as a side effect and
  // returns the rendered text; we keep the text only for transcript
  // echo bookkeeping — claude reads the file directly via `@<path>`.
  void (cfg.buildCyclePrompt ?? defaultHealPrompt)({
    cycle: args.cycle,
    outputDir: ctx.healAgentMcpOutputDir ?? ctx.runDir,
    userGuidance: args.userGuidance,
    consecutiveSameFailures: args.consecutiveSameFailures,
    stuckSlugs: args.stuckSlugs,
    maxSlugStreak: args.maxSlugStreak,
    priorAgentSessionContext: !ctx.healAgentPty
      ? ctx.agentSessionRefs.crossAgentContext(cfg.agent)
      : undefined,
  })

  const isFirstSpawn = !ctx.healAgentPty
  // Hands back the live REPL when one is already up (cycle 2+), so this is the
  // single place the handle comes from. A spawn failure throws out of here and
  // out of the heal loop — deliberately, and pinned by
  // `orchestrator.spawn-failures.test.ts` — so there is no null-pty case.
  const pty = spawnHealAgentRepl(ctx)

  if (args.userGuidance) echoUserInterject(ctx, args.userGuidance)

  // `redirect: true` tells the server-side broker not to reset the pane.
  // Cycle 2+ continues in the *same* long-lived REPL, so wiping the
  // transcript at the cycle boundary would clear the running conversation
  // (visible as a blink). Only the first spawn is a fresh REPL that
  // warrants a clean canvas.
  ctx.emit('agent-started', {
    cycle: args.cycle,
    command: `<repl ${cfg.agent} cycle=${args.cycle}>`,
    redirect: !isFirstSpawn,
  })

  // Cycle 1 has the prompt already wired into the spawn command's argv
  // (`claude … "@<promptFile>"`), so the agent reads it at startup with no
  // stdin write. Cycle 2+ needs to re-prompt the alive REPL. Avoid `@<path>`
  // here: in Claude's input editor it can attach/read the file without
  // submitting the composer, leaving the run stuck until a human presses
  // Enter. Send a plain instruction with the prompt path instead.
  if (!isFirstSpawn) {
    try {
      const promptMessage = `Read ${healPromptFile(ctx)} and continue the auto-heal cycle now.`
      pty.write(BRACKETED_PASTE_BEGIN + promptMessage + BRACKETED_PASTE_END + '\r')
    } catch {
      return { exitCode: 1, signal: null, reason: 'pty-died' }
    }
  }

  const { signal, reason } = await waitForHealSignal(ctx, 
    ctx.healAgentTimeoutMs,
    ctx.healAgentIdleTimeoutMs,
  )
  const exitCode = ctx.healAgentPty ? 0 : 1
  return { exitCode, signal, reason }
}

/**
 * Spawn the long-lived heal-agent REPL. Idempotent-ish — if a pty is
 * already attached, no-ops. The MCP output dir is the run-level
 * `<runDir>/playwright-mcp` — claude reads `--mcp-config` once at boot and
 * the failing set changes across cycles, so a per-failure dir would
 * misattribute cycle 2+ captures.
 */
export function spawnHealAgentRepl(ctx: RunContext): PtyHandle {
  // Returns the handle so the caller never has to re-read a nullable field:
  // this either yields a live REPL or throws.
  if (ctx.healAgentPty) return ctx.healAgentPty
  const cfg = ctx.autoHeal
  if (!cfg) throw new Error('autoHeal not configured')

  const target = resolveMcpOutputDir({ runDir: ctx.runDir })
  ensureMcpOutputDir(target.dir)
  ctx.healAgentMcpOutputDir = target.dir

  // claude can pin via `--session-id <uuid>` on first launch. codex has no
  // equivalent on first launch. For both agents, older/interrupted runs can
  // lack Canary's sidecar files; in that case we recover the latest native
  // CLI session log for this run directory and resume it.
  //
  // On Restart Heal the run dir already has a session id from the previous
  // (failed) heal session — reuse it so the agent continues the prior
  // conversation with full history. Without this, every restart would
  // orphan the previous turns and start the agent's investigation from
  // scratch.
  let sessionId: string | undefined = ctx.agentSessionRefs.priorSessionId(cfg.agent) ?? undefined
  let resume = sessionId !== undefined
  if (!sessionId && cfg.agent === 'claude') sessionId = randomUUID()
  ctx.healAgentSessionId = sessionId ?? null
  try {
    fs.mkdirSync(path.dirname(ctx.paths.agentSessionIdPath), { recursive: true })
    if (sessionId) fs.writeFileSync(ctx.paths.agentSessionIdPath, sessionId)
    else fs.rmSync(ctx.paths.agentSessionIdPath, { force: true })
  } catch { /* sidecar write is informational */ }

  let command: string
  try {
    command = (cfg.buildSpawnCommand ?? defaultSpawnCommand)({
      sessionId,
      resume,
      mcpOutputDir: target.dir,
      // The cycle-1 prompt was already written to this file by the
      // caller (`runHealAgent`); the wired spawn-command builder
      // appends `"@<promptFile>"` so claude reads it on startup.
      promptFile: healPromptFile(ctx),
    })
  } catch (err) {
    emitAgentSystemMessage(ctx, `Failed to build heal-agent spawn command: ${(err as Error).message}`)
    throw err
  }

  // Claude Code prompts "Is this a project you trust?" for any interactive cwd
  // with no trusted ancestor, and the run directory is new every run. Nobody is
  // there to answer it under autopilot, so the cycle would burn its whole idle
  // window and report "no code changes were made". Settle it before the spawn.
  if (cfg.agent === 'claude') ensureHealWorkspaceTrusted(ctx)

  let pty: PtyHandle
  try {
    pty = ctx.ptyFactory({
      command,
      cwd: ctx.runDir,
      env: agentPtyEnv(ctx),
      cols: ctx.healAgentTerminalSize?.cols,
      rows: ctx.healAgentTerminalSize?.rows,
    })
  } catch (err) {
    emitAgentSystemMessage(ctx, `Failed to spawn heal agent: ${(err as Error).message}`)
    throw err
  }
  ctx.healAgentPty = pty
  ctx.healAgentStartedAt = new Date().toISOString()
  attachAgentDataHandlers(ctx, pty)

  // When the REPL exits — either intentionally (cleanup writes /exit then
  // SIGTERM) or unexpectedly (crash) — drop the pty handle so the next
  // cycle's runHealAgent sees no PTY and can decide to bail. Skip if
  // cleanupHealAgentPty already cleared the field — it'll emit agent-exit
  // itself in that path.
  pty.onExit(({ exitCode }) => {
    if (ctx.healAgentPty !== pty) return
    ctx.healAgentPty = null
    persistAgentSessionRef(ctx)
    ctx.emit('agent-exit', { exitCode })
  })

  // Note: `agent-started` is emitted by runHealAgent per-cycle (with the
  // cycle number). The spawn itself is recorded via the manifest +
  // transcript; we don't fire a second agent-started here so consumers see
  // one event per cycle, matching the headless flow.
  void command
  return pty
}

/**
 * Tear down the persistent REPL. Sends Esc + `/exit\r` first to give the
 * agent a chance to flush, then SIGTERMs the pty (with SIGKILL fallback).
 * Idempotent — no-op when no pty is attached.
 */
export function cleanupHealAgentPty(ctx: RunContext): void {
  const pty = ctx.healAgentPty
  // Persist the agent's CLI-native session-log pointer before clearing
  // bookkeeping. This runs once per heal session (the auto-heal loop's
  // finally), so the JSON reflects the final session, not per-cycle.
  persistAgentSessionRef(ctx)
  if (!pty) return
  // Clear the field first so the onExit handler in spawnHealAgentRepl
  // sees `ctx.healAgentPty !== pty` and skips re-emitting agent-exit.
  ctx.healAgentPty = null
  try {
    pty.write('')
    pty.write('/exit\r')
  } catch { /* already gone */ }
  killTree(pty, 'SIGTERM')
  scheduleSigkillFallback(pty)
  ctx.emit('agent-exit', { exitCode: 0 })
  if (ctx.healAgentMcpOutputDir) {
    try { capArtifacts(ctx.healAgentMcpOutputDir) } catch { /* best-effort */ }
  }
  ctx.healAgentMcpOutputDir = undefined
  ctx.healAgentSessionId = null
  ctx.healAgentStartedAt = null
}

export function persistAgentSessionRef(ctx: RunContext): void {
  if (!ctx.autoHeal) return
  ctx.agentSessionRefs.persistActive({
    agent: ctx.autoHeal.agent,
    ...(ctx.healAgentSessionId ? { sessionId: ctx.healAgentSessionId } : {}),
    ...(ctx.healAgentStartedAt ? { startedAt: ctx.healAgentStartedAt } : {}),
  })
}

/** Where the current cycle's prompt is written for the agent to read. */
export function healPromptFile(ctx: RunContext): string {
    return path.join(ctx.runDir, 'heal-prompt.md')
}
