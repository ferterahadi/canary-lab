import ts from 'typescript'
import {
  formatSourceSnippetForDisplay,
  type FormattedCodeDisplay,
} from '../../../../shared/code-display-format'
import type { PathType } from '../../../../shared/coverage/types'
import type { ReadableSemanticRuleConfig, ReadableTest } from '../../../../shared/readable-tests/types'
import type { TestPredicate, TestGuard,
  UnparsedExpectation } from '../../../../shared/verification-strength/types'
import { collectTestPredicates, guardFrom, TEST_DECLARATORS } from './verification-strength/predicates'
import {
  translateReadableTest,
  translateReadableTestFromAst,
  type ReadableHelperInput,
} from './readable-tests/translator'
import { parseSource } from './controlled-english/compiler-context'
import { compileSemanticSource } from './controlled-english/semantic-context'

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

export interface ExtractResult {
  file: string
  tests: ExtractedTest[]
  parseError?: string
}

export interface ExtractedTestMetadata {
  name: string
  line: number
  bodySource: string
  bodyLine: number
}

export interface ExtractMetadataResult {
  file: string
  tests: ExtractedTestMetadata[]
  parseError?: string
}

function getStringArg(node: ts.CallExpression, src?: ts.SourceFile): string | null {
  const arg = node.arguments[0]
  if (!arg) return null
  // isStringLiteralLike covers both string literals and no-substitution
  // template literals (`` `plain title` ``).
  if (ts.isStringLiteralLike(arg)) return arg.text
  // Template literal with substitutions, e.g. `redeems ${key} voucher`.
  // Reconstruct the raw template text with `${expr}` placeholders preserved
  // so loop-generated tests at least surface a recognisable name when the
  // Playwright `--list` enrichment isn't available.
  if (ts.isTemplateExpression(arg) && src) {
    // A template expression's source text is always backtick-delimited;
    // strip the surrounding backticks, keeping `${...}` segments verbatim.
    const raw = arg.getText(src)
    return raw.slice(1, -1)
  }
  return null
}

function getCalleeChain(expr: ts.Expression): string[] {
  // Returns the dotted access chain, e.g. `test.step.skip` → ["test","step","skip"].
  // Returns [] if the callee isn't an Identifier or a chain of property accesses
  // rooted at one.
  if (ts.isIdentifier(expr)) return [expr.text]
  if (ts.isPropertyAccessExpression(expr)) {
    const head = getCalleeChain(expr.expression)
    if (head.length === 0) return []
    return [...head, expr.name.text]
  }
  return []
}

/** A declaration-level modifier: `test.skip(...)`, `test.fixme(...)`, `test.fail(...)`,
 *  `test.only(...)`. The first three stop the test from proving anything; `only`
 *  stops every other test in the file from running. */
export type TestModifier = 'only' | 'skip' | 'fixme' | 'fail'

const TEST_DECLARATION_MODIFIERS: ReadonlySet<string> = new Set<TestModifier>(['only', 'skip', 'fixme', 'fail'])

function isTestModifier(name: string): name is TestModifier {
  return TEST_DECLARATION_MODIFIERS.has(name)
}

// Only meaningful for a call `isTestCall` accepted: a declaration's modifier is
// the second segment of its callee chain, and a bare `test(...)` has none.
function declarationModifier(call: ts.CallExpression): TestModifier | undefined {
  const tail = getCalleeChain(call.expression)[1] ?? ''
  return isTestModifier(tail) ? tail : undefined
}

function isTestCall(call: ts.CallExpression): boolean {
  // Match the test declaration forms — `test(...)` and its `it` spelling — but not
  // hooks/configuration methods such as test.beforeEach(), test.use(), or
  // test.setTimeout(). A titled hook also carries a string + callback, so argument
  // shape alone cannot distinguish it from a test.
  const [root, modifier, ...rest] = getCalleeChain(call.expression)
  if (root === undefined || !TEST_DECLARATORS.has(root)) return false
  if (modifier === undefined) return true
  return rest.length === 0 && isTestModifier(modifier)
}

