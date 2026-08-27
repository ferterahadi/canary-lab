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
      ['Array.isArray(payload.items)', 'payload items is a list'],
      ['encodeURI(target)', 'target encoded for a URL'],
      ['decodeURI(target)', 'target decoded from a URL'],
      ['encodeURIComponent(senderId)', 'sender identifier encoded for a URL component'],
      ['decodeURIComponent(senderId)', 'sender identifier decoded from a URL component'],
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
      ['Date.now().toString(36)', 'the current time as base 36 text'],
      ['value.slice(2)', 'value sliced from 2'],
      ['Math.random().toString(16).slice(2, 8)', 'a random number as base 16 text sliced from 2 to 8'],
      ['res.json()', 'the JSON body of response'],
      ['res.text()', 'the text body of response'],
      ['res.status()', 'response status'],
      ['res.url()', 'response URL'],
      ['res.ok()', 'whether response is successful'],
      ['list.includes(item)', 'list contains item'],
      ['seen.has(key)', 'seen contains key'],
      ["name.startsWith('a')", 'name starts with “a”'],
      ["name.endsWith('z')", 'name ends with “z”'],
      ["items.every((entry) => entry.status === 'READY')", 'for every item in items, item status equals “READY”'],
      ['items.every((entry, index) => index > 0)', 'for every item in items, item index is greater than 0'],
      ["items.some((entry) => entry.tags.includes('urgent'))", 'for at least one item in items, item tags contains “urgent”'],
      ["items.find((entry) => entry.status === 'READY')", 'the first item in items where item status equals “READY”'],
      ['items.some(function (entry) { return (entry as Row).id === targetId })', 'for at least one item in items, item identifier equals targetId'],
      ['items.map((entry) => entry.id)', 'items transformed so each item becomes item identifier'],
      ['items.map((entry, index) => entry.id + index)', 'items transformed so each item becomes item identifier plus item index'],
      ['items.flatMap((entry) => entry.children)', 'items transformed and flattened so each item becomes item children'],
      ['items.filter((entry) => entry.ready)', 'items filtered to keep each item where item ready'],
      ['items.filter((entry, index, source) => entry.ready && index < source.length)', 'items filtered to keep each item where item ready and (item index is less than collection length)'],
      ["items.findIndex((entry) => entry.status === 'READY')", 'the index of the first item in items where item status equals “READY”'],
      ['records.reduce((s, r) => s + r.count, 0)', "the sum of each item's count in records"],
      ['items.reduce((total, item) => total + item, 0)', 'the sum of each item in items'],
      ['items.reduce((total, entry, index, source) => total + entry.amount + index + source.length, 0)', "the result of combining items, starting with 0 and updating the running value for each item to ((the running value plus that item's amount) plus that item's index) plus the collection's length"],
      ['items.reduce((total, entry) => total + entry.amount)', "the result of combining items, starting with the first item and updating the running value for each remaining item to the running value plus that item's amount"],
      ['items.sort()', 'items sorted using default ordering'],
      ['items.toSorted((left, right) => left.rank - right.rank)', 'items sorted by comparing left item rank minus right item rank'],
      ["items.join('|')", 'items joined with “|”'],
      ['items.join()', 'items joined with “,”'],
      ["value.split(':', 2)", 'value split using “:”, limited to 2 items'],
      ["value.split(':')", 'value split using “:”'],
      ['value.split()', 'value placed in a one-item list'],
      ["value.replace('-', '_')", 'value with the first match for “-” replaced by “_”'],
      ["value.replaceAll('-', '_')", 'value with every match for “-” replaced by “_”'],
      ['items.concat(moreItems, finalItem)', 'items combined with more items and final item'],
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
      ['computeValue().toString(16)', 'computeValue().toString(16)'],
      ['value.toString(computeRadix())', 'value.toString(computeRadix())'],
      ['value.toString(16, extra)', 'value.toString(16, extra)'],
      ['computeValue().slice(1)', 'computeValue().slice(1)'],
      ['value.slice(computeStart())', 'value.slice(computeStart())'],
      ['value.slice()', 'value.slice()'],
      ['value.slice(1, 2, 3)', 'value.slice(1, 2, 3)'],
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
      ['encodeURIComponent()', 'encodeURIComponent()'],
      ['encodeURIComponent(senderId, extra)', 'encodeURIComponent(senderId, extra)'],
      ['encodeURIComponent(computeSenderId())', 'encodeURIComponent(computeSenderId())'],
      ['get()', 'get()'],
      ['getAsync()', 'getAsync()'],
      ['getUrl(computeKey())', 'getUrl(computeKey())'],
      ['name.toLowerCase(1)', 'name.toLowerCase(1)'],
      ['computeName().trim()', 'computeName().trim()'],
      ['list.includes()', 'list.includes()'],
      ['list.includes(computeItem())', 'list.includes(computeItem())'],
      ['computeList().includes(item)', 'computeList().includes(item)'],
      ['items.every(predicate)', 'items.every(predicate)'],
      ['items.find(predicate)', 'items.find(predicate)'],
      ['items.filter(predicate)', 'items.filter(predicate)'],
      ['items.map()', 'items.map()'],
      ['items.map((item) => item, context)', 'items.map((item) => item, context)'],
      ['items.reduce((total) => total, 0)', 'items.reduce((total) => total, 0)'],
      ['items.reduce((total, item) => inspect(item), 0)', 'items.reduce((total, item) => inspect(item), 0)'],
      ['items.reduce((total, item) => total + inspect(item), 0)', 'items.reduce((total, item) => total + inspect(item), 0)'],
      ['items.reduce((total, item) => total, computeInitial())', 'items.reduce((total, item) => total, computeInitial())'],
      ['items.reduce((total, item) => total, 0, extra)', 'items.reduce((total, item) => total, 0, extra)'],
      ['items.sort(compare)', 'items.sort(compare)'],
      ['items.sort((left, right) => left.rank - right.rank, extra)', 'items.sort((left, right) => left.rank - right.rank, extra)'],
      ['items.sort((left) => left.rank)', 'items.sort((left) => left.rank)'],
      ['items.sort((left, right) => compare(left, right))', 'items.sort((left, right) => compare(left, right))'],
      ['items.join(separator())', 'items.join(separator())'],
      ['items.join(a, b)', 'items.join(a, b)'],
      ['value.split(separator())', 'value.split(separator())'],
      ['value.split(a, b, c)', 'value.split(a, b, c)'],
      ["value.replace('-', computeReplacement())", "value.replace('-', computeReplacement())"],
      ["value.replace('-')", "value.replace('-')"],
      ['items.concat()', 'items.concat()'],
      ['items.concat(computeItems())', 'items.concat(computeItems())'],
      ['items.every((predicate))', 'items.every((predicate))'],
      ['items.every()', 'items.every()'],
      ['items.every((item) => item.ready, context)', 'items.every((item) => item.ready, context)'],
      ['computeItems().every((item) => item.ready)', 'computeItems().every((item) => item.ready)'],
      ['items.every((item) => computeReady(item))', 'items.every((item) => computeReady(item))'],
      ['items.every(async (item) => item.ready)', 'items.every(async (item) => item.ready)'],
      ['items.every(function* (item) { return item.ready })', 'items.every(function* (item) { return item.ready })'],
      ['items.every(() => true)', 'items.every(() => true)'],
      ['items.every(({ ready }) => ready)', 'items.every(({ ready }) => ready)'],
      ['items.every((item = fallback) => item.ready)', 'items.every((item = fallback) => item.ready)'],
      ['items.every((...item) => item.length > 0)', 'items.every((...item) => item.length > 0)'],
      ['items.every((item) => { inspect(item); return item.ready })', 'items.every((item) => { inspect(item); return item.ready })'],
      ['items.every((item) => { inspect(item) })', 'items.every((item) => { inspect(item) })'],
      ['items.every((item) => { return })', 'items.every((item) => { return })'],
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
