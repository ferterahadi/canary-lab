import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { auditEnglishSource, inspectEnglishCandidates } from './english-audit'
import { compileSemanticSource } from '../apps/web-server/src/shared/controlled-english/semantic-context'
import { storyCandidates } from '../apps/web-server/src/shared/readable-tests/story'
import { sourceSyntaxFallback } from '../apps/web-server/src/shared/readable-tests/source-representation'
import { translateReadableSource } from '../apps/web-server/src/shared/readable-tests/translator'

describe('English source accounting', () => {
  it.each([
    'export const key = () => randomUUID()',
    'const values = [async () => { if (!ready) return; return read() }]',
    'const entity = { get value() { return 1 }, run() { execute() } }',
    'class Entity { value = read(); constructor() { this.value = 2 }; run() { return this.value } }',
    'test("step", async () => { await test.step("Prepare", async () => { await prepare(); expect(ready).toBe(true) }, { timeout: 1000 }) })',
    'test("expression", () => ready)',
    'test("branches", () => { switch (page[method]()) { case lookup(): consume(); break; default: recover() } })',
    'const read = () => syncSqlFixture((sql) => sql.read())',
    'const result = () => [rows.map((row) => `http result ${row.status}`)]',
    'export function work(\n  value: string,\n) {\n  return value\n}',
    'for (const value of [\n  1,\n  2\n]) consume(value)',
    'if (\n  ready\n) {\n  work()\n}',
    'do {\n  work()\n} while (\n  ready\n)',
    'const run = () =>\n  // Authored explanation before the expression.\n  work()',
    'try { work() } catch {\n  // A deliberate empty recovery block.\n}\n// A trailing file note.',
    '#!/usr/bin/env node\nwork()',
  ])('accounts for complete composed syntax: %s', (text) => {
    const report = auditEnglishSource('example.ts', text)
    expect(report.issues).toEqual([])
    expect(report.represented).toBe(report.required)
  })
  it('audits file review and test stories independently', () => {
    const report = auditEnglishSource('example.spec.ts', `test('value', () => {
      function localValue() { return 1 }
      expect(localValue()).toBe(1)
    })`)
    expect(report.tests).toBe(1)
    expect(report.required).toBeGreaterThan(0)
    expect(report.represented).toBe(report.required)
    expect(report.issues).toEqual([])
  })

  it('detects an omitted child even when the enclosing scope spans its source', () => {
    const context = compileSemanticSource('example.ts', 'function prepare() { const value = 1; consume(value) }')
    const candidates = storyCandidates(context.sourceFile.statements, context.sourceFile, context)
    expect(candidates[0].kind).toBe('flow')
    if (candidates[0].kind !== 'flow') throw new Error('Expected the function scope')
    candidates[0].children.splice(0, 1)
    const report = inspectEnglishCandidates('example.ts', 'file', context.sourceFile, context.sourceFile.statements, candidates)
    expect(report.issues).toEqual([expect.objectContaining({ reason: 'missing', syntaxKind: 'VariableStatement' })])
    expect(report.represented).toBe(report.required - 1)
  })

  it('rejects syntax wording even when every source statement has a row', () => {
    const context = compileSemanticSource('example.ts', 'const value = 1')
    const candidates = storyCandidates(context.sourceFile.statements, context.sourceFile, context)
    candidates[0].text = sourceSyntaxFallback(context.sourceFile.statements[0], 'declare constant value and initialize it to number 1')
    const report = inspectEnglishCandidates('example.ts', 'file', context.sourceFile, context.sourceFile.statements, candidates)
    expect(report.represented).toBe(report.required)
    expect(report.issues).toEqual([expect.objectContaining({ reason: 'syntax-fallback', syntaxKind: 'VariableStatement' })])
  })

  it('rejects malformed input instead of approving its recovered parse tree', () => {
    const report = auditEnglishSource('broken.ts', 'const = ;')
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'parse-error' })]))
  })

  it('accounts for each statement inside an inline callback', () => {
    const report = auditEnglishSource('example.ts', 'const callbacks = [() => { const value = 1; return value }]')
    expect(report.issues).toEqual([])
    expect(report.represented).toBe(report.required)
  })

  it('does not reuse representation metadata across source revisions', () => {
    const context = compileSemanticSource('example.ts', 'const value = 1')
    sourceSyntaxFallback(context.sourceFile.statements[0], 'unreadable')
    expect(auditEnglishSource('example.ts', 'const value = 2').issues).toEqual([])
  })

  it('does not count a branch label as its missing statement', () => {
    const context = compileSemanticSource('example.ts', 'if (ready) consume()')
    const candidates = storyCandidates(context.sourceFile.statements, context.sourceFile, context)
    const condition = candidates[0]
    if (condition.kind !== 'flow' || condition.children[0].kind !== 'flow') throw new Error('Expected conditional branches')
    condition.children[0].children = []
    const report = inspectEnglishCandidates('example.ts', 'file', context.sourceFile, context.sourceFile.statements, candidates)
    expect(report.issues).toEqual([expect.objectContaining({ reason: 'missing', syntaxKind: ts.SyntaxKind[ts.SyntaxKind.ExpressionStatement] })])
  })

  it('rejects output dropped between candidate generation and the displayed story', () => {
    const text = 'const value = 1; expect(value).toBe(1)'
    const context = compileSemanticSource('example.ts', text)
    const candidates = storyCandidates(context.sourceFile.statements, context.sourceFile, context)
    const displayed = translateReadableSource('example.ts', text).steps.slice(1)
    const report = inspectEnglishCandidates('example.ts', 'file', context.sourceFile, context.sourceFile.statements, candidates, displayed)
    expect(report.issues).toEqual([expect.objectContaining({ reason: 'missing', syntaxKind: 'VariableStatement' })])
  })

  it('detects a missing comparison mapping even when the English sentence still exists', () => {
    const text = 'function work(\n  value: string\n) {\n  return value\n}'
    const context = compileSemanticSource('example.ts', text)
    const candidates = storyCandidates(context.sourceFile.statements, context.sourceFile, context)
    const displayed = translateReadableSource('example.ts', text).steps
    if (displayed[0].kind !== 'flow') throw new Error('Expected a function flow')
    delete displayed[0].headerEndLine
    const report = inspectEnglishCandidates('example.ts', 'file', context.sourceFile, context.sourceFile.statements, candidates, displayed)
    expect(report.represented).toBe(report.required)
    expect(report.issues).toEqual([2, 3].map((line) => expect.objectContaining({ reason: 'missing', syntaxKind: 'SourceLine', line })))
  })

  it('does not let a retained comment stand in for its omitted statement', () => {
    const context = compileSemanticSource('example.ts', '// Prepare a value\nconst value = 1')
    const candidates = storyCandidates(context.sourceFile.statements, context.sourceFile, context).filter((item) => item.role === 'note')
    const report = inspectEnglishCandidates('example.ts', 'file', context.sourceFile, context.sourceFile.statements, candidates)
    expect(report.represented).toBe(0)
    expect(report.issues).toEqual([expect.objectContaining({ reason: 'missing', syntaxKind: 'VariableStatement' })])
  })
})
