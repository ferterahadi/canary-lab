import type {
  MatcherFamily,
  PredicateStrength,
  StrengthTier,
  TestPredicate,
} from '../../../../../shared/verification-strength/types'

// The matcher-strength lattice: how much ONE predicate pins its target down,
// read from the matcher family and the shape of the expected value. The
// differential compares tiers across a before/after pair; this module never
// looks at two predicates at once.
//
// Decisions the code does not explain on its own:
// - A `dynamic` expected value is refused, not guessed. `toHaveText(total)` may
//   pin one value or compare the page with itself — the source cannot tell, and
//   an "equivalent" verdict built on a guess is the failure this lattice exists
//   to prevent.
// - Negation floors at `existential`: `not.toHaveText('a')` holds for every
//   other text, so it can never outrank a presence check.
// - An unknown matcher is refused by name, so a custom matcher surfaces in
//   review instead of being ranked by a rule written for something else.
// - `soft`, `poll` and `resolves`/`rejects` are ignored: they change when a
//   failure is reported, not what the predicate proves.

export const TIER_RANK: Record<StrengthTier, number> = { none: 0, existential: 1, pattern: 2, exact: 3 }

export function compareTiers(a: StrengthTier, b: StrengthTier): -1 | 0 | 1 {
  if (TIER_RANK[a] === TIER_RANK[b]) return 0
  return TIER_RANK[a] < TIER_RANK[b] ? -1 : 1
}

type RankedFamily = Exclude<MatcherFamily, 'unknown'>
type RankedTier = Exclude<StrengthTier, 'none'>
type Ranking = { tier: RankedTier } | { refused: string }

// Every matcher Playwright 1.62 declares (`playwright/types/test.d.ts`), by
// family. `lattice.test.ts` pins the list, so a matcher added upstream fails
// loudly until someone decides which family it belongs to.
const FAMILIES: Record<RankedFamily, readonly string[]> = {
  value: [
    'toBe', 'toEqual', 'toStrictEqual', 'toHaveText', 'toHaveCount', 'toHaveValue', 'toHaveValues',
    'toHaveTitle', 'toHaveURL', 'toHaveId', 'toHaveRole', 'toHaveClass', 'toHaveAccessibleName',
    'toHaveAccessibleDescription', 'toHaveAccessibleErrorMessage', 'toHaveLength', 'toHaveAttribute',
    'toHaveCSS', 'toHaveJSProperty', 'toHaveProperty', 'toHaveScreenshot', 'toMatchSnapshot',
  ],
  containment: ['toContain', 'toContainEqual', 'toContainText', 'toContainClass', 'toMatch', 'toMatchObject', 'toMatchAriaSnapshot'],
  comparison: ['toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeLessThan', 'toBeLessThanOrEqual', 'toBeCloseTo'],
  state: [
    'toBeAttached', 'toBeChecked', 'toBeDefined', 'toBeDisabled', 'toBeEditable', 'toBeEmpty', 'toBeEnabled',
    'toBeFalsy', 'toBeFocused', 'toBeHidden', 'toBeInViewport', 'toBeInstanceOf', 'toBeNaN', 'toBeNull', 'toBeOK',
    'toBeTruthy', 'toBeUndefined', 'toBeVisible', 'toPass',
  ],
  throw: ['toThrow', 'toThrowError'],
}

const MATCHER_FAMILY = new Map<string, RankedFamily>()
for (const [family, matchers] of Object.entries(FAMILIES) as [RankedFamily, readonly string[]][]) {
  for (const matcher of matchers) MATCHER_FAMILY.set(matcher, family)
}

export const KNOWN_MATCHERS: ReadonlySet<string> = new Set(MATCHER_FAMILY.keys())

// Snapshot matchers compare against a stored golden. Their argument, when there
// is one, names the file or is the template itself — never a value the shape
// rules can read. A pixel golden pins the rendering (exact); an aria snapshot is
// a partial subtree, so matching it is a pattern whether inline or stored.
const SNAPSHOT_TIER = new Map<string, RankedTier>([
  ['toHaveScreenshot', 'exact'],
  ['toMatchSnapshot', 'exact'],
  ['toMatchAriaSnapshot', 'pattern'],
])

