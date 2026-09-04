import type { ExtractedTestPredicates, ExtractPredicatesResult } from '../ast-extractor'
import type {
  PredicateChange,
  PredicateSetDiff,
  SpecDiff,
  StrengthVerdict,
  TestChange,
  TestGuard,
  TestPredicate,
  UnparsedExpectation,
} from '../../../../../shared/verification-strength/types'
import { compareTiers, strengthOf } from './lattice'

// The verification-strength differential: given a test's predicate set before
// and after an edit, say whether the edit made the test weaker, kept it
// equivalent, made it stronger, or changed it in a way the lattice cannot rank.
//
// The model, and why it is shaped this way:
// - Predicates identical on both sides cancel first, as a multiset. This is what
//   keeps an old `toBeGreaterThan(previous)` — unrankable, but untouched — from
//   tainting every later edit to the same test.
// - A predicate that survives with the same matcher, value and polarity on a new
//   subject is a selector rename (`retargeted`, equivalent). Reading that as a
//   removal plus an addition is the false positive that makes enforcement worse
//   than the advisory pill it replaces.
// - A predicate that survives on the same subject with a different shape is
//   compared tier against tier (`reshaped`). Equal tiers with a different shape
//   are refused: the lattice ranks strength, not meaning, and cannot tell a fix
//   (`'$148.50'` → `'$150.00'`) from a cover-up (`'$148.50'` → `'$0.00'`).
// - What is left is removed (weaker) or added (stronger); an added constraint
//   cannot loosen anything, even one the lattice cannot rank.
// - A test under `skip` / `fixme` / `fail` enforces nothing, so its effective set
//   is empty. `only` is reported once, at file level, rather than as a disabling
//   of every other test.
//
// - A run-time `test.skip(cond)` / `fixme` / `fail` call is a guard: the test sits
//   out whenever it fires. Guards pair by kind and condition (rewording the reason
//   changes nothing); one added to a live test is weaker, one lifted from a live
//   test is stronger — even a test whose assertions all live in helpers — and a
//   changed condition reads as both, which rolls up weaker, the conservative side.
//   A guard on a test that is new, deleted or disabled carries no story of its
//   own: the predicates do. The
//   bare form (`test.skip()`) silences the test outright and reads like a
//   declaration modifier. Describe-level guards arrive already attributed to the
//   tests they reach (see the extractor), so a whole-suite skip is one change per
//   test it silences.
//
// Deliberately not modelled here (the pilot rubric decides whether they need
// an axis of their own): a target swapped for a weaker one at equal shape
// (`getByRole('button')` → `locator('body')`), and edits to fixtures or test data.

export interface PredicateSet {
  predicates: TestPredicate[]
  unparsed?: UnparsedExpectation[]
  guards?: TestGuard[]
}

// Dominance when changes mix. A certain weakening outranks everything: removing
// one assertion and adding another elsewhere still weakened the suite. An
// unrankable change outranks a strengthening because "stronger" would then be a
// claim the lattice cannot back.
const VERDICT_RANK: Record<StrengthVerdict, number> = { equivalent: 0, stronger: 1, unclassifiable: 2, weaker: 3 }

function rollup(verdicts: StrengthVerdict[]): StrengthVerdict {
  return verdicts.reduce<StrengthVerdict>((worst, verdict) => (VERDICT_RANK[verdict] > VERDICT_RANK[worst] ? verdict : worst), 'equivalent')
}

// What a predicate asserts, independent of where it looks: the same signature on
// another target is a selector rename. `soft` and `poll` are left out because
// they change how a failure is reported, not what is proven; option keys are
// sorted because `{ timeout, ignoreCase }` and `{ ignoreCase, timeout }` are
// the same options.
function signature(predicate: TestPredicate): string {
  return [
    predicate.matcher,
    predicate.negated,
    predicate.settlement ?? '',
    predicate.expectedArity,
    predicate.expectedText ?? '',
    [...(predicate.optionKeys ?? [])].sort().join(','),
  ].join('|')
}

function identity(predicate: TestPredicate): string {
  return `${predicate.target}|${signature(predicate)}`
}

