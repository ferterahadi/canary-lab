import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { readDisplayTestTitle, readLiteralTestTitle } from './test-title'

describe('test title readers', () => {
  it.each([
    ["'checkout'", 'checkout', 'checkout'],
    ['"checkout"', 'checkout', 'checkout'],
    ["''", '', ''],
    ['`checkout`', 'checkout', 'checkout'],
    ['``', '', ''],
    ['`hello ${user.name}`', null, 'hello ${user.name}'],
    ['', null, null],
    ['title', null, null],
    ['12', null, null],
  ])('reads %s without evaluating expressions', (argument, literal, display) => {
    const src = ts.createSourceFile('fixture.spec.ts', `test(${argument})`, ts.ScriptTarget.Latest, true)
    const call = (src.statements[0] as ts.ExpressionStatement).expression as ts.CallExpression
    expect(readLiteralTestTitle(call)).toBe(literal)
    expect(readDisplayTestTitle(call, src)).toBe(display)
  })
})
