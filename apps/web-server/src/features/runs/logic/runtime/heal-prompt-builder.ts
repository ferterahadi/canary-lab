import fs from 'fs'
import {
  DIAGNOSIS_JOURNAL_PATH,
  getSummaryPath,
} from './paths'
import { ESCALATION_THRESHOLD, escalationTracePaths } from './heal-escalation'
import { readJournalTail } from './log-enrichment'

// Builds the state-aware addendum that gets appended to the static heal
// prompt from apps/web-server/prompts/heal-agent.md. The static core describes the always-
// true workflow (read heal-index, fix service code, write signal); the
// addendum injects what changes per cycle:
//
// - Current cycle number and failing slugs, so the agent can't drift onto
//   the wrong failure set.
// - A hard "do NOT read the test spec" rule — prompts that forbid are more
//   effective than prompts that suggest an ordering.
// - Journal-related guidance ONLY when a journal exists (skipped entirely on
//   the first iteration to eliminate the cold-start `ls`/`tail` ceremony).
// - A reminder that the runner writes journal entries for the agent, so the
//   agent only supplies hypothesis + filesChanged in the signal body.

// Heal mode for the upcoming cycle.
//
// - `service`: the run has at least one editable service repo. The agent
//   should fix service/app code and avoid reading the test spec.
// - `test`: the run has zero editable repos (remote-env runs against a
//   deployed target, or features without a `repos` block). The test spec /
//   `e2e/helpers/` is the only fixable code, so the agent is told to read it.
export type HealMode = 'service' | 'test'

export interface HealAddendumInput {
  cycle: number // 1-based: the cycle about to run
  maxCycles?: number
  /** When omitted, defaults to `service` for backwards compatibility with
   *  existing callers and fixtures. */
  mode?: HealMode
  summaryPath?: string
  journalPath?: string
  /**
   * Number of consecutive observations of the SAME failing set, taken from
   * `HealCycleState.snapshot().consecutiveSameFailures` AFTER the most recent
   * `observeFailures` call. When `>= 3` — i.e., we've seen the same set
   * three times, meaning two prior agent attempts didn't reduce the failure
   * count — the addendum injects an escalation block telling the agent to
   * change tactic rather than double down on the prior approach.
   *
   * Threshold rationale: counter==1 is the first observation (no prior fix
   * attempt). counter==2 is the second cycle (one prior attempt — could be
   * an honest miss, not yet "stuck"). counter==3 is two prior attempts on the
   * same set — the agent IS stuck and needs a tactical reset.
   */
  consecutiveSameFailures?: number
  /**
   * Currently failing slugs whose per-test consecutive-failure streak has
   * reached `ESCALATION_THRESHOLD`, from `HealCycleState.stuckSlugs()`.
   * Flake-tolerant: unlike `consecutiveSameFailures` (exact-set identity),
   * this survives a flaky sibling entering/leaving the failing set. When
   * provided (even empty), it is the escalation trigger; when `undefined`
   * (legacy callers), escalation falls back to the set-identity streak.
   */
  stuckSlugs?: string[]
  /**
   * Longest per-test streak among the current failing slugs, from
   * `HealCycleState.snapshot().maxSlugStreak`. Used for the escalation
   * block's "N observations" phrasing when `stuckSlugs` drives the trigger.
   */
  maxSlugStreak?: number
  /**
   * Absolute path to the run's `failed/` directory. Required for the
   * escalation block to embed concrete `<failedDir>/<slug>/trace-extract/...`
   * paths the agent can `Read` directly. The static template already exposes
   * this as `{{failedDir}}`, but the addendum is appended AFTER template
   * rendering so it can't use that placeholder.
   */
  failedDir?: string
}

// One-line steer per classified prior-cycle outcome. The runner classifies
// the previous iteration's outcome (updateLatestPendingJournalOutcome) after
// each Playwright run — injecting it here saves the agent a journal read and
// pins the interpretation ("regression" means revert-first, not iterate).
const OUTCOME_STEER: Record<string, string> = {
  no_change: 'your previous fix did not change the failing set',
  partial: 'your previous fix unblocked some tests — build on it for the remainder',
  regression: 'your previous change introduced NEW failures — consider reverting it before anything else',
}

function readFailingSlugs(summaryPath: string = getSummaryPath()): string[] {
  try {
    const raw = fs.readFileSync(summaryPath, 'utf-8')
    const summary = JSON.parse(raw) as { failed?: Array<{ name?: unknown }> }
    const failed = Array.isArray(summary.failed) ? summary.failed : []
    return failed
      .map((f) => (typeof f?.name === 'string' ? f.name : ''))
      .filter((n) => n.length > 0)
  } catch {
    return []
  }
}

