import fs from 'fs'
import {
  DIAGNOSIS_JOURNAL_PATH,
  getSummaryPath,
} from './paths'

// Builds the state-aware addendum that gets appended to the static heal
// prompt from CLAUDE.md / AGENTS.md. The static core describes the always-
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

export interface HealAddendumInput {
  cycle: number // 1-based: the cycle about to run
  maxCycles?: number
}

function readFailingSlugs(): string[] {
  try {
    const raw = fs.readFileSync(getSummaryPath(), 'utf-8')
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
  const slugs = readFailingSlugs()
  const journalExists = fs.existsSync(DIAGNOSIS_JOURNAL_PATH)

  const parts: string[] = []

  parts.push(
    `Cycle ${input.cycle}${input.maxCycles ? ` of ${input.maxCycles}` : ''}.`
    + (slugs.length > 0 ? ` Failing tests: ${slugs.join(', ')}.` : ''),
  )

  parts.push(
    'Do NOT Read the test spec file. Fix service/app code only — grep the distinctive literal from the error message inside the repos listed in `logs/heal-index.md` to localize the bug.',
  )

  parts.push(
    'You do not need to write to `logs/diagnosis-journal.md`. The runner appends an iteration entry automatically from your signal body. Put your hypothesis and filesChanged into the `.restart` / `.rerun` JSON body: `{"hypothesis":"…","filesChanged":["…"]}`.',
  )

  if (journalExists && input.cycle >= 2) {
    parts.push(
      'Prior iterations exist in `logs/diagnosis-journal.md`. Before forming a new hypothesis, set the previous iteration\'s outcome by editing its `- outcome: pending` line in that file. Values: `all_passed` | `partial` | `no_change` | `regression`. Skip hypotheses already tried.',
    )
  }

  return parts.join('\n\n')
}