function isTestStepCall(call: ts.CallExpression): boolean {
  const chain = getCalleeChain(call.expression)
  return chain.length >= 2 && TEST_DECLARATORS.has(chain[0] ?? '') && chain[1] === 'step'
}

function getStepBody(call: ts.CallExpression): ts.Node | null {
  const arg = call.arguments[1]
  if (!arg) return null
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg.body
  return null
}

// The test callback can be the 2nd or 3rd argument: `test(title, fn)` or, with a
// Playwright details object, `test(title, { tag }, fn)`. Scan the args after the
// title for the function so the body (steps + assertions) is found in both shapes.
// The first argument is never a body: in the callback form of a run-time guard,
// `test.skip(({ browserName }) => …, why)`, it is the condition, and reading it as a
// body would register the guard as a test named after its own condition.
function getCallableBody(call: ts.CallExpression): ts.Node | null {
  for (const arg of call.arguments.slice(1)) {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg.body
  }
  return null
}

function getTestNameArg(call: ts.CallExpression, src: ts.SourceFile, body: ts.Node | null): string | null {
  const staticName = getStringArg(call, src)
  if (staticName !== null) return staticName
  const arg = call.arguments[0]
  if (!arg || !body) return null
  // For an allowed declaration callee, an inline callback distinguishes a
  // dynamic title from a conditional modifier such as
  // `test.skip(condition, description)`. Keep the expression as a
  // location-bearing placeholder; Playwright replaces it with each resolved
  // title while reusing this call site's body and readable tree.
  return arg.getText(src)
}

const PATH_TYPE_VALUES: PathType[] = ['happy', 'sad', 'edge']

export interface TestAnnotations {
  requirements?: string[]
  pathTypes?: PathType[]
  variants?: string[]
}

