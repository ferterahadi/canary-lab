import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../../shared/code-display-format'
import type { PathType } from '../../../../../../shared/coverage/types'

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
  steps: ExtractedStep[]
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

function isTestCall(call: ts.CallExpression): boolean {
  // Match `test(...)`, `test.only(...)`, `test.skip(...)` — but NOT `test.step(...)`
  // (those are inner steps) and NOT `test.describe(...)` (those are grouping
  // wrappers, not tests themselves).
  const chain = getCalleeChain(call.expression)
  if (chain.length === 0 || chain[0] !== 'test') return false
  if (chain.length === 1) return true
  if (chain[1] === 'step' || chain[1] === 'describe') return false
  return true
}

function isTestStepCall(call: ts.CallExpression): boolean {
  const chain = getCalleeChain(call.expression)
  return chain.length >= 2 && chain[0] === 'test' && chain[1] === 'step'
}

function getStepBody(call: ts.CallExpression): ts.Node | null {
  const arg = call.arguments[1]
  if (!arg) return null
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg.body
  return null
}

// The test callback can be the 2nd or 3rd argument: `test(title, fn)` or, with a
// Playwright details object, `test(title, { tag }, fn)`. Scan all args for the
// function so the body (steps + assertions) is found in both shapes.
function getCallableBody(call: ts.CallExpression): ts.Node | null {
  for (const arg of call.arguments) {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg.body
  }
  return null
}

const PATH_TYPE_VALUES: PathType[] = ['happy', 'sad', 'edge']

export interface TestAnnotations {
  requirements?: string[]
  pathTypes?: PathType[]
}

// Parse `@requirement <id>` and `@path happy|sad|edge` out of a comment blob.
// Both are repeatable; `@path` also accepts a comma/space list on one line
// (`@path happy, sad`). Ids are deduped preserving first-seen order; path types
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
  const pathTypes = PATH_TYPE_VALUES.filter((p) => pathSet.has(p))
  return {
    requirements: requirements.length ? requirements : undefined,
    pathTypes: pathTypes.length ? pathTypes : undefined,
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
    }
  }
  const pathTypes = PATH_TYPE_VALUES.filter((p) => pathSet.has(p))
  return {
    requirements: requirements.length ? requirements : undefined,
    pathTypes: pathTypes.length ? pathTypes : undefined,
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
  return {
    requirements: requirements.length ? requirements : undefined,
    pathTypes: pathTypes.length ? pathTypes : undefined,
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

export function extractTestsFromSource(file: string, source: string): ExtractResult {
  try {
    const src = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const tests: ExtractedTest[] = []
    function visit(n: ts.Node): void {
      if (ts.isCallExpression(n) && isTestCall(n)) {
        const name = getStringArg(n, src)
        if (name !== null) {
          const body = getCallableBody(n)
          // Playwright tags are primary (R1); comment annotations are the
          // migration fallback. Union both so a half-migrated spec still works.
          const annotations = mergeAnnotations(
            parseTestTags(n),
            parseTestAnnotations(leadingCommentText(n, src)),
          )
          const assertions = body ? collectAssertionSnippets(body, src) : []
          tests.push({
            name,
            line: lineFor(n, src),
            bodySource: body ? bodySourceFor(body, src) : '',
            steps: body ? extractStepsFrom(body, src) : [],
            ...(annotations.requirements ? { requirements: annotations.requirements } : {}),
            ...(annotations.pathTypes ? { pathTypes: annotations.pathTypes } : {}),
            ...(assertions.length ? { assertions } : {}),
          })
          // Don't double-recurse into the test body — its inner test.step
          // calls are already collected via extractStepsFrom.
          return
        }
      }
      n.forEachChild(visit)
    }
    visit(src)
    return { file, tests }
  } catch (err) {
    return {
      file,
      tests: [],
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}
