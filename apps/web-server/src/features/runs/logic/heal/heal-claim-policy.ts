// Policy: which external client kinds are BLOCKED from owning a heal claim.
//
// Heal-claiming is open to every human-driven interactive client — `claude`
// and `codex` (Desktop or CLI, we no longer distinguish) and even `other`
// (an undetected client is assumed to be a person at a terminal). The ONLY
// kinds blocked are the runner-spawned PTY agents (`claude-pty`, `codex-pty`):
// those are processes Canary Lab itself spawns (benchmark sabotage, portify,
// …), and letting one claim heal would have it claim its own run — exactly the
// loop this policy exists to prevent.
//
// This is a DENYLIST, not an allowlist, on purpose. The dangerous case is the
// one we fully control: the runner tags its spawns `*-pty` deterministically
// via `CANARY_LAB_MCP_CLIENT_KIND` (see `runAgentProcess`), so we never rely on
// heuristic detection to block it. Everything else — including an undetected
// `other` — fails open (allowed), because a person should be able to heal.
//
// Override via `CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS` (comma-separated client
// kinds) for the rare case someone wants different blocking without a code
// change.

import { isClientKind, type ClientKind } from '../../../../../../../shared/run-mode'

export const HEAL_CLAIM_BLOCKED_KINDS: readonly ClientKind[] = [
  'claude-pty',
  'codex-pty',
]

// Parse the env override into a set of valid client kinds. Unknown/garbage
// tokens are ignored; an empty/whitespace-only override falls back to the
// built-in default (we never want a typo to silently unblock the PTY agents).
export function resolveBlockedClaimKinds(
  env: NodeJS.ProcessEnv = process.env,
): readonly ClientKind[] {
  const raw = env.CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS
  if (typeof raw !== 'string' || raw.trim() === '') return HEAL_CLAIM_BLOCKED_KINDS
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ClientKind => s.length > 0 && isClientKind(s))
  return parsed.length > 0 ? parsed : HEAL_CLAIM_BLOCKED_KINDS
}

export function isHealClaimAllowed(
  kind: ClientKind,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !resolveBlockedClaimKinds(env).includes(kind)
}
