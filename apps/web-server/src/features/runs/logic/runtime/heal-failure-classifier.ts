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
  for (const { cause, needles } of FINGERPRINTS) {
    if (needles.some((needle) => haystack.includes(needle))) return cause
  }
  return 'unknown'
}

// Terminal capture is full of SGR/erase escape sequences that can split a
// fingerprint across control bytes ("usage\x1b[0m limit"). Strip them before
// matching so a colorized "usage limit" banner still classifies.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}
