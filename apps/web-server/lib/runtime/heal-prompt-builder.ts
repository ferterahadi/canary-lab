import fs from 'fs'
import {
  DIAGNOSIS_JOURNAL_PATH,
  getSummaryPath,
} from './paths'

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

  parts.push(
    `Cycle ${input.cycle}${input.maxCycles ? ` of ${input.maxCycles}` : ''}.`
    + (slugs.length > 0 ? ` Failing tests: ${slugs.join(', ')}.` : ''),
  )

  parts.push(
    mode === 'service'
      ? 'Do NOT Read the test spec file. Use the heal-prompt resource map above and fix service/app code only.'
      : 'Read the failing test spec and its `e2e/helpers/` — those are the only fixable code for this feature.',
  )

  parts.push(
    'You do not need to write to this run\'s `diagnosis-journal.md`. The runner appends an iteration entry automatically from your signal body. Put `hypothesis` (concise diagnosis of what\'s wrong) and `fixDescription` (concise summary of what the fix does) into the `.restart` / `.rerun` JSON body: `{"hypothesis":"…","fixDescription":"…"}`. The runner detects which files you changed via git — do not list them.',
  )

  if (journalExists && input.cycle >= 2) {
    parts.push(
      'Prior iterations exist in this run\'s `diagnosis-journal.md`. Skip hypotheses already tried.',
    )
  }

  return parts.join('\n\n')
}
