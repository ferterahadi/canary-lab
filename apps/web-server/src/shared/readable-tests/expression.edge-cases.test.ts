import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { renderExpression } from './expression'

function expressionFrom(source: string): { expression: ts.Expression; sourceFile: ts.SourceFile } {
  const sourceFile = ts.createSourceFile('expression.ts', `const result = ${source}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const statement = sourceFile.statements[0]
  if (!ts.isVariableStatement(statement)) throw new Error('Expected a variable statement')
  const expression = statement.declarationList.declarations[0].initializer
  if (!expression) throw new Error('Expected an initializer')
  return { expression, sourceFile }
}

function rendered(source: string) {
  const parsed = expressionFrom(source)
  return renderExpression(parsed.expression, parsed.sourceFile)
}

describe('readable expression edge cases', () => {
  it('renders every literal and transparent TypeScript wrapper', () => {
    const cases: Array<[string, string, 'exact' | 'derived']> = [
      ['42', '42', 'exact'],
      ['/pay/i', '/pay/i', 'exact'],
      ['true', 'true', 'exact'],
      ['false', 'false', 'exact'],
      ['null', 'null', 'exact'],
      ['undefined', 'undefined', 'exact'],
      ['``', '“”', 'exact'],
      ["'left “quoted” right'", '“left \\“quoted\\” right”', 'exact'],
      ['(retryCount)', 'retry count', 'derived'],
      ['retryCount as number', 'retry count', 'derived'],
      ['<number>retryCount', 'retry count', 'derived'],
      ['retryCount!', 'retry count', 'derived'],
      ['retryCount satisfies number', 'retry count', 'derived'],
      ['await retryCount', 'retry count', 'derived'],
    ]

    for (const [source, text, fidelity] of cases) {
      expect(rendered(source)).toEqual({ text, fidelity })
    }
  })

  it('renders safe templates, collections, property access, and conditional values', () => {
    const cases: Array<[string, string]> = [
      ['`hello ${name}`', '“hello {name}”'],
      ['[]', 'an empty list'],
      ['{}', 'an empty object'],
      ["{ 'plan-name': 'team', 2: true, retryCount }", 'an object with plan-name set to “team”, 2 set to true, retry count'],
      ['account.name', 'account name'],
      ['account?.name', 'account name, if available'],
      ["account['name']", 'account name'],
      ['account?.[2]', 'account 2, if available'],
      ["enabled ? 'yes' : 'no'", '“yes” when enabled; otherwise “no”'],
    ]

    for (const [source, text] of cases) {
      expect(rendered(source)).toEqual({ text, fidelity: 'derived' })
    }
  })

  it('renders every supported unary and binary operator literally', () => {
    const unaryCases: Array<[string, string]> = [
      ['!enabled', 'not enabled'],
      ['+count', 'positive count'],
      ['-count', 'negative count'],
      ['~mask', 'bitwise not mask'],
      ['typeof value', 'the type of value'],
    ]
    for (const [source, text] of unaryCases) {
      expect(rendered(source)).toEqual({ text, fidelity: 'derived' })
    }

    const binaryCases: Array<[string, string]> = [
      ['left == right', 'left equals right'],
      ['left === right', 'left equals right'],
      ['left != right', 'left does not equal right'],
      ['left !== right', 'left does not equal right'],
      ['left < right', 'left is less than right'],
      ['left <= right', 'left is at most right'],
      ['left > right', 'left is greater than right'],
      ['left >= right', 'left is at least right'],
      ['left && right', 'left and right'],
      ['left || right', 'left or right'],
      ['left ?? right', 'left or, when missing, right'],
      ['left + right', 'left plus right'],
      ['left - right', 'left minus right'],
      ['left * right', 'left multiplied by right'],
      ['left / right', 'left divided by right'],
      ['left % right', 'left modulo right'],
      ['left ** right', 'left raised to right'],
      ["'name' in account", '“name” is in account'],
      ['value instanceof Type', 'value is an instance of type'],
    ]
    for (const [source, text] of binaryCases) {
      expect(rendered(source)).toEqual({ text, fidelity: 'derived' })
    }
  })

  it('keeps effectful, dynamic, and unsupported expression shapes unresolved', () => {
    const cases: Array<[string, string]> = [
      ['`hello ${loadName()}`', '“hello {loadName()}”'],
      ['[first, loadNext()]', '[first, loadNext()]'],
      ['{ ...account }', '{ ...account }'],
      ['{ [field]: value }', '{ [field]: value }'],
      ['await loadValue()', 'await loadValue()'],
      ['loadAccount().name', 'loadAccount().name'],
      ["loadAccount()['name']", "loadAccount()['name']"],
      ['account[field]', 'account[field]'],
      ['!loadValue()', '!loadValue()'],
      ['++attempt', '++attempt'],
      ['typeof loadValue()', 'typeof loadValue()'],
      ['left = right', 'left = right'],
      ['loadLeft() + right', 'loadLeft() + right'],
      ['left + loadRight()', 'left + loadRight()'],
      ["loadCondition() ? 'yes' : 'no'", "loadCondition() ? 'yes' : 'no'"],
      ["enabled ? loadYes() : 'no'", "enabled ? loadYes() : 'no'"],
      ["enabled ? 'yes' : loadNo()", "enabled ? 'yes' : loadNo()"],
      ['loadValue()', 'loadValue()'],
    ]

    for (const [source, text] of cases) {
      expect(rendered(source)).toEqual({ text, fidelity: 'unresolved' })
    }
  })

  it('handles the private-identifier property shape conservatively', () => {
    const sourceFile = ts.createSourceFile('synthetic.ts', '', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const expression = ts.factory.createObjectLiteralExpression([
      ts.factory.createPropertyAssignment(ts.factory.createPrivateIdentifier('#secret'), ts.factory.createNumericLiteral(1)),
    ])

    expect(renderExpression(expression, sourceFile)).toEqual({
      text: 'an object with #secret set to 1',
      fidelity: 'derived',
    })
  })
})
