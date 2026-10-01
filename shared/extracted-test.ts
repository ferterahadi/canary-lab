// A test as the AST extractor reads it from a spec. The tests route sends the
// display fields to the web UI; the coverage-linkage fields stay on the server,
// where coverage reads them, so the UI never receives them.
import type { FormattedCodeDisplay } from './code-display-format'
import type { PathType } from './coverage/types'
import type { ReadableTest } from './readable-tests/types'

// Parse Playwright spec source and return every `test('name', …)` call along
// with the `test.step('label', …)` invocations nested inside (recursively).
//
// Errors during parse are caught — we return an empty array rather than
// blowing up the route handler. The TypeScript compiler is forgiving about
// syntax errors anyway (it produces a partial AST), so this is mostly a
// belt-and-braces safety net for truly broken input.

export interface ExtractedStep {
  label: string
  line: number
  bodySource: string
  children: ExtractedStep[]
}

export interface ExtractedTest {
  name: string
  line: number
  endLine?: number
  sourceChanges?: { changedLines: number[]; count: number }
  bodySource: string
  /** First source line represented by bodySource. Distinct from the test call
   *  line when a multiline declaration places its callback on a later line. */
  bodyLine?: number
  steps: ExtractedStep[]
  readable: ReadableTest
  /** In-memory, display-only rendering added by the tests route. The extractor
   *  leaves it absent so coverage and rerun callers do no formatting work. */
  codeDisplay?: FormattedCodeDisplay
  // Present when the `test(...)` lives in a different file than the spec
  // that owns it (e.g. a factory helper). UI uses this to link the code
  // viewer at the real definition site instead of the importing spec.
  sourceFile?: string
  // Verified-coverage linkage. Primary source is Playwright tags on the test
  // (`{ tag: ['@req-R3', '@path-happy'] }`); `@requirement <id>` / `@path
  // happy|sad|edge` comment annotations are honoured as a migration fallback and
  // unioned in. Absent when the test carries no linkage at all.
  requirements?: string[]
  pathTypes?: PathType[]
  // Variant value(s) the test exercises (`@variant-email`). The third coverage
  // axis (D1) — a feature-specific dimension (channel/tenant/region) a requirement
  // must hold across. Open vocabulary; validated against the feature's declared
  // dimension upstream. Absent when the test carries no variant linkage.
  variants?: string[]
  // Assertion / check snippets collected from the test body — `expect(...)`
  // matcher chains plus navigation/network/db/file calls. Fed to the rigor
  // tier classifier (verified-coverage depth dimension). Absent when none found.
  assertions?: string[]
}