export function buildHealAddendum(input: HealAddendumInput): string {
  const slugs = readFailingSlugs(input.summaryPath)
  const journalExists = fs.existsSync(input.journalPath ?? DIAGNOSIS_JOURNAL_PATH)
  const mode: HealMode = input.mode ?? 'service'

  const parts: string[] = []

  // Prior-iteration outcome, classified by the runner after the previous
  // Playwright run. Only meaningful from cycle 2 on; `pending`/missing means
  // the classification hasn't landed (or there is no prior iteration) — emit
  // nothing rather than a misleading "pending".
  let priorOutcomeLine = ''
  if (input.cycle >= 2 && journalExists) {
    const [prior] = readJournalTail(input.journalPath ?? DIAGNOSIS_JOURNAL_PATH, 1)
    const outcome = prior?.outcome
    if (outcome && OUTCOME_STEER[outcome]) {
      priorOutcomeLine = ` Prior fix outcome: ${outcome} — ${OUTCOME_STEER[outcome]}.`
    }
  }

  parts.push(
    `Cycle ${input.cycle}${input.maxCycles ? ` of ${input.maxCycles}` : ''}.`
    + (slugs.length > 0 ? ` Failing tests: ${slugs.join(', ')}.` : '')
    + priorOutcomeLine,
  )

  parts.push(
    mode === 'service'
      ? 'Do NOT Read the test spec file. Use the heal-prompt resource map above and fix service/app code only.'
      : 'Read the failing test spec and its `e2e/helpers/` — those are the only fixable code for this feature.',
  )

  parts.push(
    'You do not need to write to this run\'s `diagnosis-journal.md`. The runner appends an iteration entry automatically from your signal body. Put `hypothesis` (concise diagnosis of what\'s wrong) and `fixDescription` (concise summary of what the fix does) into the `.restart` / `.rerun` JSON body: `{"hypothesis":"…","fixDescription":"…"}`. The runner detects which files you changed via git — do not list them.',
  )

  // Stuck-test escalation. Preferred trigger: `stuckSlugs` — tests whose
  // per-test streak hit ESCALATION_THRESHOLD (two previous heal attempts
  // didn't fix them), flake-tolerant to churn in the rest of the set. Legacy
  // callers that don't plumb `stuckSlugs` fall back to the set-identity
  // streak. Either way, surface it explicitly and steer the agent toward a
  // different tactic rather than another fresh hypothesis on the same path.
  const stuck = input.stuckSlugs !== undefined
    ? input.stuckSlugs.filter((s) => slugs.includes(s))
    : ((input.consecutiveSameFailures ?? 0) >= ESCALATION_THRESHOLD ? slugs : [])
  if (stuck.length > 0 && slugs.length > 0) {
    parts.push(renderEscalationBlock({
      cycle: input.cycle,
      stuckSlugs: stuck,
      observations: Math.max(
        input.maxSlugStreak ?? 0,
        input.consecutiveSameFailures ?? 0,
        ESCALATION_THRESHOLD,
      ),
      journalPath: input.journalPath ?? DIAGNOSIS_JOURNAL_PATH,
      failedDir: input.failedDir,
    }))
  }

  if (journalExists && input.cycle >= 2) {
    parts.push(
      'Prior iterations exist in this run\'s `diagnosis-journal.md`. Skip hypotheses already tried.',
    )
  }

  return parts.join('\n\n')
}

// The escalation block is intentionally concrete: it tells the agent which
// files to re-read (with absolute paths so `Read` lands the right artifact),
// names the prior-iteration diff as the source of truth for what was tried,
// and lists tactical alternatives instead of vague encouragement. The
// `<slug>` placeholder mirrors the static heal-agent.md convention — the
// agent substitutes the first failing slug from the failing-tests line above.
function renderEscalationBlock(input: {
  cycle: number
  stuckSlugs: string[]
  /** Consecutive observations for the most-stuck test (>= ESCALATION_THRESHOLD). */
  observations: number
  journalPath: string
  failedDir?: string
}): string {
  const slugList = input.stuckSlugs.join(', ')
  // The only caller floors observations at ESCALATION_THRESHOLD (3), so
  // attempts = observations - 1 is always >= 2 — always plural.
  const attempts = input.observations - 1
  // Shared with the external/MCP escalation so the two surfaces point at the
  // same trace files. The prose below is PTY-specific (cycle-relative phrasing,
  // .rerun signal file); buildHealEscalation carries the structured analog.
  const { snapshotPath, networkPath } = escalationTracePaths(input.failedDir)
  return [
    `Escalation: cycle ${input.cycle} — these tests have now failed ${input.observations} times in a row despite ${attempts} fix attempts: ${slugList}. Treat this as a signal to change tactic, not double down:`,
    `- Re-read \`${snapshotPath}\` and \`${networkPath}\` for the FIRST failing test before editing — the trace usually shows the real failure mode (DNS, missing element, race) more clearly than the error message.`,
    `- If you already changed \`e2e/helpers/\` in cycle ${input.cycle - 1} and the same tests are still failing, your last edit didn't help. Read the diff in \`${input.journalPath}\` for the prior iteration, and either revert it or build on it — don't replace it with a fresh unrelated hypothesis.`,
    '- If the failure looks infra-flaky (DNS resolution, third-party scripts, timing), the right fix may be retry/wait logic in `e2e/helpers/`, not selector tweaks.',
    '- If you have no clear hypothesis, add diagnostic logging or assertions and write `.rerun` — the next cycle will pick up richer output.',
  ].join('\n')
}
