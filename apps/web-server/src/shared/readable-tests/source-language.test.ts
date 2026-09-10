import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { ReadableStoryItem } from '../../../../../shared/readable-tests/types'
import { translateReadableSource } from './translator'
import { VOCABULARY } from '../controlled-english/vocabulary'
import { parseSource } from '../controlled-english/compiler-context'
import { compileSemanticSource } from '../controlled-english/semantic-context'
import * as syntaxEnglish from '../controlled-english/ast-to-ir'
import { storyCandidates } from './story'
import { sourceExpressionText, sourceStatementText, testRegistration } from './source-language'

function rows(source: string, file = 'review.spec.ts'): ReadableStoryItem[] {
  const flatten = (items: ReadableStoryItem[]): ReadableStoryItem[] => items.flatMap((item) => [item, ...(item.kind === 'flow' ? flatten(item.children) : [])])
  return flatten(translateReadableSource(file, source).steps)
}
const english = (source: string, file?: string): string => rows(source, file).map((item) => item.text).join('\n')

describe('whole-file English', () => {
  it.each(['id', 'newId'])('renders the reported nested polling callback as prose while preserving %s and the second argument', (id) => {
    const source = `await poll(async () => (await allMessages(request)).messages.find((message: any) => message.messageId === ${id}), 60_000)`
    const item = rows(source)[0]
    expect(item.text).toBe(`Call poll and wait for it to finish. Pass these arguments in order:\n1. an asynchronous arrow function with no parameters that returns the result of find on (messages from (the awaited result of allMessages with request)) with (an arrow function receiving message of type any that returns whether message.messageId is strictly equal to ${id})\n2. 60_000`)
    expect(item.source.snippet).toBe(source)
    expect(item.spans.map((span) => span.text).join('')).toBe(item.text)
    expect(item.text).not.toMatch(/await:|call:|property `|with arguments:|returning:/)
  })

  it('explains conditional spread lists in order and records the complete loop header range', () => {
    const source = `for (const gap of [
  ...(channel === 'line' ? [{ ids: '@req-R18', name: 'signed inbound' }, { ids: '@req-R19', name: 'one message' }] : []),
  ...(channel === 'line' ? [{ ids: '@req-R31 @req-R32', name: 'authenticated envelope' }] : []),
  ...(channel === 'line' ? [{ ids: '@req-R25', name: 'valid reply' }] : [])
]) {
  test(gap.name, () => { expect(ready).toBe(true) })
}`
    const loop = translateReadableSource('review.spec.ts', source).steps[0]
    expect(loop).toMatchObject({ kind: 'flow', headerEndLine: 5 })
    expect(loop.text.startsWith('Build this list in order, then process each item as constant gap:\n1. If channel is strictly equal to "line", include all items from')).toBe(true)
    expect(loop.text).toContain('\n2. If channel')
    expect(loop.text).toContain('\n3. If channel')
    expect(loop.text.match(/otherwise include no items/g)).toHaveLength(3)
    for (const value of ['@req-R18', '@req-R19', '@req-R31 @req-R32', '@req-R25', 'signed inbound', 'one message', 'authenticated envelope', 'valid reply']) expect(loop.text).toContain(value)
    expect(loop.text).not.toMatch(/array literal|object literal|spread of|then yield|group of/)
    expect(rows(source).some((item) => item.source.startLine === 6)).toBe(true)
  })

  it.each([
    ['const collected = [...first.messages]', 'Set constant collected to a list containing all items from first.messages'],
    ['collected.push(...page.messages)', 'Call collected.push with each item from page.messages as a separate argument'],
    ['const combined = { ...base, value: 1, ...override }', 'all properties copied from base; value set to 1; all properties copied from override'],
    ['const keyed = { [key()]: value }', 'the property named by (the result of key()) set to value'],
    ['const sparse = [first, , ...tail]', 'a list containing first, an empty slot, all items from tail'],
    ['for await (let item of [...stream, one, , ...(ready ? primary : fallback)]) { consume(item) }', 'awaiting each item'],
    ['for (var item of [...stream]) { consume(item) }', 'process each item as function-scoped variable item'],
    ['this.api.send(value)', 'Call this.api.send with value'],
    ['super.send(value)', 'Call super.send with value'],
    ['(await build()).send(value)', 'Call send on ((the awaited result of build())) with value'],
    ['use(value => value + 1)', '1. an arrow function receiving value that returns value plus 1'],
    ['await complete', 'Wait for complete'],
    ['await optional?.()', 'optional'],
  ])('keeps related nesting readable and explicit: %s', (source, expected) => {
    expect(english(source)).toContain(expected)
  })

  it('distinguishes spread inclusion, callback invocation and call modifiers', () => {
    const variants = [
      'use(() => work())', 'use(() => { return work() })', 'use(function () { return work() })',
      'use(...values)', 'use(values)', 'use([...values])', 'use([values])',
      'use?.(value => value)', 'use<Type>(value => value)', 'use(value => value)',
    ].map((source) => english(source))
    expect(new Set(variants).size).toBe(variants.length)
    const mixed = english('for (const item of [...stream, one, , ...(ready ? primary : fallback)]) { consume(item) }')
    expect(mixed).toContain('1. Include all items from stream.')
    expect(mixed).toContain('2. Include one.')
    expect(mixed).toContain('3. Leave an empty slot.')
    expect(mixed).toContain('4. If ready is truthy, include all items from primary; otherwise include all items from fallback.')
  })

  it('keeps block callbacks readable without presenting their bodies as immediate execution', () => {
    const source = `await poll(async () => {
  const data = await allMessages(request)
  if (!data) return null
  if (data.ready) { expect(data.count).toBe(1); return true } else return false
}, 90_000)`
    const text = english(source)
    expect(text).toContain('Call poll and wait for it to finish. Pass these arguments in order:')
    expect(text).toContain('an asynchronous arrow function with no parameters that runs these statements when called:')
    expect(text).toContain('  Set constant data to the awaited result of allMessages with request')
    expect(text).toContain('  If data is falsy:\n    Return null')
    expect(text).toContain('  If data.ready is truthy:\n    Check that data.count equals 1\n    Return true\n  Else:\n    Return false')
    expect(text).toContain('\n2. 90_000')
    expect(english('run(() => {})')).toContain('Do nothing.')
    expect(english('run(() => { debugger; })')).toContain('debugger')
    expect(rows(source)[0].source.snippet).toBe(source)
  })

  it('reads helper functions as a signature followed by source-linked statements', () => {
    const source = [
      'async function approvedConversation(request: any) {',
      '  const response = await request.get(`${baseUrl}/v4/whatsapp/conversations`, { headers: existingHeaders, params: scope })',
      '  expect(response.status(), "The configured app must list its inbox").toBe(200)',
      '  const rows = unwrap(await response.json())',
      '  expect(Array.isArray(rows)).toBe(true)',
      '  const row = rows.find((value: any) => normalizePhone(value.guestAddress) === normalizePhone(approvedRecipient))',
      '  test.skip(!row, "No existing conversation")',
      '  expect(row.entityId).toBe(entityId)',
      '  expect(row.entityType).toBe(entityType)',
      '  return row',
      '}',
    ].join('\n')
    const story = translateReadableSource('review.spec.ts', source).steps[0]
    expect(story.text).toBe('Define asynchronous function approvedConversation, taking request of type any')
    expect(story.kind).toBe('flow')
    if (story.kind !== 'flow') throw new Error('Expected the helper body to have separate source rows')
    expect(story.children.map((item) => item.source.startLine)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(story.children.filter((item) => item.role === 'check').map((item) => item.text)).toEqual([
      'Check that the result of response.status() equals 200; with failure message "The configured app must list its inbox"',
      'Check that the result of Array.isArray with rows equals true',
      'Check that row.entityId equals entityId',
      'Check that row.entityType equals entityType',
    ])
    expect(story.children[0].text).toContain('request.get with (text formed by joining baseUrl, "/v4/whatsapp/conversations"), (an object with headers set to existingHeaders; params set to scope)')
    expect(story.children[4].text).toContain('value of type any')
    expect(story.children[4].text).toContain('is strictly equal to')
    expect(story.children[4].text).toContain('(the result of normalizePhone with value.guestAddress) is strictly equal to (the result of normalizePhone with approvedRecipient)')
    expect(story.children[8].text).toBe('Return row')
    for (const item of story.children) {
      expect(item.source.snippet).toBe(source.split('\n')[item.source.startLine - 1].trim())
      expect(item.spans.map((span) => span.text).join('')).toBe(item.text)
    }
  })

  it.each([
    ['function empty() {}', 'Define function empty with no parameters'],
    ['function* values(): Iterable<number> { yield 1 }', 'Define generator function values with no parameters, with return type'],
    ['export async function load<T extends Item>(value: T): Promise<T> { return value }', 'with type parameters'],
    ['export default function () { return 1 }', 'default function'],
    ['declare function load(value: string): number;', 'with no body'],
    ['function load(): void;', 'Define function load with no parameters, with return type void, with no body'],
    ['function outer() { function inner({x}, ...rest) { return x }; return inner }', 'Define function inner, taking an object with properties x; rest parameter'],
  ])('keeps function contracts while separating their bodies: %s', (source, expected) => {
    const items = rows(source)
    expect(items[0].kind).toBe('flow')
    expect(english(source)).toContain(expected)
    expect(items[0].text).not.toContain('body:')
  })

  it('translates the reported imports, declarations, hook, generated tests and conditional actions', () => {
    const source = `import { test, expect } from '@playwright/test'
import fs from 'node:fs'
let statePath: string
const text = 'hello'
test.beforeAll(() => {
  statePath = fixtureStatePath('delivery-evidence')
})
for (const variant of ['missing template', 'empty template']) {
  test('refuses the variant', async ({ request }) => {
    if (!state.messageId) {
      await request.post('/send')
    } else {
      expect(state.messageId).toBeDefined()
    }
  })
}`
    const items = rows(source)
    const text = items.map((item) => item.text).join('\n')
    expect(text).toContain('Import test, expect from "@playwright/test"')
    expect(text).toContain('Import the default export as fs from "node:fs"')
    expect(text).toContain('Declare variable statePath of type string without an initial value')
    expect(text).toContain('Set constant text to "hello"')
    expect(text).toContain('Before all tests')
    expect(text).toContain('bind constant variant')
    expect(text).toContain('Test: "refuses the variant"')
    expect(text).toContain('If state.messageId is falsy')
    expect(text).toContain('Else')
    expect(text).not.toContain('When the condition')
    expect(items.some((item) => item.kind === 'flow' && item.flowKind === 'then')).toBe(false)
    expect(items.find((item) => item.source.startLine === 4)?.spans).toEqual(expect.arrayContaining([
      { text: 'text', kind: 'variable' }, { text: '"hello"', kind: 'literal' },
    ]))
    for (const line of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 13]) expect(items.some((item) => item.source.startLine === line)).toBe(true)
    for (const item of items) {
      expect(item.spans.map((span) => span.text).join('')).toBe(item.text)
      expect(item.source.file).toBe('review.spec.ts')
      expect(item.source.snippet.length).toBeGreaterThan(0)
    }
  })

  it.each(['beforeAll', 'beforeEach', 'afterAll', 'afterEach'])('explains Jest and Playwright %s hooks', (name) => {
    const label = { beforeAll: 'Before all tests', beforeEach: 'Before each test', afterAll: 'After all tests', afterEach: 'After each test' }[name]!
    expect(english(`${name}(() => { setup() }, 5000)`)).toContain(`${label}: 5000`)
    expect(english(`import { test } from '@playwright/test'; test.${name}(() => { setup() })`)).toContain(label)
  })

  it('handles import aliases, namespace imports, parameterized modifiers and tagged tables', () => {
    expect(english(`import { test as check } from '@jest/globals'; check.concurrent.each([[1, 2]])('adds', (a, b) => { expect(a).toBe(b) })`))
      .toContain('Test: "adds"; (concurrent); for each case in')
    expect(english(`import * as spec from 'vitest'; spec.describe.only('group', () => { spec.test('case', () => {}) })`)).toContain('Test group: "group"; (only)')
    expect(english('test.each`a | b\n${1} | ${2}`("adds", ({a, b}) => { expect(a).toBe(b) })')).toContain('for each case in text formed by joining "a | b\\n", 1, " | ", 2')
    expect(english(`import { test as check } from './fixture'; check.beforeEach(() => {})`)).toContain('Before each test')
  })

  it('keeps shadowed names and unknown modifiers as literal calls', () => {
    const text = english(`function beforeAll(cb) { cb() }; beforeAll(() => { work() }); test.custom(() => { work() })`)
    expect(text).not.toContain('Before all tests')
    expect(text).not.toContain('Test:')
    expect(text).toContain('Call test.custom')
    expect(text).toContain('Call work with no arguments')
  })

  it.each([
    ['const value = 1', 'constant value'], ['let value = 1', 'variable value'], ['var value = 1', 'function-scoped variable value'],
    ['import type { Item } from "./types"', 'Import types Item'], ['import * as fs from "node:fs"', 'all exports as fs'],
    ['import "./setup"', 'for its side effects'], ['import { type Item, value as renamed } from "./types"', 'type Item, value as renamed'],
    ['const { value = 2, ...rest } = data', 'object pattern'], ['const values = [1, 2]', 'a list containing 1, 2'],
    ['const empty = []', 'an empty list'], ['const sum = a + b * c', '(b multiplied by c)'],
    ['const data = await load(1)', 'awaited result'], ['let value!: number', 'definitely assigned'],
    ['using resource = acquire()', 'disposable constant'], ['export const value = 1', 'export'],
    ['const fn = (value: number) => value * 2', 'arrow function'],
    ['class Example { value = 1; get current() { return this.value } }', 'class'],
    ['interface Item { value: string }', 'interface'], ['type Item<T> = T | null', 'type'],
    ['enum Mode { Ready, Done }', 'enum'], ['namespace Scope { export const value = 1 }', 'namespace'],
    ['export { value as renamed }', 'export'], ['export default value', 'default'],
    ['import data from "./data.json" with { type: "json" }', 'attributes'],
    ['const view = <div title="hello">world</div>', 'JSX'],
  ])('retains a readable representation for %s', (source, expected) => {
    expect(english(source, 'review.spec.tsx').toLowerCase()).toContain(expected.toLowerCase())
  })

  it.each([
    ['if (a === b) { act() }', 'strictly equal'], ['if (a == b) { act() }', 'loosely equal'],
    ['for (;;) { break }', 'for loop'], ['for (const key in record) { use(key) }', 'For each enumerable property key'],
    ['while (ready) { act() }', 'While'], ['do { act() } while (ready)', 'Run once'],
    ['try { act() } catch (error) { recover(error) } finally { cleanup() }', 'Whether the attempt'],
    ['switch (mode) { case 1: act(); break; default: stop() }', 'Choose a path'],
    ['if (ready) {}', 'if'], ['function* values() { yield 1 }', 'generator'],
  ])('keeps control flow for %s', (source, expected) => {
    expect(english(source).toLowerCase()).toContain(expected.toLowerCase())
  })

  it('never executes source while translating it', () => {
    const before = process.env.CANARY_TRANSLATION_SENTINEL
    expect(english(`process.env.CANARY_TRANSLATION_SENTINEL = 'executed'`)).not.toBe('')
    expect(process.env.CANARY_TRANSLATION_SENTINEL).toBe(before)
  })

  it.each(VOCABULARY.map((entry) => [entry.syntaxKind, entry] as const))('keeps every vocabulary example represented in file review: %s', (_kind, entry) => {
    const file = entry.exampleFile ?? 'example.ts'
    const first = rows(entry.exampleSource, file)
    expect(rows(entry.exampleSource, file)).toEqual(first)
    const { sourceFile } = parseSource(file, entry.exampleSource)
    for (const statement of sourceFile.statements) {
      const line = sourceFile.getLineAndCharacterOfPosition(statement.getStart()).line + 1
      expect(first.some((item) => item.source.startLine <= line && item.source.endLine >= line), entry.syntaxKind).toBe(true)
    }
  })

  it.each([
    ['const result = save(format(value, null, 2), options)', 'const result = save(format(value), null, 2, options)'],
    ['const result = { outer: { a: 1, b: 2 } }', 'const result = { outer: { a: 1 }, b: 2 }'],
    ['const result = collect([1, 2], 3)', 'const result = collect(1, [2, 3])'],
    ['const result = (await load()).value', 'const result = await load().value'],
    ['const result = a + b * c', 'const result = (a + b) * c'],
    ['const a = 1, b = 2', 'const a = 1; const b = 2'],
  ])('keeps nesting and evaluation distinct: %s', (left, right) => {
    expect(english(left)).not.toBe(english(right))
  })

  it('preserves concise functions, defaults, return types and nested values', () => {
    const text = english(`const empty = {};
const a = async (value: number): Promise<number> => value;
const b = ({value}, ...rest) => [value, rest];
const c = (value = 1) => value;
const negative = !ready;
const result = (a + b) * (c + d);
const nested = { a: { value }, list: [1, 2] };
import {} from './setup';`)
    expect(text).toContain('an empty object')
    expect(text).toContain('an asynchronous arrow function receiving value of type number with return type')
    expect(text).toContain('rest parameter')
    expect(text).toContain('with default number 1')
    expect(text).toContain('not (ready)')
    expect(text).toContain('Import no bindings from "./setup"')
    expect(text).toContain('shorthand property value')
  })

  it('preserves loop bindings, async iteration, conditional actions and return values', () => {
    const text = english(`for (let item of items) { consume(item) }
for (var key in items) { consume(key) }
for await (const item of stream) { consume(item) }
ready ? usePrimary() : useFallback();
test('result', () => { if (!ready) return; return load() });
test.beforeAll(() => { throw new Error('setup failed') });`)
    expect(text).toContain('bind variable item')
    expect(text).toContain('bind function-scoped variable key')
    expect(text).toContain('awaiting each value')
    expect(text).toContain('If ready is truthy')
    expect(text).toContain('Return without a value')
    expect(text).toContain('Return the result of load()')
    expect(text).toContain('Throw construct')
    expect(translateReadableSource('empty.ts', '')).toEqual({ steps: [] })
  })

  it.each([
    `test?.('case', () => {})`, `test?.beforeAll(() => {})`, `test<Type>('case', () => {})`,
    `test.each<Type>([1])('case', () => {})`, `test.each?.([1])('case', () => {})`,
    `(test)('case', () => {})`, `test.setup([1])('case', () => {})`,
    `test('case', function named() {})`, `test('case', function* () { yield 1 })`,
    `test('case', <T>(value: T) => value)`, `test('case', () => {}, () => {})`,
    `test([1])('case', () => {})`,
    `test.skip(({browserName}) => browserName === 'webkit', 'unsupported')`,
    `const beforeEach = (fn) => fn(); beforeEach(() => {})`,
  ])('retains literal syntax for registration shapes whose contract is not recognized: %s', (source) => {
    const context = compileSemanticSource('example.ts', source)
    expect(testRegistration(context.sourceFile.statements.at(-1)!, context)).toBeUndefined()
    expect(english(source)).not.toBe('')
  })

  it('keeps typed callback returns and optional call syntax', () => {
    expect(english(`test('case', (done): void => { done() })`)).toContain('returning type void')
    const context = compileSemanticSource('example.ts', `handler?.();`)
    expect(sourceStatementText(context.sourceFile.statements[0])).toContain('optional')
    const defaults = parseSource('defaults.js', '({ value = 1 } = data)').sourceFile.statements[0] as ts.ExpressionStatement
    const assignment = (defaults.expression as ts.ParenthesizedExpression).expression as ts.BinaryExpression
    expect(sourceExpressionText(assignment.left)).toContain('shorthand property value defaulting to 1')
  })

  it('keeps zero-argument functions, tuple parameters, typed iteration and binary evaluation', () => {
    const text = english(`const getValue = () => 1;
const destructure = ([first, second]) => first;
const ordered = a + b + c;
const assigned = (value = 2);
for (const [key, value] of entries) { consume(key, value) }`)
    expect(text).toContain('arrow function with no parameters that returns 1')
    expect(text).toContain('array pattern')
    expect(text).toContain('(a plus b) plus c')
    expect(text).toContain('assign `value` the value number 2')
    expect(text).toContain('for each')
  })

  it('retains every action inside an authored step when reviewing the whole file', () => {
    const text = english(`test('case', async () => {
      await test.step('Prepare the account', async () => { await prepare(); expect(ready).toBe(true) })
    })`)
    expect(text).toContain('Prepare the account')
    expect(text).toContain('Call prepare with no arguments and wait for it to finish')
    expect(text).toContain('Check that ready equals true')
  })

  it('preserves callbacks nested in an argument collection', () => {
    const text = english('await run([() => work()])')
    expect(text).toContain('run')
    expect(text).toContain('work')
    expect(text).toContain('arrow function')
  })

  it.each([
    ['expect(unwrap(state.acceptBody)?.messageId).toBe(state.messageId)', 'equals state.messageId'],
    ['await expect(result).resolves.not.toBe(1)', 'Wait for the check that the resolved value of result does not equal 1'],
    ['expect(result).rejects.toBeDefined()', 'the rejection from result is defined'],
    ['expect.soft(value, "explain").toBe(2)', 'continue collecting failures if this check fails; with failure message "explain"'],
    ['expect(value).toBeVisible({timeout: 100})', 'with additional arguments (an object with timeout set to 100)'],
    ['expect(value).toBeTruthy()', 'value is truthy'],
    ['expect(value).toBe()', 'with no arguments'],
    ['expect(value).customMatcher(2)', 'custom'],
    ['expect(value).toBe<Type>(2)', 'with type argument:'],
    ['expect(value).toBe?.(2)', 'optional'],
    ['return expect(value).toBe(2)', 'return'],
  ])('preserves assertion subjects, modifiers and options: %s', (source, expected) => {
    expect(english(source)).toContain(expected)
    expect(rows(source)[0].role).toBe('check')
  })

  it('preserves dynamic it titles and initialized for-in bindings', () => {
    expect(english('it(`case ${id}`, () => {})')).toContain('Test: text formed by joining "case ", id')
    expect(english('for (var key = 0 in values) { consume(key) }')).toContain('initialize it to number 0')
    expect(english('for (const item: Item of items) { consume(item) }')).toContain('with type `Item`')
  })

  it('retains source fallback for synthetic unsupported syntax and propagates translator defects', () => {
    const context = compileSemanticSource('example.ts', ';')
    const unsupported = { kind: ts.SyntaxKind.Bundle } as ts.Statement
    expect(storyCandidates([unsupported], context.sourceFile, context)).toEqual([])
    const failure = new Error('translation failed')
    const render = vi.spyOn(syntaxEnglish, 'statementEnglish').mockImplementationOnce(() => { throw failure })
    try {
      expect(() => storyCandidates(context.sourceFile.statements, context.sourceFile, context)).toThrow(failure)
    } finally { render.mockRestore() }
  })
})