// A variant token: `@variant-email` (tag form) / `@variant email` (comment form).
// Open vocabulary — any single token; lower-cased so claims match the (lower-case)
// dimension values. Deduped preserving first-seen order.
function dedupeVariants(values: string[]): string[] {
  const out: string[] = []
  for (const raw of values) {
    const v = raw.trim().toLowerCase()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

// Parse `@requirement <id>`, `@path happy|sad|edge` and `@variant <value>` out of
// a comment blob. All repeatable; `@path`/`@variant` also accept a comma/space
// list on one line. Ids/variants dedupe preserving first-seen order; path types
// are canonically ordered (happy, sad, edge). Returns undefined fields when the
// annotation is absent so un-annotated tests stay clean.
export function parseTestAnnotations(commentText: string): TestAnnotations {
  const requirements: string[] = []
  const reqRe = /@requirement\s+([A-Za-z0-9_-]+)/g
  let m: RegExpExecArray | null
  while ((m = reqRe.exec(commentText)) !== null) {
    if (!requirements.includes(m[1])) requirements.push(m[1])
  }
  const pathSet = new Set<PathType>()
  const pathRe = /@path\s+([^\n\r*]+)/g
  while ((m = pathRe.exec(commentText)) !== null) {
    for (const token of m[1].split(/[,\s]+/)) {
      const v = token.trim().toLowerCase()
      if ((PATH_TYPE_VALUES as string[]).includes(v)) pathSet.add(v as PathType)
    }
  }
  const variantTokens: string[] = []
  const variantRe = /@variant\s+([^\n\r*]+)/g
  while ((m = variantRe.exec(commentText)) !== null) {
    for (const token of m[1].split(/[,\s]+/)) variantTokens.push(token)
  }
  const pathTypes = PATH_TYPE_VALUES.filter((p) => pathSet.has(p))
  const variants = dedupeVariants(variantTokens)
  return {
    requirements: requirements.length ? requirements : undefined,
    pathTypes: pathTypes.length ? pathTypes : undefined,
    variants: variants.length ? variants : undefined,
  }
}

// Map Playwright test tags to coverage linkage. The convention (R1):
//   • `@req-<id>`        → requirement id (`@req-R3` → "R3")
//   • `@path-<type>`     → path type (`@path-happy` → "happy")
// Both greppable and rename-proof (they live ON the test, not in a comment).
// Ids dedupe preserving first-seen order; path types are canonically ordered.
export function parseTestTagList(tags: string[]): TestAnnotations {
  const requirements: string[] = []
  const pathSet = new Set<PathType>()
  const variantTokens: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    const reqM = /^@req-(.+)$/.exec(tag)
    if (reqM) {
      const id = reqM[1].trim()
      if (id && !requirements.includes(id)) requirements.push(id)
      continue
    }
    const pathM = /^@path-(.+)$/.exec(tag)
    if (pathM) {
      const v = pathM[1].trim().toLowerCase()
      if ((PATH_TYPE_VALUES as string[]).includes(v)) pathSet.add(v as PathType)
      continue
    }
    const variantM = /^@variant-(.+)$/.exec(tag)
    if (variantM) variantTokens.push(variantM[1])
  }
  const pathTypes = PATH_TYPE_VALUES.filter((p) => pathSet.has(p))
  const variants = dedupeVariants(variantTokens)
  return {
    requirements: requirements.length ? requirements : undefined,
    pathTypes: pathTypes.length ? pathTypes : undefined,
    variants: variants.length ? variants : undefined,
  }
}

// Pull the string values out of a `tag` property in the test's details object
// (`test('…', { tag: '@req-R1' }, …)` or `{ tag: ['@req-R1', '@path-happy'] }`).
function readTagPropertyStrings(value: ts.Expression): string[] {
  const out: string[] = []
  if (ts.isStringLiteralLike(value)) {
    out.push(value.text)
  } else if (ts.isArrayLiteralExpression(value)) {
    for (const el of value.elements) {
      if (ts.isStringLiteralLike(el)) out.push(el.text)
    }
  }
  return out
}

// Read coverage tags from a `test(...)` call's Playwright details object (the
// argument that is an object literal). Absent / non-object → no tags.
function parseTestTags(call: ts.CallExpression): TestAnnotations {
  const detail = call.arguments.find((a) => ts.isObjectLiteralExpression(a)) as
    | ts.ObjectLiteralExpression
    | undefined
  if (!detail) return {}
  for (const prop of detail.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : ''
    if (key !== 'tag' && key !== 'tags') continue
    return parseTestTagList(readTagPropertyStrings(prop.initializer))
  }
  return {}
}

// Union two annotation sources (Playwright tags take precedence in order, then
// comment annotations as a migration fallback). Requirements dedupe preserving
// first-seen order; path types are canonically ordered.
function mergeAnnotations(primary: TestAnnotations, fallback: TestAnnotations): TestAnnotations {
  const requirements: string[] = []
  for (const id of [...(primary.requirements ?? []), ...(fallback.requirements ?? [])]) {
    if (!requirements.includes(id)) requirements.push(id)
  }
  const pathSet = new Set<PathType>([...(primary.pathTypes ?? []), ...(fallback.pathTypes ?? [])])
  const pathTypes = PATH_TYPE_VALUES.filter((p) => pathSet.has(p))
  const variants = dedupeVariants([...(primary.variants ?? []), ...(fallback.variants ?? [])])
  return {
    requirements: requirements.length ? requirements : undefined,
    pathTypes: pathTypes.length ? pathTypes : undefined,
    variants: variants.length ? variants : undefined,
  }
}

// Collect the leading comment text immediately above a node (the annotation
// block). Concatenates all leading comment ranges so a multi-line `//` block or
// a `/* */` block both work.
function leadingCommentText(node: ts.Node, src: ts.SourceFile): string {
  const fullText = src.getFullText()
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart())
  if (!ranges || !ranges.length) return ''
  return ranges.map((r) => fullText.slice(r.pos, r.end)).join('\n')
}

