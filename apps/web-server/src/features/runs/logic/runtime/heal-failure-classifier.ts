// Pure classifier: given the tail of a heal agent's own terminal output and
// which agent produced it, guess WHY the agent went quiet without writing a
// signal. This is the difference the Test Run surface needs between "the agent
// tried and couldn't" and "the agent never really ran" (usage limit, auth).
//
// No I/O — the orchestrator captures the output tail (a ring buffer of the
// PTY bytes) and hands it here. Deliberately conservative: an unmatched but
// non-empty tail returns 'unknown' (the agent said something we don't
// recognize), and an empty tail returns undefined (nothing to go on).

import type { HealEnd } from '../../../../../../../shared/run-state'
import type { LocalHealAgent } from './manifest'

type HealFailureCause = NonNullable<HealEnd['agentCause']>

// Each cause carries the case-insensitive fingerprints that imply it. Order
// matters: the first cause with a hit wins, so the most specific/severe
// signals are listed before broader ones (a "usage limit" line also contains
// "limit", but we want usage-limit, not rate-limit).
const FINGERPRINTS: ReadonlyArray<{ cause: HealFailureCause; needles: readonly string[] }> = [
  {
    // Claude Code's first-run folder-trust prompt. It is not an error and the
    // agent is not wedged — it is waiting for a keypress nobody will send.
    // `ensureHealWorkspaceTrusted` normally settles this before the spawn, so
    // reaching here means the opt-out is set or the CLI config was unwritable.
    // Listed first: the prompt's own body says "read, edit, and execute", and
    // "execute" must not be mistaken for a crash fingerprint.
    cause: 'trust-prompt',
    needles: [
      'is this a project you created or one you trust',
      'yes, i trust this folder',
      'do you trust the files in this folder',
    ],
  },
  {
    cause: 'usage-limit',
    needles: [
      'usage limit',
      'usage cap',
      'quota',
      'out of credits',
      'credit balance is too low',
      'insufficient credit',
      'plan limit',
      'monthly limit',
      'weekly limit',
      "you've hit your",
      'you have reached your',
      'reached your usage',
      'upgrade your plan',
    ],
  },
  {
    cause: 'auth',
    needles: [
      'not logged in',
      'please log in',
      'please login',
      'run `codex login`',
      'codex login',
      'run `claude login`',
      '/login',
      'authentication failed',
      'unauthorized',
      '401',
      'invalid api key',
      'no api key',
      'expired token',
      'session expired',
      're-authenticate',
    ],
  },
  {
    cause: 'rate-limit',
    needles: [
      'rate limit',
      'rate-limit',
      'too many requests',
      '429',
      'overloaded',
      'server is busy',
      'try again later',
      'temporarily unavailable',
    ],
  },
  {
    cause: 'crash',
    needles: [
      'panic:',
      'segmentation fault',
      'segfault',
      'fatal error',
      'unhandledrejection',
      'unhandled exception',
      'core dumped',
      'killed',
      'command not found',
      'enoent',
      'traceback (most recent call last)',
    ],
  },
]

/**
 * Classify the agent's terminal-output tail into a `HealEnd.agentCause`.
 *
 * @param tail   the last N bytes of the heal agent's PTY output (may be '')
 * @param _agent which CLI produced it — reserved for agent-specific tie-breaks
 *               (both agents share the fingerprint table today)
 * @returns the matched cause, `'unknown'` when the tail is non-empty but
 *          matches nothing, or `undefined` when there is no tail at all.
 */
export function classifyHealFailure(
  tail: string,
  _agent?: LocalHealAgent,
): HealFailureCause | undefined {
  const trimmed = tail.trim()
  if (trimmed === '') return undefined
  const haystack = stripAnsi(trimmed).toLowerCase()
  // A full-screen TUI positions each word with its own cursor escape rather
  // than emitting spaces, so a stripped banner arrives as one run-together
  // word ("isthisaprojectyoutrust"). Match against a space-free copy too, with
  // the needle squeezed the same way — strictly additive, so every fingerprint
  // that matched the plain text still matches.
  const squeezed = squeezeSpace(haystack)
  for (const { cause, needles } of FINGERPRINTS) {
    const hit = needles.some((needle) => haystack.includes(needle) || squeezed.includes(squeezeSpace(needle)))
    if (hit) return cause
  }
  return 'unknown'
}

function squeezeSpace(s: string): string {
  return s.replace(/\s+/g, '')
}

// Terminal capture is full of SGR/erase escape sequences that can split a
// fingerprint across control bytes ("usage\x1b[0m limit"). Strip them before
// matching so a colorized "usage limit" banner still classifies.
 
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}