// Multiset difference by key: entries present on both sides cancel one-for-one,
// so an assertion repeated twice and kept twice never registers as a change.
function uncancelled<T>(before: T[], after: T[], key: (item: T) => string): [T[], T[]] {
  const candidates = new Map<string, T[]>()
  for (const item of before) {
    const bucket = candidates.get(key(item))
    if (bucket) bucket.push(item)
    else candidates.set(key(item), [item])
  }
  const matched = new Set<T>()
  const onlyAfter: T[] = []
  for (const item of after) {
    const partner = candidates.get(key(item))?.shift()
    if (partner) matched.add(partner)
    else onlyAfter.push(item)
  }
  return [before.filter((item) => !matched.has(item)), onlyAfter]
}

// The reason string is documentation; the kind and the condition are the guard. A
// bare guard never gets here: it silences its test, which then diffs as NOTHING_ENFORCED.
function guardKey(guard: TestGuard): string {
  return `${guard.kind}|${guard.condition}`
}

// Stands in for a test that is absent from one side or silenced on it, and is
// recognised by identity. A real test with no direct `expect` (its assertions live
// in helpers) still runs, so a guard imposed on or lifted from it is a change in
// what it enforces; a guard on a test that is new, deleted, or disabled is not.
const NOTHING_ENFORCED: PredicateSet = { predicates: [] }

function reshape(before: TestPredicate, after: TestPredicate): PredicateChange {
  const was = strengthOf(before)
  const now = strengthOf(after)
  const base = { kind: 'reshaped' as const, before, after }
  if (now.kind === 'unclassifiable') return { ...base, verdict: 'unclassifiable', reason: now.reason }
  if (was.kind === 'unclassifiable') return { ...base, verdict: 'unclassifiable', reason: was.reason }
  const order = compareTiers(was.tier, now.tier)
  if (order > 0) return { ...base, verdict: 'weaker' }
  if (order < 0) return { ...base, verdict: 'stronger' }
  const reason = before.negated !== after.negated
    ? 'polarity flipped'
    : before.matcher !== after.matcher
      ? 'matcher changed at equal strength'
      : 'expected value changed at equal strength'
  return { ...base, verdict: 'unclassifiable', reason }
}

/** Per-test core: the changes between two predicate sets and their rolled-up
 *  verdict. Changes are listed before-side first (retargets, then reshapes and
 *  removals, in source order), then additions. */
export function diffPredicateSets(before: PredicateSet, after: PredicateSet): PredicateSetDiff {
  const changes: PredicateChange[] = []

  const [unreadBefore, unreadAfter] = uncancelled(before.unparsed ?? [], after.unparsed ?? [], (u) => u.source)
  for (const unread of unreadBefore) {
    changes.push({ kind: 'unreadable', verdict: 'unclassifiable', before: unread, reason: 'an assertion the collector cannot read was removed' })
  }
  for (const unread of unreadAfter) {
    changes.push({ kind: 'unreadable', verdict: 'unclassifiable', after: unread, reason: 'an assertion the collector cannot read was added' })
  }

  const [lifted, imposed] = uncancelled(before.guards ?? [], after.guards ?? [], guardKey)
  if (after !== NOTHING_ENFORCED) for (const guard of lifted) changes.push({ kind: 'unguarded', verdict: 'stronger', before: guard })
  if (before !== NOTHING_ENFORCED) for (const guard of imposed) changes.push({ kind: 'guarded', verdict: 'weaker', after: guard })

  const [gone, added] = uncancelled(before.predicates, after.predicates, identity)
  const spare = [...added]
  const take = (accept: (candidate: TestPredicate) => boolean): TestPredicate | undefined => {
    const index = spare.findIndex(accept)
    return index === -1 ? undefined : spare.splice(index, 1)[0]
  }

  // Retargets are paired before reshapes across the whole set, so a rename is
  // never stolen by an unrelated predicate that happens to share its subject.
  const unretargeted: TestPredicate[] = []
  for (const predicate of gone) {
    const partner = take((candidate) => signature(candidate) === signature(predicate))
    if (partner) changes.push({ kind: 'retargeted', verdict: 'equivalent', before: predicate, after: partner })
    else unretargeted.push(predicate)
  }
  for (const predicate of unretargeted) {
    const partner = take((candidate) => candidate.target === predicate.target)
    if (partner) changes.push(reshape(predicate, partner))
    else changes.push({ kind: 'removed', verdict: 'weaker', before: predicate })
  }
  for (const predicate of spare) changes.push({ kind: 'added', verdict: 'stronger', after: predicate })

  return { verdict: rollup(changes.map((change) => change.verdict)), changes }
}

const DISABLING_MODIFIERS: ReadonlySet<string> = new Set(['skip', 'fixme', 'fail'])

