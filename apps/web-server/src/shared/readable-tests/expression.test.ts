import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { renderCondition, renderExpression } from './expression'

function expressionFrom(source: string): { expression: ts.Expression; sourceFile: ts.SourceFile } {
  const sourceFile = ts.createSourceFile('expression.ts', `const result = ${source}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements[0]
  if (!ts.isVariableStatement(declaration)) throw new Error('Expected a variable statement')
  const expression = declaration.declarationList.declarations[0].initializer
  if (!expression) throw new Error('Expected an initializer')
  return { expression, sourceFile }
}

describe('readable expression rendering', () => {
  it('renders literals, identifiers, templates, lists, and objects without evaluating them', () => {
    const cases: Array<[string, string, string]> = [
      ["'checkout'", '“checkout”', 'exact'],
      ['retryCount', 'retry count', 'derived'],
      ['`/orders/${orderId}`', '“/orders/{order identifier}”', 'derived'],
      ["['SG', 'US']", 'a list containing “SG”, “US”', 'derived'],
      ["{ plan: 'team', retryCount }", 'an object with plan set to “team”, retry count', 'derived'],
    ]

    for (const [source, text, fidelity] of cases) {
      const parsed = expressionFrom(source)
      expect(renderExpression(parsed.expression, parsed.sourceFile)).toEqual({ text, fidelity })
    }
  })

  it('maps boolean and comparison operators literally while preserving grouping', () => {
    const parsed = expressionFrom('enabled && (attempt < 3 || mode === \'manual\')')
    expect(renderCondition(parsed.expression, parsed.sourceFile)).toEqual({
      text: 'enabled and ((attempt is less than 3) or (mode equals “manual”))',
      fidelity: 'derived',
    })

    const negated = expressionFrom('!item.enabled')
    expect(renderCondition(negated.expression, negated.sourceFile)).toEqual({
      text: 'not item enabled',
      fidelity: 'derived',
    })
  })

  it('returns exact source for effectful or unsupported expressions', () => {
    const call = expressionFrom("await page.getByText('Continue').isVisible()")
    expect(renderCondition(call.expression, call.sourceFile)).toEqual({
      text: "await page.getByText('Continue').isVisible()",
      fidelity: 'unresolved',
    })

    const assignment = expressionFrom('attempt += 1')
    expect(renderExpression(assignment.expression, assignment.sourceFile)).toEqual({
      text: 'attempt += 1',
      fidelity: 'unresolved',
    })
  })
})
