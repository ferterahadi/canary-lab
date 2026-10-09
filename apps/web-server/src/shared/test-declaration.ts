import ts from 'typescript'

export const TEST_DECLARATORS: ReadonlySet<string> = new Set(['test', 'it'])

export function getCalleeChain(expr: ts.Expression): string[] {
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
export function declarationModifier(call: ts.CallExpression): TestModifier | undefined {
  const tail = getCalleeChain(call.expression)[1] ?? ''
  return isTestModifier(tail) ? tail : undefined
}

export function isTestCall(call: ts.CallExpression): boolean {
  // Match the test declaration forms — `test(...)` and its `it` spelling — but not
  // hooks/configuration methods such as test.beforeEach(), test.use(), or
  // test.setTimeout(). A titled hook also carries a string + callback, so argument
  // shape alone cannot distinguish it from a test.
  const [root, modifier, ...rest] = getCalleeChain(call.expression)
  if (root === undefined || !TEST_DECLARATORS.has(root)) return false
  if (modifier === undefined) return true
  return rest.length === 0 && isTestModifier(modifier)
}


export function testFunctionBody(node: ts.CallExpression): ts.ConciseBody | undefined {
  // Playwright accepts both test(title, body) and test(title, details, body),
  // where the 3-arg form carries a { tag, annotation } object — exactly what the
  // coverage annotator (tag-writer.ts) inserts after the title. That shifts the
  // callback to the last argument, so scan from the end rather than assuming
  // arguments[1], or every tag-annotated test reads as "Source unavailable".
  for (let i = node.arguments.length - 1; i >= 1; i -= 1) {
    const arg = node.arguments[i]
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg.body
  }
  return undefined
}
