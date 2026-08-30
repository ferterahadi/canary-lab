import type { HealAgent } from './agent-binary'

// Canary-owned agents get an explicit bounded conversation budget regardless of
// feature. Keep this as an invocation policy: it overrides a user's broader
// local defaults for Canary's child process without rewriting their global
// Claude/Codex configuration. Keep the CLI bounds separate so changing one
// cannot silently expand the other.
export const CLAUDE_INTERNAL_AGENT_CONTEXT_TOKENS = 350_000
export const CODEX_INTERNAL_AGENT_CONTEXT_TOKENS = 258_000
export const CODEX_AUTO_COMPACT_TOKEN_LIMIT = Math.floor(CODEX_INTERNAL_AGENT_CONTEXT_TOKENS * 0.9)

const CLAUDE_AUTO_COMPACT_WINDOW = `${CLAUDE_INTERNAL_AGENT_CONTEXT_TOKENS / 1000}k`

export function internalAgentContextArgs(agent: HealAgent): string[] {
  return agent === 'claude'
    ? ['--autocompact', CLAUDE_AUTO_COMPACT_WINDOW]
    : [
        '-c', `model_context_window=${CODEX_INTERNAL_AGENT_CONTEXT_TOKENS}`,
        '-c', `model_auto_compact_token_limit=${CODEX_AUTO_COMPACT_TOKEN_LIMIT}`,
      ]
}

/** Fixed, shell-safe flags for the interactive heal command string. */
export function internalAgentContextShellFlags(agent: HealAgent): string {
  return internalAgentContextArgs(agent).map((arg) => ` ${arg}`).join('')
}
