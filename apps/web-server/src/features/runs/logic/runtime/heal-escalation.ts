// Stuck-cycle escalation, shared by the two heal surfaces so they can't drift:
//
// - The LOCAL PTY path renders it as prose appended to the heal prompt
//   (heal-prompt-builder.ts → renderEscalationBlock).
// - The EXTERNAL/MCP path returns it as a structured block on the heal context
//   (external-heal-surface.ts → ExternalHealContext.escalation).
//
// Both fire at the same threshold and from the same tactical content; only the
// signal mechanism differs (.rerun signal file vs signal_run kind:"rerun").

// Three identical failing sets in a row = two prior fix attempts didn't reduce
// the count → the agent is stuck and should change tactic. counter==1 is the
// first observation (no prior fix), counter==2 is one honest miss; counter==3 is
// the first point where doubling down is the wrong move.
export const ESCALATION_THRESHOLD = 3

export interface HealEscalation {
  /** Same-failure streak that triggered this block (>= ESCALATION_THRESHOLD). */
  consecutiveSameFailures: number
  /** The failing-test slugs this streak is stuck on, in summary order. */
  failingSet: string[]
  /** One-line framing: stuck N cycles, change tactic. */
  message: string
  /** Absolute trace paths (for the first failing slug) to Read before editing. */
  readFirst: string[]
  /** Concrete tactical alternatives instead of another fresh hypothesis. */
  tactics: string[]
}

// The two highest-signal per-failure trace files. `<slug>` mirrors the
// heal-agent.md convention — the caller substitutes the first failing slug.
// Falls back to a `<failedDir>` placeholder so a missing path never crashes.
export function escalationTracePaths(failedDir?: string): { snapshotPath: string; networkPath: string } {
  const traceDir = failedDir ? `${failedDir}/<slug>/trace-extract` : '<failedDir>/<slug>/trace-extract'
  return {
    snapshotPath: `${traceDir}/snapshot-at-failure.txt`,
    networkPath: `${traceDir}/network-failed.txt`,
  }
}

export interface BuildHealEscalationInput {
  consecutiveSameFailures: number
  /** Current failing slugs, in summary order. */
  slugs: string[]
  /** Absolute path to the run's diagnosis-journal.md (source of prior diffs). */
  journalPath: string
  /** Absolute path to the run's `failed/` dir, for concrete trace paths. */
  failedDir?: string
}

// Structured escalation for the external/MCP heal path. Phrased for an
// interactive client that fixes code itself and re-runs via signal_run.
export function buildHealEscalation(input: BuildHealEscalationInput): HealEscalation {
  const { snapshotPath, networkPath } = escalationTracePaths(input.failedDir)
  const priorAttempts = Math.max(1, input.consecutiveSameFailures - 1)
  return {
    consecutiveSameFailures: input.consecutiveSameFailures,
    failingSet: input.slugs,
    message: `Same failing set for ${input.consecutiveSameFailures} heal cycles (${input.slugs.join(', ')}). Your last ${priorAttempts} fix attempt${priorAttempts === 1 ? '' : 's'} didn't reduce the failure count — change tactic instead of doubling down on the same approach.`,
    readFirst: [snapshotPath, networkPath],
    tactics: [
      'Re-read the trace snapshot + failed-network for the FIRST failing test before editing — the trace usually shows the real failure mode (DNS, missing element, race) more clearly than the error message.',
      `Treat your last edit as ineffective: read the prior iteration's diff in \`${input.journalPath}\` and either revert it or build on it — don't replace it with a fresh unrelated hypothesis.`,
      'If the failure looks infra-flaky (DNS resolution, third-party scripts, timing), the right fix may be retry/wait logic, not selector tweaks.',
      'If you have no clear hypothesis, add diagnostic logging or assertions and signal_run kind:"rerun" — the next cycle picks up richer output.',
    ],
  }
}
