import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { authoredStep, callFromStatement } from './call-syntax'
import { translateReadableTest } from './translator'
import { renderActionStatement } from './actions'

const wrappers = [
  '%s', 'await %s', '(%s)', '(%s as Promise<void>)', '<Promise<void>>%s', '(%s)!', '(%s satisfies Promise<void>)',
]

function statement(source: string): ts.Statement {
  return ts.createSourceFile('spec.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).statements[0]
}

describe('readable call syntax', () => {
  it.each(wrappers.flatMap((wrapper) => ['%s;', 'return %s;', 'const result = %s;'].map((form) => form.replace('%s', wrapper))))('recognizes calls in %s', (form) => {
    const source = form.replace('%s', "test.step('Checkout', async () => { await page.reload() })")
    const node = statement(source)
    expect(callFromStatement(node)?.expression.getText()).toBe('test.step')
    expect(authoredStep(node)?.label).toBe('Checkout')
    expect(node.getText()).toBe(source)
  })

  it.each(['return;', 'const result: unknown;', 'const a = first(), b = second();', 'if (ready) first();', '42;', 'test.step();', 'test.step(label, async () => {});', "test.step('label', callback);", "test.step('label', async () => run());", "other.step('label', async () => {});", 'run();', 'test.step(label);', "test.step('label');"])('keeps unsupported steps on the fallback path: %s', (source) => {
    expect(authoredStep(statement(source))).toBeUndefined()
  })

  it.each(wrappers)('renders wrapped actions: %s', (wrapper) => {
    const file = ts.createSourceFile('spec.ts', wrapper.replace('%s', "page.goto('/checkout')"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    expect(renderActionStatement(file.statements[0], file)).toMatchObject({ text: 'Open “/checkout”', fidelity: 'derived' })
  })

  it.each(wrappers)('retains source locations while grouping a wrapped step: %s', (wrapper) => {
    const source = wrapper.replace('%s', "test.step('Checkout', async () => { await page.reload() })")
    const result = translateReadableTest({ file: 'spec.ts', title: 'checkout', startLine: 20, bodySource: `{\n${source};\n}` })
    expect(result.nodes[0]).toMatchObject({ kind: 'group', text: 'Checkout', source: { startLine: 21, snippet: `${source};` } })
    expect(result.nodes[0]).toHaveProperty('children.0.source.startLine', 21)
  })
})
