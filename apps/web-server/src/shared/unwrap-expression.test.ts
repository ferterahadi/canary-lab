import ts from 'typescript'
import { expect, it } from 'vitest'
import { unwrapExpression } from './unwrap-expression'

function expression(source: string): ts.Expression {
  const file = ts.createSourceFile('probe.ts', `async function probe() { const value = ${source} }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const body = (file.statements[0] as ts.FunctionDeclaration).body!
  return (body.statements[0] as ts.VariableStatement).declarationList.declarations[0].initializer!
}

it.each(['name', '(name)', 'name as string', '<string>name', 'name!', 'name satisfies string', '((<string>(name!)) as string) satisfies string'])(
  'preserves the original inner node for %s', (source) => {
    const node = expression(source)
    let leaf = node
    while ('expression' in leaf) leaf = leaf.expression as ts.Expression
    expect(unwrapExpression(node, { unwrapAwait: false })).toBe(leaf)
    expect(unwrapExpression(node, { unwrapAwait: true })).toBe(leaf)
    expect(leaf.getText()).toBe('name')
  },
)

it('preserves await boundaries unless explicitly enabled, including nested awaits', () => {
  const node = expression('((await ((await name)!)) as string)')
  const awaited = unwrapExpression(node, { unwrapAwait: false })
  expect(ts.isAwaitExpression(awaited)).toBe(true)
  expect(unwrapExpression(awaited, { unwrapAwait: false })).toBe(awaited)
  expect(unwrapExpression(node, { unwrapAwait: true }).getText()).toBe('name')
})
