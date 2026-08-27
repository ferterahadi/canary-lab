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
      ['account[field]', 'account at field'],
      ['account?.[field]', 'account at field, if available'],
      ['account[left ?? right]', 'account at (left or, when missing, right)'],
      ['{ ...account }', 'an object with everything in account'],
      ['{ id, ...account }', 'an object with identifier, everything in account'],
      ['[...items]', 'a list containing all items of items'],
      ['[1, ...items]', 'a list containing 1, all items of items'],
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

  it('renders calls whose result has one stable meaning', () => {
    const cases: Array<[string, string]> = [
      ['uuidv4()', 'a new unique identifier'],
      ['randomUUID()', 'a new unique identifier'],
      ['crypto.randomUUID()', 'a new unique identifier'],
      ['Date.now()', 'the current time'],
      ['Math.random()', 'a random number'],
      ['expect.anything()', 'anything'],
      ['expect.any(String)', 'any string'],
      ["expect.stringContaining('mail')", 'text containing “mail”'],
      ['expect.stringMatching(/pay/i)', 'text matching /pay/i'],
      ['expect.objectContaining({ id: 1 })', 'an object containing an object with identifier set to 1'],
      ['expect.arrayContaining([1])', 'a list containing a list containing 1'],
      ['JSON.parse(raw)', 'raw parsed as JSON'],
      ['JSON.parse(raw ?? fallback)', '(raw or, when missing, fallback) parsed as JSON'],
      ['JSON.stringify(row)', 'row as JSON text'],
      ['JSON.stringify(row, null, 2)', 'row as JSON text'],
      ['JSON.stringify(row, undefined, 2)', 'row as JSON text'],
      ['Object.keys(account)', 'the keys of account'],
      ['Object.values(account)', 'the values of account'],
      ['Object.entries(account)', 'the entries of account'],
      ['getBaseUrl()', 'the base url'],
      ['findOrder(orderId)', 'the order for order identifier'],
      ['fetchRows(table, limit)', 'the rows for table and limit'],
      ['name.toLowerCase()', 'name in lowercase'],
      ['name.toUpperCase()', 'name in uppercase'],
      ['name.trim()', 'name without surrounding spaces'],
      ['(name ?? fallback).trim()', '(name or, when missing, fallback) without surrounding spaces'],
      ['stamp.getTime()', 'stamp as a timestamp'],
      ['stamp.toISOString()', 'stamp as an ISO timestamp'],
      ['value.toString()', 'value as text'],
      ['res.json()', 'the JSON body of response'],
      ['res.text()', 'the text body of response'],
      ['list.includes(item)', 'list contains item'],
      ['seen.has(key)', 'seen contains key'],
      ["name.startsWith('a')", 'name starts with “a”'],
      ["name.endsWith('z')", 'name ends with “z”'],
      ['!list.includes(item)', 'not (list contains item)'],
      ['new Date()', 'the current time'],
      ['new Date', 'the current time'],
      ['new Date(startedAt)', 'started at as a date'],
      ['() => true', 'a function returning true'],
      ['() => count + 1', 'a function returning count plus 1'],
    ]

    for (const [source, text] of cases) {
      expect(rendered(source)).toEqual({ text, fidelity: 'derived' })
    }
  })

  it('keeps effectful, dynamic, and unsupported expression shapes unresolved', () => {
    const cases: Array<[string, string]> = [
      ['`hello ${computeName()}`', '“hello {computeName()}”'],
      ['[first, computeNext()]', '[first, computeNext()]'],
      ['[...computeItems()]', '[...computeItems()]'],
      ['{ ...computeAccount() }', '{ ...computeAccount() }'],
      ['{ [field]: value }', '{ [field]: value }'],
      ['await computeValue()', 'await computeValue()'],
      ['computeAccount().name', 'computeAccount().name'],
      ["computeAccount()['name']", "computeAccount()['name']"],
      ['account[computeKey()]', 'account[computeKey()]'],
      ['computeAccount()[field]', 'computeAccount()[field]'],
      ['!computeValue()', '!computeValue()'],
      ['++attempt', '++attempt'],
      ['typeof computeValue()', 'typeof computeValue()'],
      ['left = right', 'left = right'],
      ['computeLeft() + right', 'computeLeft() + right'],
      ['left + computeRight()', 'left + computeRight()'],
      ["computeCondition() ? 'yes' : 'no'", "computeCondition() ? 'yes' : 'no'"],
      ["enabled ? computeYes() : 'no'", "enabled ? computeYes() : 'no'"],
      ["enabled ? 'yes' : computeNo()", "enabled ? 'yes' : computeNo()"],
      ['computeValue()', 'computeValue()'],
      ['uuidv4(1)', 'uuidv4(1)'],
      ['expect.any()', 'expect.any()'],
      ['expect.any(computeType())', 'expect.any(computeType())'],
      ['expect.anything(1)', 'expect.anything(1)'],
      ['expect.custom(value)', 'expect.custom(value)'],
      ['JSON.parse()', 'JSON.parse()'],
      ['JSON.parse(computeRaw())', 'JSON.parse(computeRaw())'],
      ['JSON.stringify()', 'JSON.stringify()'],
      ['JSON.stringify(row, replacer)', 'JSON.stringify(row, replacer)'],
      ['JSON.stringify(row, [1])', 'JSON.stringify(row, [1])'],
      ['JSON.stringify(computeRow(), null, 2)', 'JSON.stringify(computeRow(), null, 2)'],
      ['Object.keys()', 'Object.keys()'],
      ['Object.keys(account, extra)', 'Object.keys(account, extra)'],
      ['Object.keys(computeAccount())', 'Object.keys(computeAccount())'],
      ['get()', 'get()'],
      ['getAsync()', 'getAsync()'],
      ['getUrl(computeKey())', 'getUrl(computeKey())'],
      ['name.toLowerCase(1)', 'name.toLowerCase(1)'],
      ['computeName().trim()', 'computeName().trim()'],
      ['list.includes()', 'list.includes()'],
      ['list.includes(computeItem())', 'list.includes(computeItem())'],
      ['computeList().includes(item)', 'computeList().includes(item)'],
      ['new Date(year, month)', 'new Date(year, month)'],
      ['new Date(computeIso())', 'new Date(computeIso())'],
      ['new URL(url)', 'new URL(url)'],
      ['() => computeValue()', '() => computeValue()'],
      ['(value) => value', '(value) => value'],
      ['() => { return 1 }', '() => { return 1 }'],
      ['{ method() { return 1 } }', '{ method() { return 1 } }'],
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
