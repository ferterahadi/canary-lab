// A feature's `playwright.config.*`: where the file lives, and the one
// invariant its contents must hold — spec selection never varies by envset.
//
// Why that is an invariant and not a preference: Playwright builds the suite's
// roster by walking it with the config's selection fields applied, BEFORE the
// first test starts. That walk is what the reporter records as
// `summary.knownTests`, and the declared roster is what every count, export and
// review reads (`cl_run-evidence-invariants` §4). A config that narrows the walk
// by environment therefore does not merely hide tests from a run — it removes
// them from the run's evidence. A `meta` run of a 45-test suite reports a
// 4-test suite; the other 41 are absent rather than "not run", and two runs of
// one suite can no longer be compared against each other.
//
// The expressible alternative keeps the roster whole: a test that must not
// execute in an environment skips ITSELF at runtime —
// `test.skip(process.env.MODE !== 'meta', 'meta only')` — so it stays declared,
// counted, and visibly skipped. Because it gave a reason, the verdict reads
// that skip as settled (`RunSummary.gatedNames`): a run whose only non-passes
// are such gates is green. A skip WITHOUT a reason is not a gate and still
// blocks the pass, so the rule and the verdict ask for the same shape.
//
// Enforcement is "prove it constant", not "guess whether it is env-derived": a
// selection field must be a literal. A computed value may or may not vary per
// run, and a config cannot be trusted to say which. Deliberately NOT covered: a
// field injected through a spread (`...(mode ? { testMatch } : {})`) never
// becomes a property, so it is invisible here. Closing that would mean either a
// heuristic on a blocking gate or comparing the run's declared roster against an
// unfiltered `playwright test --list`; the second is the real backstop if this
// ever gets bypassed in the wild.
import fs from 'fs'
import path from 'path'
import { readPlaywrightConfig } from './config-ast'

export const PLAYWRIGHT_CONFIG_NAMES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.cjs']

/** Playwright's roster-narrowing fields. `grep`/`grepInvert` belong here with
 *  the `test*` ones: a grep-filtered test never reaches the reporter, so it goes
 *  missing from the roster rather than appearing as skipped inside it. */
export const SPEC_SELECTION_FIELDS = ['testDir', 'testMatch', 'testIgnore', 'grep', 'grepInvert'] as const

/** The rule in one sentence, shared by the run-start refusal, the authoring
 *  validator and the rules payload `create_feature` hands an agent — so the
 *  three cannot drift into saying different things. */
export const SPEC_SELECTION_RULE =
  'Spec selection must never depend on the envset. Keep testDir, testMatch, testIgnore, grep and grepInvert as constant literals in playwright.config.* so every run of the suite declares the same roster. A test that must not execute in some environment skips itself at runtime — test.skip(condition, reason) — so it stays declared, counted, and visibly skipped; the reason is what makes the verdict count that skip as settled rather than not-yet-run.'

/** What the run-start refusal carries alongside its human-readable message:
 *  enough for an agent to open the right file and rewrite the right fields. */
export interface SpecSelectionViolation {
  feature: string
  config: string
  fields: string[]
  rule: string
}

/** Is this relative path a feature's playwright config? Used on draft files,
 *  which are named relative to the feature dir and so carry no directory. */
export function isPlaywrightConfigPath(relPath: string): boolean {
  return PLAYWRIGHT_CONFIG_NAMES.includes(path.basename(relPath))
}

export function findPlaywrightConfig(dir: string): string | null {
  for (const name of PLAYWRIGHT_CONFIG_NAMES) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** The selection fields this config cannot prove constant, as the field paths
 *  `readPlaywrightConfig` reports them (`testMatch`, `projects[0].testMatch`).
 *  Empty means every selection field is a literal — the roster is the same for
 *  every envset. A config that cannot be parsed yields no findings: an
 *  unreadable config fails loudly at `playwright test`, and refusing a run on a
 *  parse we could not perform would be a verdict about our parser. */
export function findVariableSpecSelection(source: string): string[] {
  let complexFields: string[]
  try {
    complexFields = readPlaywrightConfig(source).complexFields
  } catch {
    return []
  }
  return complexFields.filter((field) => {
    const leaf = field.slice(field.lastIndexOf('.') + 1)
    return (SPEC_SELECTION_FIELDS as readonly string[]).includes(leaf)
  })
}

/** Refuse a suite whose config filters specs by environment. Thrown as a 409 so
 *  the route layer surfaces it the way it surfaces a repo-branch mismatch: the
 *  human reads `error`, the agent reads `specSelection` and knows which field to
 *  rewrite. A feature with no config at all is not this check's business —
 *  Playwright's own default glob applies, which is constant. */
export function assertStableSpecSelection(featureDir: string, featureName: string): void {
  const cfgPath = findPlaywrightConfig(featureDir)
  if (!cfgPath) return
  const fields = findVariableSpecSelection(fs.readFileSync(cfgPath, 'utf-8'))
  if (fields.length === 0) return
  const specSelection: SpecSelectionViolation = {
    feature: featureName,
    config: cfgPath,
    fields,
    rule: SPEC_SELECTION_RULE,
  }
  throw Object.assign(
    new Error(
      `${featureName}: ${path.basename(cfgPath)} selects specs with a computed ${fields.join(', ')}, so each envset declares a different set of tests. ${SPEC_SELECTION_RULE}`,
    ),
    { statusCode: 409, specSelection },
  )
}
