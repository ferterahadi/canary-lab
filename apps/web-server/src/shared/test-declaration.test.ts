import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { declarationModifier, getCalleeChain, isTestCall } from './test-declaration'

function call(source: string): ts.CallExpression {
  const file = ts.createSourceFile('spec.ts', source, ts.ScriptTarget.Latest, true)
  return (file.statements[0] as ts.ExpressionStatement).expression as ts.CallExpression
}

describe('test declarations', () => {
  it.each(['test', 'it'].flatMap((root) => ['', '.only', '.skip', '.fixme', '.fail'].map((suffix) => `${root}${suffix}`)))('recognizes %s', (callee) => {
    const node = call(`${callee}('title', async () => {})`)
    expect(isTestCall(node)).toBe(true)
    expect(declarationModifier(node)).toBe(callee.split('.')[1])
  })

  it.each(['test.beforeEach', 'test.afterAll', 'test.use', 'test.setTimeout', 'test.step', 'test.describe', 'test.only.skip', 'suite', 'test["only"]', 'factory().test'])('rejects %s', (callee) => {
    expect(isTestCall(call(`${callee}('title', async () => {})`))).toBe(false)
  })

  it('retains the dotted chain for other extraction callers', () => {
    expect(getCalleeChain(call('test.describe.serial()').expression)).toEqual(['test', 'describe', 'serial'])
  })
})