function bodySourceFor(node: ts.Node, src: ts.SourceFile): string {
  return formatSourceSnippetForDisplay(src.getFullText().slice(node.getStart(src), node.getEnd()))
}

function lineFor(node: ts.Node, src: ts.SourceFile): number {
  const { line } = src.getLineAndCharacterOfPosition(node.getStart(src))
  return line + 1
}

function topLevelReadableHelpers(file: string, src: ts.SourceFile): ReadableHelperInput[] {
  const helpers = new Map<string, ReadableHelperInput>()
  const add = (name: string | undefined, body: ts.ConciseBody | undefined): void => {
    if (!name || !body || helpers.has(name)) return
    helpers.set(name, {
      name,
      file,
      bodySource: bodySourceFor(body, src),
      startLine: lineFor(body, src),
    })
  }
  for (const statement of src.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      add(statement.name?.text, statement.body)
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const initializer = declaration.initializer
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        add(declaration.name.text, initializer.body)
      }
    }
  }
  return [...helpers.values()]
}

// Calls whose presence in a body is itself a "check" of some stack layer —
// navigation, network, DB, or file reads — even without an enclosing expect().
const CHECK_METHOD_NAMES = new Set([
  'goto', 'waitForURL', // browser navigation (tier 4 when the URL is external)
  'get', 'post', 'put', 'delete', 'patch', 'fetch', // network / API (tier 3)
  'query', 'findOne', 'findMany', 'findFirst', // DB / ORM (tier 2)
  'readFile', 'readFileSync', // file / log reads (tier 1)
])

// Collect assertion + check snippets from a test body. For `expect(...)` we
// climb to the outermost matcher call so the full assertion (and what layer it
// touches) is captured; standalone navigation/network/db/file calls are taken
// as-is. Deduped by rendered text. Pure structural collection — the rigor layer
// classifies the tier from these snippets.
function collectAssertionSnippets(body: ts.Node, src: ts.SourceFile): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (node: ts.Node) => {
    const text = formatSourceSnippetForDisplay(src.getFullText().slice(node.getStart(src), node.getEnd()))
    if (!seen.has(text)) {
      seen.add(text)
      out.push(text)
    }
  }
  function visit(n: ts.Node): void {
    if (ts.isCallExpression(n)) {
      const chain = getCalleeChain(n.expression)
      if (chain[0] === 'expect') {
        let top: ts.Node = n
        let p: ts.Node | undefined = n.parent
        while (
          p &&
          (ts.isPropertyAccessExpression(p) ||
            ts.isCallExpression(p) ||
            ts.isAwaitExpression(p) ||
            ts.isNonNullExpression(p))
        ) {
          top = p
          p = p.parent
        }
        add(top)
        return // don't re-collect the inner expect() on recursion
      }
      if (chain.some((c) => CHECK_METHOD_NAMES.has(c))) add(n)
    }
    n.forEachChild(visit)
  }
  visit(body)
  return out
}

function extractStepsFrom(node: ts.Node, src: ts.SourceFile): ExtractedStep[] {
  const out: ExtractedStep[] = []
  function visit(n: ts.Node, collector: ExtractedStep[]): void {
    if (ts.isCallExpression(n) && isTestStepCall(n)) {
      const label = getStringArg(n, src)
      if (label !== null) {
        const body = getStepBody(n)
        const step: ExtractedStep = {
          label,
          line: lineFor(n, src),
          bodySource: body ? bodySourceFor(body, src) : '',
          children: [],
        }
        if (body) visit(body, step.children)
        collector.push(step)
        return // don't double-visit children at this level
      }
    }
    n.forEachChild((c) => visit(c, collector))
  }
  node.forEachChild((c) => visit(c, out))
  return out
}

interface TestDeclaration {
  call: ts.CallExpression
  modifier?: TestModifier
  body: ts.Node | null
  name: string
  line: number
  bodySource: string
  bodyLine: number
  /** No callback, or a callback with no statements: the test can enforce nothing. */
  emptyBody: boolean
}

