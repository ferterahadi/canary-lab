import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  canonicalCodeExpression,
  canonicalExpression,
  canonicalStatement,
} from './canonical-ir'
import { compileSemanticSource } from './semantic-context'

function contextFor(source: string, absoluteSourceRanges = true) {
  return compileSemanticSource('/workspace/canonical.ts', source, { absoluteSourceRanges })
}

function expressions(source: string, absoluteSourceRanges = true) {
  const context = contextFor(source, absoluteSourceRanges)
  const values: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node)) values.push(node)
    node.forEachChild(visit)
  }
  visit(context.sourceFile)
  return { context, values, ir: values.map((node) => canonicalExpression(node, context)) }
}

describe('canonical AST IR', () => {
  it('represents literal, access, call, await, binary, arrow, and generic expressions', () => {
    const { ir } = expressions(`async function scenario() {
  id
  "text"; \`template\`; 1; 2n; /a+/g; true; false; null
  owner.value; owner?.value; owner[key]; owner?.[key]
  fn(); owner.method(1); owner?.method?.(); owner['method'](); owner[key]()
  (fn)(); value!.method(); (await loader()).run(); make()()
  await fn(); left = right; left += right; left + right
  items.map(item => item.id); items.map(item => { return item.id })
  (left); new Service(); (ready ? yes : no)()
}`)
    const kinds = new Set(ir.map((item) => item.kind))
    expect(kinds).toEqual(new Set([
      'identifier',
      'literal',
      'member-access',
      'element-access',
      'call',
      'await',
      'binary',
      'arrow-function',
      'source-expression',
    ]))
    expect(ir.filter((item) => item.kind === 'literal')).toHaveLength(10)
    expect(ir.some((item) => item.kind === 'member-access' && item.optional)).toBe(true)
    expect(ir.some((item) => item.kind === 'element-access' && item.optional)).toBe(true)
    expect(ir.some((item) => item.kind === 'call' && item.optional)).toBe(true)
    expect(ir.some((item) => item.kind === 'call' && item.calleePath.join('.') === 'owner.method')).toBe(true)
    expect(ir.some((item) => item.kind === 'call' && item.calleePath.length === 0)).toBe(true)
    expect(ir.some((item) => item.kind === 'arrow-function' && item.expressionBody)).toBe(true)
    expect(ir.some((item) => item.kind === 'arrow-function' && !item.expressionBody)).toBe(true)
    expect(ir.every((item) => item.sourceRange)).toBe(true)
  })

  it('retains nested parentheses while still recognizing the useful composition', () => {
    const context = contextFor('const value = ((load()))')
    const statement = canonicalStatement(context.sourceFile.statements[0], context)
    expect(statement).toMatchObject({
      kind: 'declaration',
      bindings: [{ initializer: { kind: 'call', code: '((load()))', parenthesizedDepth: 2 } }],
    })
  })

  it('omits virtual ranges while keeping canonical code and type categories', () => {
    const context = contextFor('const value: Result = source', false)
    const statement = canonicalStatement(context.sourceFile.statements[0], context)
    expect(statement.sourceRange).toBeUndefined()
    expect(statement).toMatchObject({
      kind: 'declaration',
      bindings: [{
        binding: { code: 'value' },
        type: { code: 'Result', syntaxCategory: 'type' },
        initializer: { code: 'source' },
      }],
    })
    if (statement.kind !== 'declaration' || !statement.bindings[0].initializer) throw new Error('Expected initializer')
    const declarationStatement = context.sourceFile.statements[0]
    if (!ts.isVariableStatement(declarationStatement)) throw new Error('Expected variable statement')
    expect(canonicalCodeExpression(
      declarationStatement.declarationList.declarations[0].initializer!,
      context,
    )).toEqual(statement.bindings[0].initializer)
  })

  it('canonicalizes every statement shape and declaration kind without wording', () => {
    const context = contextFor(`const a = 1
let b: number
var c
returnValue: {
  value = 2
}
function scenario(flag: boolean) {
  return flag
}
function empty() {
  return
}
function fail(error: Error) {
  throw error
}
if (ready) run()
`)
    const topLevel = context.sourceFile.statements.map((statement) => canonicalStatement(statement, context))
    expect(topLevel.slice(0, 3).map((item) => item.kind === 'declaration' ? item.declarationKind : 'other'))
      .toEqual(['constant', 'variable', 'legacy variable'])
    const allStatements: ts.Statement[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isStatement(node)) allStatements.push(node)
      node.forEachChild(visit)
    }
    visit(context.sourceFile)
    const kinds = new Set(allStatements.map((statement) => canonicalStatement(statement, context).kind))
    expect(kinds).toEqual(new Set([
      'declaration',
      'expression-statement',
      'return',
      'throw',
      'source-statement',
    ]))
    const returns = allStatements
      .filter(ts.isReturnStatement)
      .map((statement) => canonicalStatement(statement, context))
    expect(returns.some((item) => item.kind === 'return' && item.expression)).toBe(true)
    expect(returns.some((item) => item.kind === 'return' && !item.expression)).toBe(true)
  })
})
