// Policy: which external client kinds are allowed to OWN a heal claim.
//
// Heal-claiming is reserved for Desktop clients (Claude Desktop, Codex
// Desktop). CLI clients (`claude-cli`, `codex-cli`) — and anything whose kind
// could not be detected (`other`) — may still start/verify runs, but must not
// grab heal duty: a stray CLI session silently claiming a run and editing repo
// code is exactly the surprise we're preventing.
//
// This is an ALLOWLIST, not a denylist, on purpose. Client-kind detection is
// heuristic (process-lineage sniffing in `scripts/mcp.ts`) and falls back to
// `other` when it can't tell. Allowlisting desktops means an undetected client
// fails safe (blocked) rather than slipping through.
//
// Override via `CANARY_LAB_HEAL_CLAIM_CLIENTS` (comma-separated client kinds)
// for the rare case someone wants CLI claiming back without a code change.

import { isClientKind, type ClientKind } from '../../../../../../../shared/run-mode'

export const HEAL_CLAIM_ALLOWED_KINDS: readonly ClientKind[] = [
  'claude-desktop',
  'codex-desktop',
]

// Parse the env override into a set of valid client kinds. Unknown/garbage
// tokens are ignored; an empty/whitespace-only override falls back to the
// built-in default (we never want a typo to lock everyone out).
export function resolveAllowedClaimKinds(
  env: NodeJS.ProcessEnv = process.env,
): readonly ClientKind[] {
  const raw = env.CANARY_LAB_HEAL_CLAIM_CLIENTS
  if (typeof raw !== 'string' || raw.trim() === '') return HEAL_CLAIM_ALLOWED_KINDS
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ClientKind => s.length > 0 && isClientKind(s))
  return parsed.length > 0 ? parsed : HEAL_CLAIM_ALLOWED_KINDS
}

export function isHealClaimAllowed(
  kind: ClientKind,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveAllowedClaimKinds(env).includes(kind)
}