// ---- Parametrised declarations ----------------------------------------------------
//
// `for (const key of KEYS) test(\`redeems ${key}\`, …)` declares one test per element at
// run time. The readable and metadata extractors keep the single template-named
// declaration: the runner's `--list` resolves the real titles for them. The
// verification-strength differential has no runner — it compares two sources — so
// for it the iteration set is enumerated here, syntactically: an array literal
// written inline or bound to a `const`/`let` in an enclosing scope, seen through
// `as const`, `satisfies` and parentheses. Dropping an element from that array
// deletes a test, and only an enumerated set can show it. A set that cannot be read
// (a call, an import, a spread, `Object.entries`) leaves the declaration as one
// template-named test, exactly as before.

interface LoopLevel {
  binding: ts.BindingName
  elements: ts.Expression[]
}

/** The literal each bound name takes under one iteration. */
type IterationBindings = Map<string, ts.Expression>

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)
  ) current = current.expression
  return current
}

function encloses(scope: ts.Node, node: ts.Node): boolean {
  return scope.pos <= node.pos && node.end <= scope.end
}

// The innermost `const`/`let` named `name` declared by a statement whose block
// encloses `from`. Syntax only: no binder, so shadowing is read from nesting.
function enclosingBinding(name: string, from: ts.Node, src: ts.SourceFile): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined
  let foundScope: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      const list = node.parent
      const statement = list.parent
      const blockScoped = (list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0
      if (blockScoped && ts.isVariableStatement(statement) && encloses(statement.parent, from) && (!foundScope || encloses(foundScope, statement.parent))) {
        found = node
        foundScope = statement.parent
      }
    }
    node.forEachChild(visit)
  }
  visit(src)
  return found
}

function literalElements(
  expr: ts.Expression,
  from: ts.Node,
  src: ts.SourceFile,
  seen: Set<ts.VariableDeclaration>,
): ts.Expression[] | undefined {
  const unwrapped = unwrapExpression(expr)
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.some(ts.isSpreadElement) ? undefined : [...unwrapped.elements]
  }
  if (!ts.isIdentifier(unwrapped)) return undefined
  // `const KEYS = OTHER` resolves one step further; `seen` stops a self-reference
  // (`const keys = keys`), which parses even though it can never run.
  const declaration = enclosingBinding(unwrapped.text, from, src)
  if (!declaration?.initializer || seen.has(declaration)) return undefined
  seen.add(declaration)
  return literalElements(declaration.initializer, declaration, src, seen)
}

// Every enclosing loop that declares this test once per element, outermost first:
// `for (const k of KEYS) { … }` and `KEYS.forEach((k) => { … })`. A level whose set
// cannot be read contributes nothing.
function loopLevelsOf(call: ts.CallExpression, src: ts.SourceFile): LoopLevel[] {
  const levels: LoopLevel[] = []
  let child: ts.Node = call
  for (let node: ts.Node = call.parent; !ts.isSourceFile(node); child = node, node = node.parent) {
    let binding: ts.BindingName | undefined
    let iterable: ts.Expression | undefined
    if (ts.isForOfStatement(node) && child === node.statement && ts.isVariableDeclarationList(node.initializer)) {
      binding = node.initializer.declarations[0]?.name
      iterable = node.expression
    } else if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      && ts.isCallExpression(node.parent) && node.parent.arguments[0] === node
      && ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.name.text === 'forEach'
    ) {
      binding = node.parameters[0]?.name
      iterable = node.parent.expression.expression
    }
    if (!binding || !iterable) continue
    const elements = literalElements(iterable, node, src, new Set())
    if (elements) levels.unshift({ binding, elements })
  }
  return levels
}

function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name) {
      return property.initializer
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name
  }
  return undefined
}

