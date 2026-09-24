// Verification-strength differential — the wire types shared by the server-side
// predicate extractor / lattice / classifier and the web UI that renders a
// was→now row. Structural facts only: nothing here is an opinion about strength;
// the lattice (`apps/web-server/src/shared/verification-strength/lattice.ts`)
// derives that from these fields.

/** What kind of expected value a matcher was given. Drives the strength tier:
 *  a literal pins one value, a regex a pattern, `asymmetric` an `expect.*`
 *  matcher such as `expect.anything()`, `collection` an array/object literal
 *  with no asymmetric matcher inside, `dynamic` anything computed at run time. */
export type ExpectedShape = 'none' | 'literal' | 'regex' | 'asymmetric' | 'collection' | 'dynamic'

export interface TestPredicate {
  /** Matcher name as written — `toHaveText`, `toBeVisible`, a custom matcher. */
  matcher: string
  /** Canonical text of the `expect(...)` subject — the thing being checked. Re-printed
   *  from syntax with every literal in one spelling, so quote style, line breaks and
   *  trailing commas are not differences. */
  target: string
  /** Shape of the value argument (the last non-option argument). */
  expected: ExpectedShape
  /** Canonical text (as `target`) of every non-option argument, comma-joined. Absent
   *  when the matcher took no value argument. */
  expectedText?: string
  /** Count of non-option arguments: `toHaveProperty('a')` (1, existence) vs
   *  `toHaveProperty('a', 1)` (2, value) are different predicates. */
  expectedArity: number
  /** Keys of a trailing matcher-options object (`timeout`, `ignoreCase`, …).
   *  Absent when none was passed. Some keys change what is proven. */
  optionKeys?: string[]
  negated: boolean
  /** `expect.soft(...)` — a failure is recorded but does not stop the test. */
  soft: boolean
  /** `expect.poll(fn)` — the subject is re-evaluated until the matcher holds. */
  poll: boolean
  settlement?: 'resolves' | 'rejects'
  /** 1-based line of the assertion statement in the spec. */
  line: number
  /** Source of the whole assertion chain as written, whitespace collapsed, `await`
   *  included — what a reader sees, not what the differential compares. */
  source: string
}

/** How much a predicate pins its target down. Ordered: `exact` (one concrete
 *  value) > `pattern` (a regex, a containment, a bound, a partial match) >
 *  `existential` (a state or presence, no value). `none` is the lattice bottom —
 *  the strength of a predicate that is not there — and exists for the
 *  differential, never for a predicate that was written. */
export type StrengthTier = 'exact' | 'pattern' | 'existential' | 'none'

/** Coarse matcher family; the tier is derived from family × expected shape. */
export type MatcherFamily =
  | 'value'        // pins the target to a value: toHaveText, toBe, toHaveCount, …
  | 'containment'  // constrains without pinning: toContainText, toMatchObject, toMatch, …
  | 'comparison'   // a numeric bound: toBeGreaterThan, toBeCloseTo, …
  | 'state'        // a boolean fact about the target: toBeVisible, toBeTruthy, toBeOK, …
  | 'throw'        // toThrow / toThrowError
  | 'unknown'      // a matcher the lattice has no rule for

export type PredicateStrength =
  | { kind: 'ranked'; tier: Exclude<StrengthTier, 'none'>; family: Exclude<MatcherFamily, 'unknown'> }
  /** The lattice refuses to rank this predicate. Always a distinct outcome — an
   *  assertion whose strength cannot be read must never pass as equivalent. */
  | { kind: 'unclassifiable'; family: MatcherFamily; reason: string }

/** An `expect(...)` the collector saw but could not read as a matcher chain.
 *  Surfaced rather than dropped: an assertion form the differential cannot see
 *  must be visible as such, never silently counted as absent or equivalent. */
export interface UnparsedExpectation {
  line: number
  source: string
  reason: string
}

/** A run-time guard call — `test.skip(cond, why)`, `test.fixme()`, `test.fail(cond)` —
 *  in a test body, or inherited from an enclosing describe, a hook, or the file's top
 *  level. The test sits out (or has its outcome inverted) whenever the guard fires,
 *  so a guard added to a live test is a weakening and a guard removed a strengthening.
 *  `condition` is the canonical text (as `TestPredicate.target`) of the first argument;
 *  absent for the bare form,
 *  which silences the test unconditionally and reads like a declaration modifier. */
export interface TestGuard {
  kind: 'skip' | 'fixme' | 'fail'
  condition?: string
  line: number
  source: string
}

/** The differential's answer for one predicate, one test, or a whole file.
 *  `unclassifiable` is a real outcome, never folded into `equivalent`. */
export type StrengthVerdict = 'weaker' | 'equivalent' | 'stronger' | 'unclassifiable'

export type PredicateChangeKind =
  | 'removed'     // present before, gone after
  | 'added'       // new on the after side
  | 'retargeted'  // the same predicate on a different subject — a selector rename
  | 'reshaped'    // the same subject, a different matcher, value or polarity
  | 'unreadable'  // an `expect(...)` the collector cannot read appeared or vanished
  | 'guarded'     // a run-time skip/fixme/fail call appeared: the test now sits out under some condition
  | 'unguarded'   // such a call vanished: the test proves again where it used to sit out

export interface PredicateChange {
  kind: PredicateChangeKind
  verdict: StrengthVerdict
  before?: TestPredicate | UnparsedExpectation | TestGuard
  after?: TestPredicate | UnparsedExpectation | TestGuard
  /** Why the verdict is `unclassifiable`; absent otherwise. */
  reason?: string
}

export interface PredicateSetDiff {
  verdict: StrengthVerdict
  changes: PredicateChange[]
}

export type TestChangeKind = 'changed' | 'added' | 'deleted' | 'renamed' | 'disabled' | 'enabled'

export interface TestChange {
  kind: TestChangeKind
  /** Name on the after side; the before-side name for a deletion. */
  name: string
  /** For a rename: the name on the before side. */
  wasNamed?: string
  verdict: StrengthVerdict
  changes: PredicateChange[]
  /** Why the verdict, when no listed change carries it: a live test with no readable
   *  assertion came or went. Absent otherwise. */
  reason?: string
}

export interface SpecDiff {
  verdict: StrengthVerdict
  /** Tests added, deleted, renamed, disabled, enabled, or whose predicates
   *  changed. A test identical on both sides is not listed. */
  tests: TestChange[]
  /** File-level facts not tied to one test: a side that does not parse, a
   *  `test.only`. Present only when non-empty. */
  reasons?: string[]
}
