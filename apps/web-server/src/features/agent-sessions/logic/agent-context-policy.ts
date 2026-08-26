import type { HealAgent } from './agent-binary'

// Canary-owned agents get the same bounded conversation budget regardless of
// feature or CLI. Keep this as an invocation policy: it overrides a user's
// broader local defaults for Canary's child process without rewriting their
// global Claude/Codex configuration.
export const INTERNAL_AGENT_CONTEXT_TOKENS = 258_000
export const CODEX_AUTO_COMPACT_TOKEN_LIMIT = Math.floor(INTERNAL_AGENT_CONTEXT_TOKENS * 0.9)

const CLAUDE_AUTO_COMPACT_WINDOW = `${INTERNAL_AGENT_CONTEXT_TOKENS / 1000}k`

export function internalAgentContextArgs(agent: HealAgent): string[] {
  return agent === 'claude'
    ? ['--autocompact', CLAUDE_AUTO_COMPACT_WINDOW]
    : [
        '-c', `model_context_window=${INTERNAL_AGENT_CONTEXT_TOKENS}`,
        '-c', `model_auto_compact_token_limit=${CODEX_AUTO_COMPACT_TOKEN_LIMIT}`,
      ]
}

/** Fixed, shell-safe flags for the interactive heal command string. */
export function internalAgentContextShellFlags(agent: HealAgent): string {
  return internalAgentContextArgs(agent).map((arg) => ` ${arg}`).join('')
}
