import { recoverClaudeFinalText } from './agent-stream'
import { claudeSessionLogPath } from './agent-session-log'

// Two formulas every internal agent producer (wizard plan/spec, coverage PRD +
// annotate, eval rewrite, portify) had copy-pasted around its `runAgentProcess`
// call. One home, so the claude-vs-codex branch is fixed once:
//
//   - the final answer: claude stdout is stream-json envelopes (recover the
//     final message); codex stdout is already the plain answer text.
//   - the liveness activity path: claude `-p` is silent on stdout, so watch its
//     session-JSONL growth; everything else watches the teed log / nothing.

export type ProducerAgentKind = 'claude' | 'codex'

/** Recover the producer agent's final answer text from its raw stdout. */
export function recoverAgentAnswer(agent: ProducerAgentKind, stdout: string): string {
  return agent === 'claude' ? recoverClaudeFinalText(stdout) : stdout
}

/** The file whose growth signals liveness for the idle timer: the claude session
 *  JSONL when claude pinned a session id, otherwise `fallback` (the teed log, or
 *  undefined). */
export function agentActivityPath(
  agent: ProducerAgentKind,
  cwd: string | undefined,
  sessionId: string | undefined,
  fallback?: string,
): string | undefined {
  if (agent === 'claude' && cwd && sessionId) return claudeSessionLogPath(cwd, sessionId)
  return fallback
}