// Options that widen what an exact match accepts. `timeout`, `useInnerText`, …
// change how the target is read, not what is proven, and are ignored.
const LOOSENING_OPTIONS = new Set(['ignoreCase', 'maxDiffPixels', 'maxDiffPixelRatio'])

// `toHaveAttribute(name)` / `toHaveProperty(path)` assert presence; with a second
// argument they assert the value. `toHaveCSS` / `toHaveJSProperty` always take
// both, so a one-argument call would not compile — reading it as presence is
// the only interpretation that does not invent a value.
const KEYED_VALUE_MATCHERS = new Set(['toHaveAttribute', 'toHaveProperty', 'toHaveCSS', 'toHaveJSProperty'])

const ANY_MATCHER = /^expect\.(anything|any)\(/
const ERROR_CLASS = /^[A-Z][A-Za-z0-9_]*$/

const DYNAMIC = 'expected value is computed at run time'
const NO_VALUE = 'value matcher without a value'

export function strengthOf(predicate: TestPredicate): PredicateStrength {
  const family = MATCHER_FAMILY.get(predicate.matcher)
  if (!family) return { kind: 'unclassifiable', family: 'unknown', reason: `unknown matcher ${predicate.matcher}` }
  const ranking = rank(predicate, family)
  if ('refused' in ranking) return { kind: 'unclassifiable', family, reason: ranking.refused }
  return { kind: 'ranked', tier: predicate.negated ? 'existential' : ranking.tier, family }
}

function rank(predicate: TestPredicate, family: RankedFamily): Ranking {
  const snapshot = SNAPSHOT_TIER.get(predicate.matcher)
  if (snapshot) return { tier: loosened(snapshot, predicate) }
  switch (family) {
    case 'state':
      return { tier: 'existential' }
    case 'throw':
      return rankThrow(predicate)
    case 'value':
      if (KEYED_VALUE_MATCHERS.has(predicate.matcher) && predicate.expectedArity === 1) return { tier: 'existential' }
      return rankValue(predicate)
    case 'containment':
    case 'comparison':
      return rankBound(predicate)
  }
}

function rankValue(predicate: TestPredicate): Ranking {
  switch (predicate.expected) {
    case 'none':
      return { refused: NO_VALUE }
    case 'dynamic':
      return { refused: DYNAMIC }
    case 'regex':
      return { tier: 'pattern' }
    case 'asymmetric':
      // `expect.anything()` / `expect.any(T)` accept every value of a kind — a
      // presence check spelled as a matcher. Every other asymmetric matcher
      // (`objectContaining`, `stringMatching`, …) constrains a shape.
      return { tier: ANY_MATCHER.test(String(predicate.expectedText)) ? 'existential' : 'pattern' }
    case 'literal':
    case 'collection':
      return { tier: loosened('exact', predicate) }
  }
}

// Containment and comparison constrain without pinning, so a concrete value is
// a pattern; a run-time value is still unreadable and a missing one malformed.
function rankBound(predicate: TestPredicate): Ranking {
  if (predicate.expected === 'none') return { refused: NO_VALUE }
  if (predicate.expected === 'dynamic') return { refused: DYNAMIC }
  return { tier: 'pattern' }
}

function rankThrow(predicate: TestPredicate): Ranking {
  switch (predicate.expected) {
    case 'none':
      return { tier: 'existential' }
    case 'dynamic':
      // A bare PascalCase identifier is an error class (`toThrow(TypeError)`):
      // it names a kind of failure, not a message, so it is a presence check.
      // Anything else computed at run time is refused like every other value.
      return ERROR_CLASS.test(String(predicate.expectedText)) ? { tier: 'existential' } : { refused: DYNAMIC }
    default:
      // A message, a regex, or an object shape constrains the error without
      // pinning it — `toThrow('boom')` is a substring match.
      return { tier: 'pattern' }
  }
}

function loosened(tier: RankedTier, predicate: TestPredicate): RankedTier {
  const loosens = (predicate.optionKeys ?? []).some((key) => LOOSENING_OPTIONS.has(key))
  return tier === 'exact' && loosens ? 'pattern' : tier
}
