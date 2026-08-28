import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parseSource, scriptKindForFile } from './compiler-context'

describe('scriptKindForFile', () => {
  it.each([
    ['component.tsx', ts.ScriptKind.TSX],
    ['component.jsx', ts.ScriptKind.JSX],
    ['script.js', ts.ScriptKind.JS],
    ['script.mjs', ts.ScriptKind.JS],
    ['script.cjs', ts.ScriptKind.JS],
    ['module.ts', ts.ScriptKind.TS],
    ['types.d.ts', ts.ScriptKind.TS],
  ])('%s → %d', (file, expected) => {
    expect(scriptKindForFile(file)).toBe(expected)
  })
})

describe('parseSource', () => {
  it('returns the source file and the script kind it parsed with', () => {
    const { sourceFile, scriptKind } = parseSource('example.tsx', 'const el = <p>ok</p>;')
    expect(scriptKind).toBe(ts.ScriptKind.TSX)
    expect(sourceFile.fileName).toBe('example.tsx')
    // JSX only parses under a JSX-aware kind, so a JsxElement in the tree
    // proves the kind was actually applied, not just reported.
    const statement = sourceFile.statements[0] as ts.VariableStatement
    const initializer = statement.declarationList.declarations[0].initializer
    expect(initializer && ts.isJsxElement(initializer)).toBe(true)
  })

  it('sets parent nodes so translation can read upward', () => {
    const { sourceFile } = parseSource('example.ts', 'run();')
    const statement = sourceFile.statements[0]
    expect(statement.parent).toBe(sourceFile)
  })
})
