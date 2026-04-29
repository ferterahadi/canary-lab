import ts from 'typescript'

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
  steps: ExtractedStep[]
}

export interface ExtractResult {
  file: string
  tests: ExtractedTest[]
  parseError?: string
}

function getStringArg(node: ts.CallExpression): string | null {
  const arg = node.arguments[0]
  if (!arg) return null
  if (ts.isStringLiteralLike(arg)) return arg.text
  if (ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text
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
  // Match `test(...)`, `test.only(...)`, `test.skip(...)` — but NOT `test.step(...)`.
  const chain = getCalleeChain(call.expression)
  if (chain.length === 0 || chain[0] !== 'test') return false
  if (chain.length === 1) return true
  // test.only, test.skip, test.fixme, test.fail are still tests; test.step is not.
  if (chain[1] === 'step') return false
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

function bodySourceFor(node: ts.Node, src: ts.SourceFile): string {
  return src.getFullText().slice(node.getStart(src), node.getEnd()).trim()
}

function lineFor(node: ts.Node, src: ts.SourceFile): number {
  const { line } = src.getLineAndCharacterOfPosition(node.getStart(src))
  return line + 1
}

function extractStepsFrom(node: ts.Node, src: ts.SourceFile): ExtractedStep[] {
  const out: ExtractedStep[] = []
  function visit(n: ts.Node, collector: ExtractedStep[]): void {
    if (ts.isCallExpression(n) && isTestStepCall(n)) {
      const label = getStringArg(n)
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
        const name = getStringArg(n)
        if (name !== null) {
          const body = getStepBody(n)
          tests.push({
            name,
            line: lineFor(n, src),
            steps: body ? extractStepsFrom(body, src) : [],
          })
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
