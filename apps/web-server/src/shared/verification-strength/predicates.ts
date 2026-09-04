import ts from 'typescript'
import type {
  ExpectedShape,
  TestGuard,
  TestPredicate,
  UnparsedExpectation,
} from '../../../../../shared/verification-strength/types'
import { parseExpectation } from '../readable-tests/assertions'

// Per-test predicate extraction — the structural half of the verification-
// strength differential. Walks a test body, finds every `expect(...)` chain and
// records what it checks (target), how (matcher), and against what shape of
// value. Nothing here ranks anything: the lattice does that from these facts.
//
// Reuses the readable-tests chain parser (`parseExpectation`) for `.not`,
// `.soft`, `.resolves`/`.rejects` and — opted in here — `expect.poll`, so the
// two readers of an assertion can never disagree about its modifiers.

export interface CollectedPredicates {
  predicates: TestPredicate[]
  unparsed: UnparsedExpectation[]
  /** Run-time `test.skip(cond)` / `test.fixme()` / `test.fail(cond)` calls in the body. */
  guards: TestGuard[]
}

// Playwright / Jest matcher option keys. An object literal whose keys ALL come
// from this set is read as options, not as an expected value. The approximation
// misreads `toEqual({ timeout: 5 })` as an option bag — a value object made only
// of option-named keys is rare enough that the false "no expected value" it
// produces is the cheaper error.
const OPTION_KEYS = new Set([
  'timeout', 'intervals', 'message',
  'ignoreCase', 'useInnerText', 'normalizeWhiteSpace',
  'visible', 'checked', 'indeterminate', 'editable', 'enabled', 'attached', 'ratio',
  'maxDiffPixels', 'maxDiffPixelRatio', 'threshold', 'animations', 'caret', 'mask',
  'scale', 'stylePath', 'omitBackground', 'clip', 'fullPage',
])

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// The `expect(...)` / `expect.soft(...)` / `expect.poll(...)` call that roots a
// chain. Matcher calls such as `.toBe(1)` have a property-access callee whose
// object is the chain, so they are not roots.
function isExpectRoot(call: ts.CallExpression): boolean {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text === 'expect'
  return ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression)
    && callee.expression.text === 'expect'
    && (callee.name.text === 'soft' || callee.name.text === 'poll')
}

interface ChainTop {
  /** Outermost node of the chain — the awaited/parenthesized whole. */
  top: ts.Node
  /** The last call in the chain: the matcher call, when there is one. */
  matcherCall: ts.CallExpression | null
}

// Climb from the root call along the receiver path only. Each step up must keep
// the current node in the parent's callee/operand slot: a chain passed as an
// ARGUMENT to something else ends here, so an `expect(n).toBe(1)` inside a
// `toPass` callback is attributed to itself, not to the enclosing chain.
function climbChain(root: ts.CallExpression): ChainTop {
  let current: ts.Node = root
  let matcherCall: ts.CallExpression | null = null
  for (let parent = current.parent; parent; parent = current.parent) {
    const onReceiverPath = (
      (ts.isPropertyAccessExpression(parent) || ts.isCallExpression(parent) || ts.isNonNullExpression(parent)
        || ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent))
      && parent.expression === current
    )
    if (!onReceiverPath) break
    if (ts.isCallExpression(parent)) matcherCall = parent
    current = parent
  }
  return { top: current, matcherCall }
}

function isOptionsObject(node: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length === 0) return false
  return node.properties.every((property) =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    && ts.isIdentifier(property.name)
    && OPTION_KEYS.has(property.name.text))
}

function optionKeysOf(node: ts.ObjectLiteralExpression): string[] {
  return node.properties.map((property) => (property.name as ts.Identifier).text)
}

function isAsymmetricMatcher(node: ts.Node): boolean {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'expect'
}

function containsAsymmetricMatcher(node: ts.Node): boolean {
  if (isAsymmetricMatcher(node)) return true
  return node.forEachChild((child) => containsAsymmetricMatcher(child) || undefined) ?? false
}

function isLiteral(node: ts.Expression): boolean {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return true
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true
  if (ts.isIdentifier(node) && node.text === 'undefined') return true
  return ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)
}

function isRegExpConstruction(node: ts.Expression): boolean {
  return ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp'
}

export function expectedShapeOf(node: ts.Expression): ExpectedShape {
  if (isLiteral(node)) return 'literal'
  if (ts.isRegularExpressionLiteral(node) || isRegExpConstruction(node)) return 'regex'
  if (containsAsymmetricMatcher(node)) return 'asymmetric'
  if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) return 'collection'
  return 'dynamic'
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

const GUARD_KINDS: ReadonlySet<string> = new Set<TestGuard['kind']>(['skip', 'fixme', 'fail'])

function isGuardKind(name: string): name is TestGuard['kind'] {
  return GUARD_KINDS.has(name)
}

/** The run-time guard a call is, if it is one: `test.skip(cond, why)`, `test.fixme()`,
 *  `test.fail(cond)`. The same callee with a string first argument is a test
 *  *declaration* (`test.skip('title', fn)`) — the declaration walker's business — so it
 *  is refused here; the two readers of `test.skip` must never both claim a call. */
export function guardFrom(call: ts.CallExpression, sourceFile: ts.SourceFile): TestGuard | undefined {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) || callee.expression.text !== 'test') return undefined
  const kind = callee.name.text
  if (!isGuardKind(kind)) return undefined
  const [first] = call.arguments
  if (first && (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first))) return undefined
  return {
    kind,
    ...(first ? { condition: normalize(first.getText(sourceFile)) } : {}),
    line: lineOf(call, sourceFile),
    source: normalize(call.getText(sourceFile)),
  }
}

export function collectTestPredicates(body: ts.Node, sourceFile: ts.SourceFile): CollectedPredicates {
  const predicates: TestPredicate[] = []
  const unparsed: UnparsedExpectation[] = []
  const guards: TestGuard[] = []
  const text = (node: ts.Node): string => normalize(node.getText(sourceFile))

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isExpectRoot(node)) {
      const { top, matcherCall } = climbChain(node)
      const expectation = matcherCall ? parseExpectation(matcherCall, { allowPoll: true }) : undefined
      if (!matcherCall || !expectation) {
        unparsed.push({
          line: lineOf(top, sourceFile),
          source: text(top),
          reason: matcherCall ? 'unrecognized expect chain' : 'no matcher call',
        })
      } else {
        const args = [...matcherCall.arguments]
        const last = args[args.length - 1]
        const options = last && isOptionsObject(last) ? (args.pop(), last as ts.ObjectLiteralExpression) : undefined
        const value = args[args.length - 1]
        predicates.push({
          matcher: expectation.matcher,
          target: text(expectation.actual),
          expected: value ? expectedShapeOf(value) : 'none',
          ...(args.length ? { expectedText: args.map(text).join(', ') } : {}),
          expectedArity: args.length,
          ...(options ? { optionKeys: optionKeysOf(options) } : {}),
          negated: expectation.negated,
          soft: expectation.soft,
          poll: expectation.poll,
          ...(expectation.settlement ? { settlement: expectation.settlement } : {}),
          line: lineOf(top, sourceFile),
          source: text(top),
        })
      }
    }
    const guard = ts.isCallExpression(node) ? guardFrom(node, sourceFile) : undefined
    if (guard) guards.push(guard)
    // Keep descending: a chain's arguments can hold further chains (`toPass`).
    node.forEachChild(visit)
  }
  visit(body)
  return { predicates, unparsed, guards }
}