// What one element binds: the name itself, the properties an object pattern picks
// (`{ key, errorText: text }`), or the positions an array pattern picks (`[key, value]`).
// A pattern the element's shape cannot satisfy binds nothing.
function bindingsFor(binding: ts.BindingName, element: ts.Expression): IterationBindings {
  const bound: IterationBindings = new Map()
  const value = unwrapExpression(element)
  if (ts.isIdentifier(binding)) {
    bound.set(binding.text, value)
  } else if (ts.isObjectBindingPattern(binding) && ts.isObjectLiteralExpression(value)) {
    for (const part of binding.elements) {
      const key = part.propertyName ?? part.name
      if (!ts.isIdentifier(part.name) || part.dotDotDotToken || !(ts.isIdentifier(key) || ts.isStringLiteral(key))) continue
      const property = propertyValue(value, key.text)
      if (property) bound.set(part.name.text, property)
    }
  } else if (ts.isArrayBindingPattern(binding) && ts.isArrayLiteralExpression(value)) {
    binding.elements.forEach((part, index) => {
      const item = value.elements[index]
      if (ts.isBindingElement(part) && ts.isIdentifier(part.name) && !part.dotDotDotToken && item && !ts.isSpreadElement(item) && !ts.isOmittedExpression(item)) {
        bound.set(part.name.text, item)
      }
    })
  }
  return bound
}

// The text an interpolation takes under one iteration: `${key}` or `${entry.key}`
// where the name is bound. A string element interpolates as its value, as the
// template does at run time; anything else as its source. Unbound → undefined, and
// the interpolation stays as written.
function interpolated(expr: ts.Expression, bound: IterationBindings, src: ts.SourceFile): string | undefined {
  let value: ts.Expression | undefined
  if (ts.isIdentifier(expr)) {
    value = bound.get(expr.text)
  } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const object = bound.get(expr.expression.text)
    const unwrapped = object ? unwrapExpression(object) : undefined
    value = unwrapped && ts.isObjectLiteralExpression(unwrapped) ? propertyValue(unwrapped, expr.name.text) : undefined
  }
  if (!value) return undefined
  return ts.isStringLiteralLike(value) ? value.text : value.getText(src).replace(/\s+/g, ' ')
}

function resolvedName(call: ts.CallExpression, name: string, bound: IterationBindings, src: ts.SourceFile): string {
  const title = call.arguments[0]
  if (!title || ts.isStringLiteralLike(title)) return name
  if (!ts.isTemplateExpression(title)) return interpolated(title, bound, src) ?? name
  // Replace each `${…}` span, last first so earlier offsets stay valid. A span opens
  // with the last two characters of the literal token before it and closes with the
  // first character of the literal token after it.
  const start = title.getStart(src)
  let text = title.getText(src)
  let previous: ts.Node = title.head
  const spans = title.templateSpans.map((span) => {
    const range = { span, from: previous.getEnd() - 2 - start, to: span.literal.getStart(src) + 1 - start }
    previous = span.literal
    return range
  })
  for (const { span, from, to } of spans.reverse()) {
    const value = interpolated(span.expression, bound, src)
    if (value !== undefined) text = text.slice(0, from) + value + text.slice(to)
  }
  return text.slice(1, -1)
}

// One name per run-time test the declaration produces: the cartesian product of its
// readable loop levels, outer first — the order the runner declares them in. With no
// readable level this is the single name the walker found.
function parametrisedNames(call: ts.CallExpression, name: string, src: ts.SourceFile): string[] {
  let combos: IterationBindings[] = [new Map()]
  for (const level of loopLevelsOf(call, src)) {
    combos = combos.flatMap((outer) => level.elements.map((element) => new Map([...outer, ...bindingsFor(level.binding, element)])))
  }
  return combos.map((bound) => resolvedName(call, name, bound, src))
}

interface DeclarationWalkOptions {
  /** Enumerate `for … of` / `forEach` iteration sets into one declaration per element. */
  expandParametrised?: boolean
}

