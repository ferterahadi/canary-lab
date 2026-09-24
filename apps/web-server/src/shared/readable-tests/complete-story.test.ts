import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { ReadableStoryItem } from '../../../../../shared/readable-tests/types'
import { translateReadableSource, translateReadableTest } from './translator'
import { compileSemanticSource } from '../controlled-english/semantic-context'
import { sourceDeclarationText, sourceExpressionText, sourceFunctionText } from './source-language'
import { sourceRepresentationGaps } from './source-representation'

const flatten = (items: ReadableStoryItem[]): ReadableStoryItem[] => items.flatMap((item) => [item, ...(item.kind === 'flow' ? flatten(item.children) : [])])
const wording = (source: string, file = 'example.ts') => flatten(translateReadableSource(file, source).steps).map((item) => item.text).join('\n')

describe('complete English review', () => {
  it.each([
    ['export function work(\n  value: string,\n) {\n  return value\n}', 3, 4],
    ['export const work = (\n  value: string,\n) =>\n  value', 3, 4],
    ['export const work = function (\n  value: string,\n) {\n  return value\n}', 3, 4],
    ['test.beforeEach(\n  async ({ page }) => {\n    await page.goto("/")\n  }\n)', 2, 3],
  ] as const)('maps multiline declaration headers separately from their bodies: %s', (source, headerEndLine, bodyLine) => {
    const flow = translateReadableSource('example.ts', source).steps[0]
    expect(flow).toMatchObject({ kind: 'flow', headerEndLine, children: [expect.objectContaining({ source: expect.objectContaining({ startLine: bodyLine }) })] })
  })

  it('shares complete source grammar across test cards and file review, independently of the summary', () => {
    const body = `{
      const key = () => randomUUID()
      function hidden() { return false }
      if (page[method](target())) { hidden() }
      await wrapper(async () => { const answer = 42; expect(answer).toBe(42) })
    }`
    const test = translateReadableTest({ file: 'example.ts', title: 'review', bodySource: body, startLine: 1 })
    const full = flatten(test.story!.steps)
    expect(full.map((item) => item.text)).toEqual(flatten(translateReadableSource('example.ts', body).steps).map((item) => item.text))
    const text = full.map((item) => item.text).join('\n')
    for (const part of ['Define arrow function key', 'randomUUID()', 'Define function hidden', 'Return false', 'item at method from page', 'target()', 'passing an asynchronous arrow function', 'Set constant answer to 42', 'Check that answer equals 42']) expect(text).toContain(part)
    expect(flatten(test.summary!.steps).map((item) => item.text).join('\n')).not.toContain('Define function hidden')
    expect(test.completeness).toBe('complete')
    for (const item of full) expect(item.spans.map((span) => span.text).join('')).toBe(item.text)
  })

  it.each([
    ['export const key = () => randomUUID()', ['Define exported arrow function key with no parameters, stored as a constant', 'Return the result of randomUUID()']],
    ['let key = function named() { return randomUUID() }', ['Define key as a function named named with no parameters, stored as a variable', 'Return the result of randomUUID()']],
    ['var key = function* () { yield* values; yield }', ['stored as a function-scoped variable', 'yield each value from values', 'yield without a value']],
    ['const child = new Factory<Type>(1); const bare = new Factory; const plain = new Factory()', ['type argument', 'with 1', 'a new Factory']],
    ['function make() { return new.target }; const value = new Map<Key, Value>()', ["the constructor's target", 'with type arguments']],
    ['const f: Callback = (value?: string) => value; const g: Callback = function () {}; for await (const [key, value] of entries) { use(key, value) }', ['value (optional) of type string', 'with variable type `Callback`', 'awaiting each value']],
    ['ready && send(); cached || read(); try { work() } catch ({ message, code }) { report(message, code) }', ['evaluating (the result of send()) only when the left value is truthy', 'evaluating (the result of read()) only when the left value is falsy', 'save the error as object pattern (property message; property code)']],
    ['const callbacks = [() => { try { work() } finally { finish() }; declare function overload(): void; outer: while (ready) { break outer }; while (ready) { continue } }]', ['Whether the attempt succeeds or fails', 'with no body', 'Leave the block labelled outer', 'Continue with the next iteration']],
    ['const child = class { value = 1 }; const value = import.meta.url', ['class (anonymous)', 'property value initialized to 1', "module's meta metadata"]],
    ['value += 1; count--; ++count; value = +other; value = ~other; void run(); delete record.key', ['add and assign to value the value 1', 'previous value before decreasing', 'updated value after increasing', 'converted to a number', 'bitwise complement', 'undefined after evaluating', 'deleting record.key']],
    ['const callbacks = [() => { try { work() } catch (error) { recover(error) } finally { cleanup() }; try {} catch { /* ignored deliberately */ }; for (;;) break; switch (mode) { case 1: break; default: }; function nested() {}; outer: while (ready) continue outer; with (record) {} }]', ['If an error is thrown, bind it to error', 'Whether the attempt succeeds or fails', 'Repeat until stopped', 'When 1 matches', 'When no earlier value matches', 'Define function nested', 'Label outer', 'Continue with the next iteration of outer', 'as the active scope']],
    ['class Example { @decorate accessor value = 1; optional?: number; definite!: number; static { setup() }; constructor(public readonly value: number = 1) {}; get current() { return this.value }; set current(value) { this.value = value }; async *method<T>(...values: T[]) { yield values } }', ['decorated with decorate', 'accessor property value', 'optional', 'definitely assigned', 'static initialization', 'constructor taking public readonly value', 'getter current', 'setter current', 'generator method method']],
    ['interface Contract<T = string> extends Base<T> { optional?: T; method?(value: T): void; (value: T): T; new(): Contract; [key: string]: T }', ['interface Contract', 'defaulting to string', 'extending Base', 'method method (optional)', 'call signature taking value', 'constructor with no parameters', 'index signature']],
    ['export default class extends Base implements Shape { [key()] = 1 }; const empty = class Named {}; export type {Item as Other} from "./types"; export * as all from "./all"; export * from "./base"', ['exported as default class (anonymous)', 'implementing Shape', 'name computed from the result of key()', 'class Named, with no members', 'Export types Item as Other', 'Export all exports as all', 'Export all exports from']],
    ['const { [key()]: value = 1, ...rest } = source; await using resource = acquire(); export = value', ['property named by the result of key() as value', 'remaining entries as rest', 'asynchronously disposed resource', 'Assign the module export to value']],
    ['const view = <><Box enabled value={item} empty={} {...props} child={<Nested/>}>text{item}<Child /></Box></>', ['JSX fragment', 'enabled set to true', 'empty set to an empty expression', 'all attributes from props', 'JSX element named Nested', 'text "text"', 'the value of item']],
    ['const view = <Box title="text">{/* comment */}</Box>; export { type Item, value }; export { value } from "./module" with { type: "json" }', ['title set to "text"', 'an empty expression', 'Export type Item, value', 'with attributes type set to "json"']],
    ['const view = <Box child=<Nested/> />', ['child set to a JSX element named Nested']],
  ] as const)('preserves syntax contracts in English: %s', (source, expected) => {
    const first = translateReadableSource('example.tsx', source)
    expect(translateReadableSource('example.tsx', source)).toEqual(first)
    const text = wording(source, 'example.tsx')
    for (const part of expected) expect(text).toContain(part)
    expect(flatten(first.steps).some((item) => item.presentation === 'syntax-fallback')).toBe(false)
  })

  it('marks unsupported source grammar as partial, even when syntax wording exists', () => {
    const test = translateReadableTest({ file: 'example.ts', title: 'module declaration', bodySource: '{ namespace Scope {} }' })
    expect(test.completeness).toBe('partial')
    expect(flatten(test.story!.steps).some((item) => item.presentation === 'syntax-fallback')).toBe(true)
    expect(flatten(translateReadableSource('example.ts', 'const callbacks = [() => { namespace Scope {} }]').steps)
      .some((item) => item.presentation === 'syntax-fallback')).toBe(true)
  })

  it('keeps empty comments out of the explanation without dropping the following statement', () => {
    expect(translateReadableSource('example.ts', '//\nconst value = 1').steps.map((item) => item.text)).toEqual(['Set constant value to 1'])
  })

  it('marks function modifiers outside the source grammar instead of discarding them', () => {
    const source = compileSemanticSource('example.ts', 'export function work() {}').sourceFile
    const declaration = source.statements[0] as ts.FunctionDeclaration
    Object.defineProperty(declaration.modifiers![0], 'kind', { value: ts.SyntaxKind.PrivateKeyword })
    expect(sourceFunctionText(declaration)).toContain('private')
    expect(sourceRepresentationGaps(declaration)).toHaveLength(1)
  })

  it('retains and marks future member syntax instead of silently dropping its source', () => {
    const source = compileSemanticSource('example.ts', 'class Entity { value = 1 }').sourceFile
    const declaration = source.statements[0] as ts.ClassDeclaration
    const member = declaration.members[0]
    Object.defineProperty(member, 'kind', { value: ts.SyntaxKind.Unknown })
    expect(sourceDeclarationText(declaration)).toContain('Untranslated member value = 1')
    expect(sourceRepresentationGaps(declaration)).toEqual([expect.objectContaining({ node: member, reason: 'syntax-fallback' })])
  })

  it('rejects an unknown binary operator rather than claiming its operands are explained', () => {
    const source = compileSemanticSource('example.ts', 'value + other').sourceFile
    const expression = (source.statements[0] as ts.ExpressionStatement).expression as ts.BinaryExpression
    Object.defineProperty(expression.operatorToken, 'kind', { value: ts.SyntaxKind.Unknown })
    expect(() => sourceExpressionText(expression)).toThrow()
  })
})
