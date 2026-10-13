import type { HealAgent } from './agent-binary'

// The invocation policy every Canary-owned agent carries, whatever feature
// spawned it. Keep it per invocation: it overrides a user's broader local
// defaults for Canary's child process without rewriting their global
// Claude/Codex configuration.
//
// Context budget: an explicit bounded conversation size. Keep the CLI bounds
// separate so changing one cannot silently expand the other.
export const CLAUDE_INTERNAL_AGENT_CONTEXT_TOKENS = 350_000
export const CODEX_INTERNAL_AGENT_CONTEXT_TOKENS = 258_000
export const CODEX_AUTO_COMPACT_TOKEN_LIMIT = Math.floor(CODEX_INTERNAL_AGENT_CONTEXT_TOKENS * 0.9)

const CLAUDE_AUTO_COMPACT_WINDOW = `${CLAUDE_INTERNAL_AGENT_CONTEXT_TOKENS / 1000}k`

// Claude Code dialogs that wait for a keypress nobody will send. Once auto mode
// has blocked a few actions and no `autoMode.environment` is configured, the
// interactive CLI ends a turn on "Teach auto mode about your environment?". The
// heal REPL starts with `--setting-sources ""`, so a user's environment entries
// never reach it. Unanswered, the dialog holds the pane until the idle watchdog
// fires (run 2026-10-09T0458-zk6u), and the next cycle's pasted prompt + Enter
// land in the dialog instead of the REPL — Enter on its pre-selected "Yes"
// starts `/auto-mode-setup`, which scans shell history and home-directory repos.
//
// The documented off switch is a `skillOverrides` entry: it turns off the
// command AND the offer (code.claude.com/docs/en/auto-mode-config, "Turn off
// /auto-mode-setup"). Verified against claude 2.1.286: with it, both `--settings
// <json>` and `--setting-sources "" --settings <file>` report the skill disabled.
// There is no CLI flag or env var for this dialog.
export const CLAUDE_UNATTENDED_SETTINGS = {
  skillOverrides: { 'auto-mode-setup': 'off' },
} as const

/** Fold the unattended policy into a spawn's own Claude settings object.
 *
 * A spawn gets ONE `--settings`: measured on 2.1.286, a second `--settings`
 * replaces the first instead of merging, so passing the policy alongside the
 * heal isolation file would silently drop either the sandbox or this policy.
 * `skillOverrides` is excluded from the base type so a caller's own entry
 * cannot be overwritten by the spread without a compile error. */
export function withClaudeUnattendedSettings<T extends object & { skillOverrides?: never }>(
  settings: T,
): T & typeof CLAUDE_UNATTENDED_SETTINGS {
  return { ...settings, ...CLAUDE_UNATTENDED_SETTINGS }
}

export interface InternalAgentInvocationOptions {
  /** A Claude settings file built with `withClaudeUnattendedSettings`. Passed in
   *  place of the inline policy — never beside it (see above). Codex ignores it. */
  claudeSettingsFile?: string
}

export function internalAgentInvocationArgs(
  agent: HealAgent,
  opts: InternalAgentInvocationOptions = {},
): string[] {
  return agent === 'claude'
    ? [
        '--autocompact', CLAUDE_AUTO_COMPACT_WINDOW,
        '--settings', opts.claudeSettingsFile ?? JSON.stringify(CLAUDE_UNATTENDED_SETTINGS),
      ]
    : [
        '-c', `model_context_window=${CODEX_INTERNAL_AGENT_CONTEXT_TOKENS}`,
        '-c', `model_auto_compact_token_limit=${CODEX_AUTO_COMPACT_TOKEN_LIMIT}`,
      ]
}

/** The same flags for the interactive heal command string, which a shell
 *  parses: a flag or plain token stays bare; a path or the inline JSON is
 *  double-quoted the way the rest of that command quotes its values. */
export function internalAgentInvocationShellFlags(
  agent: HealAgent,
  opts: InternalAgentInvocationOptions = {},
): string {
  return internalAgentInvocationArgs(agent, opts)
    .map((arg) => ` ${/^[\w.=-]+$/.test(arg) ? arg : JSON.stringify(arg)}`)
    .join('')
}