// A bare run-time `test.skip()` / `fixme()` / `fail()` silences the test as surely as
// the declaration modifier does.
function enforced(test: ExtractedTestPredicates): boolean {
  if (test.modifier && DISABLING_MODIFIERS.has(test.modifier)) return false
  return !test.guards?.some((guard) => guard.condition === undefined)
}

// The set a test actually enforces: nothing, when a declaration modifier or a bare
// guard keeps it from running or inverts its outcome.
function enforcedSet(test: ExtractedTestPredicates): PredicateSet {
  return enforced(test) ? test : NOTHING_ENFORCED
}

function testChange(before: ExtractedTestPredicates, after: ExtractedTestPredicates): TestChange | undefined {
  const set = diffPredicateSets(enforcedSet(before), enforcedSet(after))
  const wasEnforced = enforced(before)
  const isEnforced = enforced(after)
  if (wasEnforced === isEnforced) {
    if (set.changes.length === 0) return undefined
    return { kind: 'changed', name: after.name, verdict: set.verdict, changes: set.changes }
  }
  return { kind: isEnforced ? 'enabled' : 'disabled', name: after.name, verdict: set.verdict, changes: set.changes }
}

/** File-level differential over two extractions of the same spec. Tests pair by
 *  name in declaration order — the same key the dirty-spec store uses — then
 *  unmatched tests pair as a rename only when nothing about their proof differs. */
export function diffSpecPredicates(before: ExtractPredicatesResult, after: ExtractPredicatesResult): SpecDiff {
  const parseFailures = [
    ...(before.parseError ? [`before side does not parse: ${before.parseError}`] : []),
    ...(after.parseError ? [`after side does not parse: ${after.parseError}`] : []),
  ]
  if (parseFailures.length) return { verdict: 'unclassifiable', tests: [], reasons: parseFailures }

  const tests: TestChange[] = []
  const afterByName = new Map<string, ExtractedTestPredicates[]>()
  for (const test of after.tests) {
    const bucket = afterByName.get(test.name)
    if (bucket) bucket.push(test)
    else afterByName.set(test.name, [test])
  }
  const unmatchedBefore: ExtractedTestPredicates[] = []
  for (const test of before.tests) {
    const partner = afterByName.get(test.name)?.shift()
    if (!partner) {
      unmatchedBefore.push(test)
      continue
    }
    const change = testChange(test, partner)
    if (change) tests.push(change)
  }
  const unmatchedAfter = [...afterByName.values()].flat().sort((a, b) => a.line - b.line)

  for (const test of unmatchedBefore) {
    const renamedTo = unmatchedAfter.findIndex(
      (candidate) => enforced(candidate) === enforced(test) && diffPredicateSets(enforcedSet(test), enforcedSet(candidate)).changes.length === 0,
    )
    if (renamedTo !== -1) {
      const [partner] = unmatchedAfter.splice(renamedTo, 1)
      tests.push({ kind: 'renamed', name: partner.name, wasNamed: test.name, verdict: 'equivalent', changes: [] })
      continue
    }
    const set = diffPredicateSets(enforcedSet(test), NOTHING_ENFORCED)
    tests.push({ kind: 'deleted', name: test.name, verdict: set.verdict, changes: set.changes })
  }
  for (const test of unmatchedAfter) {
    const set = diffPredicateSets(NOTHING_ENFORCED, enforcedSet(test))
    tests.push({ kind: 'added', name: test.name, verdict: set.verdict, changes: set.changes })
  }

  // `only` narrows the run to the marked tests; the others are as unenforced as
  // a `skip` would make them. Reported once for the file, not per test.
  const onlyBefore = before.tests.filter((test) => test.modifier === 'only').length
  const onlyAfter = after.tests.filter((test) => test.modifier === 'only').length
  const reasons: string[] = []
  const fileVerdicts: StrengthVerdict[] = []
  if (onlyAfter && !onlyBefore) {
    reasons.push(`test.only limits the run to ${onlyAfter} of ${after.tests.length} tests`)
    fileVerdicts.push('weaker')
  } else if (onlyBefore && !onlyAfter) {
    reasons.push(`test.only removed; all ${after.tests.length} tests run again`)
    fileVerdicts.push('stronger')
  }

  return {
    verdict: rollup([...tests.map((test) => test.verdict), ...fileVerdicts]),
    tests,
    ...(reasons.length ? { reasons } : {}),
  }
}