function testDeclarationsFrom(src: ts.SourceFile, options: DeclarationWalkOptions = {}): TestDeclaration[] {
  const declarations: TestDeclaration[] = []
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const body = getCallableBody(node)
      const name = getTestNameArg(node, src, body)
      if (name !== null) {
        const modifier = declarationModifier(node)
        const names = options.expandParametrised ? parametrisedNames(node, name, src) : [name]
        for (const resolved of names) {
          declarations.push({
            call: node,
            body,
            name: resolved,
            line: lineFor(node, src),
            bodySource: body ? bodySourceFor(body, src) : '',
            bodyLine: body ? lineFor(body, src) : lineFor(node, src),
            emptyBody: body === null || (ts.isBlock(body) && body.statements.length === 0),
            ...(modifier ? { modifier } : {}),
          })
        }
        // A test callback cannot declare another suite-level test. Avoid walking
        // its body again; test.step calls are handled by the full extractor.
        return
      }
    }
    node.forEachChild(visit)
  }
  visit(src)
  return declarations
}

/** The integrity scanner needs only stable test names and callback bodies. Keep
 * that evidence path syntax-only: rendering prose or building a TypeChecker
 * cannot change a content hash and must not delay server readiness. */
export function extractTestMetadataFromSource(file: string, source: string): ExtractMetadataResult {
  try {
    const { sourceFile } = parseSource(file, source)
    return {
      file,
      tests: testDeclarationsFrom(sourceFile).map(({ name, line, bodySource, bodyLine }) => ({
        name,
        line,
        bodySource,
        bodyLine,
      })),
    }
  } catch (err) {
    return {
      file,
      tests: [],
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}

const HOOKS: ReadonlySet<string> = new Set(['beforeEach', 'beforeAll', 'afterEach', 'afterAll'])

function isDescribeChain(chain: string[]): boolean {
  return chain[0] === 'describe' || (TEST_DECLARATORS.has(chain[0] ?? '') && chain[1] === 'describe')
}

function isHookChain(chain: string[]): boolean {
  return HOOKS.has(chain[0] ?? '') || (TEST_DECLARATORS.has(chain[0] ?? '') && HOOKS.has(chain[1] ?? ''))
}

interface ScopedGuard {
  guard: TestGuard
  /** The node whose test declarations the guard reaches. */
  scope: ts.Node
}

// A guard outside every test body reaches the tests declared in its scope: the
// enclosing describe callback, or the whole file when it sits at top level. A hook
// body is transparent — `test.skip(cond)` in a `beforeEach` skips each test of its
// describe — while any other function body (a helper) is opaque: which tests call
// the helper is not a syntactic fact, so its guard is dropped rather than guessed.
function scopeOf(guard: ts.CallExpression): ts.Node | undefined {
  let node: ts.Node = guard.parent
  while (!ts.isSourceFile(node)) {
    if (ts.isFunctionLike(node)) {
      const chain = ts.isCallExpression(node.parent) ? getCalleeChain(node.parent.expression) : []
      if (isDescribeChain(chain)) return node
      if (!isHookChain(chain)) return undefined
    }
    node = node.parent
  }
  return node
}

function scopedGuardsFrom(sourceFile: ts.SourceFile): ScopedGuard[] {
  const scoped: ScopedGuard[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // Guard first: `isTestCall` accepts any `test.skip(...)` by its callee alone, and
      // a describe-level `test.skip(cond, why)` is exactly what this walk is for. A test
      // body is not entered — a guard inside one belongs to that test — and
      // `test.skip('title', fn)` is a declaration, which `guardFrom` refuses.
      const guard = guardFrom(node, sourceFile)
      if (guard) {
        const scope = scopeOf(node)
        if (scope) scoped.push({ guard, scope })
      } else if (isTestCall(node)) {
        return
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return scoped
}

function inheritedGuards(scoped: ScopedGuard[], declaration: ts.CallExpression): TestGuard[] {
  return scoped
    .filter(({ scope }) => scope.pos <= declaration.pos && declaration.end <= scope.end)
    .map(({ guard }) => guard)
}

export interface ExtractedTestPredicates {
  name: string
  line: number
  /** Declaration modifier, when one is present. `skip`/`fixme`/`fail` mean the
   *  predicates below are not enforced; `only` means the rest of the file is not. */
  modifier?: TestModifier
  predicates: TestPredicate[]
  /** `expect(...)` forms the collector could not read. Present only when non-empty. */
  unparsed?: UnparsedExpectation[]
  /** Run-time guards that reach this test: those inherited from the file's top level,
   *  an enclosing describe or its hooks (outermost first), then the body's own.
   *  Present only when non-empty. */
  guards?: TestGuard[]
  /** The callback has no statements, or there is no callback: the test can enforce
   *  nothing, so adding or deleting it changes no proof. Absent otherwise. */
  emptyBody?: true
}

export interface ExtractPredicatesResult {
  file: string
  tests: ExtractedTestPredicates[]
  parseError?: string
}

/** The verification-strength differential reads each test's assertion set from
 * here. Syntax-only, like the metadata extractor: what a test checks must not
 * depend on the readable-prose pipeline or a TypeChecker, and it runs on every
 * dirty-spec recompute. */
export function extractTestPredicatesFromSource(file: string, source: string): ExtractPredicatesResult {
  try {
    const { sourceFile } = parseSource(file, source)
    const scoped = scopedGuardsFrom(sourceFile)
    return {
      file,
      // Parametrised declarations are enumerated for the differential alone — see the
      // walker's note; the metadata and readable extractors keep the template name.
      tests: testDeclarationsFrom(sourceFile, { expandParametrised: true }).map(({ call, name, line, body, modifier, emptyBody }) => {
        const collected = body ? collectTestPredicates(body, sourceFile) : { predicates: [], unparsed: [], guards: [] }
        const guards = [...inheritedGuards(scoped, call), ...collected.guards]
        return {
          name,
          line,
          ...(modifier ? { modifier } : {}),
          predicates: collected.predicates,
          ...(collected.unparsed.length ? { unparsed: collected.unparsed } : {}),
          ...(guards.length ? { guards } : {}),
          ...(emptyBody ? { emptyBody: true as const } : {}),
        }
      }),
    }
  } catch (err) {
    return {
      file,
      tests: [],
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}

export function extractTestsFromSource(
  file: string,
  source: string,
  semanticRules?: ReadableSemanticRuleConfig,
): ExtractResult {
  try {
    const semanticContext = compileSemanticSource(file, source, { semanticRules, absoluteSourceRanges: true })
    const src = semanticContext.sourceFile
    const tests: ExtractedTest[] = []
    const readableHelpers = topLevelReadableHelpers(file, src)
    for (const declaration of testDeclarationsFrom(src)) {
      const { call, body, name, line, bodySource, bodyLine } = declaration
      // Playwright tags are primary (R1); comment annotations are the migration
      // fallback. Union both so a half-migrated spec still works.
      const annotations = mergeAnnotations(
        parseTestTags(call),
        parseTestAnnotations(leadingCommentText(call, src)),
      )
      const assertions = body ? collectAssertionSnippets(body, src) : []
      const readable = body && ts.isBlock(body)
        ? translateReadableTestFromAst({
            file,
            title: name,
            sourceFile: src,
            body,
            helpers: readableHelpers,
            semanticContext,
          })
        : translateReadableTest({
            file,
            title: name,
            bodySource,
            startLine: bodyLine,
            helpers: readableHelpers,
            semanticRules,
          })
      tests.push({
        name,
        line,
        bodySource,
        bodyLine,
        steps: body ? extractStepsFrom(body, src) : [],
        readable,
        ...(annotations.requirements ? { requirements: annotations.requirements } : {}),
        ...(annotations.pathTypes ? { pathTypes: annotations.pathTypes } : {}),
        ...(annotations.variants ? { variants: annotations.variants } : {}),
        ...(assertions.length ? { assertions } : {}),
      })
    }
    return { file, tests }
  } catch (err) {
    return {
      file,
      tests: [],
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}
