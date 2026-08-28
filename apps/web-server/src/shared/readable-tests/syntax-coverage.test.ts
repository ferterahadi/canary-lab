import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { ReadableStoryItem } from '../../../../../shared/readable-tests/types'
import { renderExpression } from './expression'
import { translateReadableTest } from './translator'

type SyntaxDisposition =
  | 'translated'
  | 'container'
  | 'nested'
  | 'declaration'
  | 'type-only'
  | 'module-only'
  | 'compiler-only'
  | 'invalid-source'

// This is the review surface for every public AST expression kind in the
// installed TypeScript compiler. "Nested" means the parent construct owns the
// prose; it does not mean the syntax was forgotten.
const EXPRESSION_SYNTAX = {
  NumericLiteral: 'translated',
  BigIntLiteral: 'translated',
  StringLiteral: 'translated',
  RegularExpressionLiteral: 'translated',
  NoSubstitutionTemplateLiteral: 'translated',
  Identifier: 'translated',
  PrivateIdentifier: 'nested',
  FalseKeyword: 'translated',
  ImportKeyword: 'nested',
  NullKeyword: 'translated',
  SuperKeyword: 'translated',
  ThisKeyword: 'translated',
  TrueKeyword: 'translated',
  ArrayLiteralExpression: 'translated',
  ObjectLiteralExpression: 'translated',
  PropertyAccessExpression: 'translated',
  ElementAccessExpression: 'translated',
  CallExpression: 'translated',
  NewExpression: 'translated',
  TaggedTemplateExpression: 'translated',
  TypeAssertionExpression: 'translated',
  ParenthesizedExpression: 'translated',
  FunctionExpression: 'nested',
  ArrowFunction: 'nested',
  DeleteExpression: 'translated',
  TypeOfExpression: 'translated',
  VoidExpression: 'translated',
  AwaitExpression: 'translated',
  PrefixUnaryExpression: 'translated',
  PostfixUnaryExpression: 'translated',
  BinaryExpression: 'translated',
  ConditionalExpression: 'translated',
  TemplateExpression: 'translated',
  YieldExpression: 'translated',
  SpreadElement: 'nested',
  ClassExpression: 'translated',
  OmittedExpression: 'nested',
  ExpressionWithTypeArguments: 'nested',
  AsExpression: 'translated',
  NonNullExpression: 'translated',
  MetaProperty: 'translated',
  SyntheticExpression: 'compiler-only',
  SatisfiesExpression: 'translated',
  MissingDeclaration: 'invalid-source',
  JsxElement: 'translated',
  JsxSelfClosingElement: 'translated',
  JsxOpeningElement: 'nested',
  JsxFragment: 'translated',
  JsxOpeningFragment: 'nested',
  JsxClosingFragment: 'nested',
  JsxAttributes: 'nested',
  JsxExpression: 'nested',
  PartiallyEmittedExpression: 'compiler-only',
  CommaListExpression: 'compiler-only',
} as const satisfies Record<string, SyntaxDisposition>

// Statements legal only at module scope are classified separately because a
// Playwright test callback can never execute them as authored test steps.
const STATEMENT_SYNTAX = {
  Block: 'container',
  EmptyStatement: 'declaration',
  VariableStatement: 'translated',
  ExpressionStatement: 'translated',
  IfStatement: 'container',
  DoStatement: 'container',
  WhileStatement: 'container',
  ForStatement: 'container',
  ForInStatement: 'container',
  ForOfStatement: 'container',
  ContinueStatement: 'translated',
  BreakStatement: 'translated',
  ReturnStatement: 'translated',
  WithStatement: 'container',
  SwitchStatement: 'container',
  LabeledStatement: 'container',
  ThrowStatement: 'translated',
  TryStatement: 'container',
  DebuggerStatement: 'translated',
  FunctionDeclaration: 'declaration',
  ClassDeclaration: 'declaration',
  InterfaceDeclaration: 'type-only',
  TypeAliasDeclaration: 'type-only',
  EnumDeclaration: 'declaration',
  ModuleDeclaration: 'declaration',
  ModuleBlock: 'nested',
  NamespaceExportDeclaration: 'module-only',
  ImportEqualsDeclaration: 'module-only',
  ImportDeclaration: 'module-only',
  ExportAssignment: 'module-only',
  ExportDeclaration: 'module-only',
  MissingDeclaration: 'invalid-source',
  NotEmittedStatement: 'compiler-only',
} as const satisfies Record<string, SyntaxDisposition>

interface CompilerSyntaxInventory {
  expressions: string[]
  statements: string[]
}

/** Derive the public Expression and Statement unions from TypeScript's own
 * declaration file. This intentionally fails when a compiler upgrade adds a
 * syntax kind that Canary has not classified above. */
function compilerSyntaxInventory(): CompilerSyntaxInventory {
  const require = createRequire(import.meta.url)
  const declarationsPath = path.join(path.dirname(require.resolve('typescript')), 'typescript.d.ts')
  const sourceFile = ts.createSourceFile(
    declarationsPath,
    fs.readFileSync(declarationsPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const bases = new Map<string, Set<string>>()
  const kinds = new Map<string, Set<string>>()

  const heritageName = (node: ts.ExpressionWithTypeArguments): string => {
    let expression = node.expression
    while (ts.isPropertyAccessExpression(expression)) expression = expression.name
    return ts.isIdentifier(expression) ? expression.text : expression.getText(sourceFile)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      const interfaceBases = bases.get(node.name.text) ?? new Set<string>()
      for (const clause of node.heritageClauses ?? []) {
        for (const type of clause.types) interfaceBases.add(heritageName(type))
      }
      bases.set(node.name.text, interfaceBases)

      const interfaceKinds = kinds.get(node.name.text) ?? new Set<string>()
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || member.name.getText(sourceFile) !== 'kind' || !member.type) continue
        for (const match of member.type.getText(sourceFile).matchAll(/SyntaxKind\.([A-Za-z0-9_]+)/g)) {
          interfaceKinds.add(match[1])
        }
      }
      if (interfaceKinds.size) kinds.set(node.name.text, interfaceKinds)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const extendsType = (name: string, target: string, seen = new Set<string>()): boolean => {
    if (name === target) return true
    if (seen.has(name)) return false
    seen.add(name)
    return [...(bases.get(name) ?? [])].some((base) => extendsType(base, target, new Set(seen)))
  }
  const kindsExtending = (target: string): string[] => [...kinds.entries()]
    .filter(([name]) => extendsType(name, target))
    .flatMap(([, names]) => [...names])
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort((left, right) => Number(ts.SyntaxKind[left as keyof typeof ts.SyntaxKind]) - Number(ts.SyntaxKind[right as keyof typeof ts.SyntaxKind]))

  return {
    expressions: kindsExtending('Expression'),
    statements: kindsExtending('Statement'),
  }
}

function expressionFrom(source: string, scriptKind: ts.ScriptKind = ts.ScriptKind.TS): { expression: ts.Expression; sourceFile: ts.SourceFile } {
  const sourceFile = ts.createSourceFile('syntax-probe.tsx', `const result = ${source}`, ts.ScriptTarget.Latest, true, scriptKind)
  const statement = sourceFile.statements[0]
  if (!ts.isVariableStatement(statement)) throw new Error(`Expected a variable statement for ${source}`)
  const expression = statement.declarationList.declarations[0].initializer
  if (!expression) throw new Error(`Expected an initializer for ${source}`)
  return { expression, sourceFile }
}

function firstExpressionOfKind(source: string, kind: ts.SyntaxKind): { expression: ts.Expression; sourceFile: ts.SourceFile } {
  const sourceFile = ts.createSourceFile('syntax-context.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (!expression && node.kind === kind && ts.isExpression(node)) expression = node
    if (!expression) ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!expression) throw new Error(`Expected ${ts.SyntaxKind[kind]} in ${source}`)
  return { expression, sourceFile }
}

function storyItems(items: ReadableStoryItem[] | undefined): ReadableStoryItem[] {
  return (items ?? []).flatMap((item) => [
    item,
    ...(item.kind === 'flow' ? storyItems(item.children) : []),
  ])
}

const EXPRESSION_PROBES = {
  NumericLiteral: '42',
  BigIntLiteral: '42n',
  StringLiteral: "'value'",
  RegularExpressionLiteral: '/value/i',
  NoSubstitutionTemplateLiteral: '`value`',
  Identifier: 'value',
  FalseKeyword: 'false',
  NullKeyword: 'null',
  ThisKeyword: 'this',
  TrueKeyword: 'true',
  ArrayLiteralExpression: '[value]',
  ObjectLiteralExpression: '{ value }',
  PropertyAccessExpression: 'value.name',
  ElementAccessExpression: 'value[key]',
  CallExpression: 'Date.now()',
  NewExpression: 'new Set(values)',
  TaggedTemplateExpression: 'sql`select ${id}`',
  TypeAssertionExpression: '<number>value',
  ParenthesizedExpression: '(value)',
  TypeOfExpression: 'typeof value',
  VoidExpression: 'void value',
  AwaitExpression: 'await value',
  PrefixUnaryExpression: '-value',
  BinaryExpression: 'left + right',
  ConditionalExpression: 'ready ? left : right',
  TemplateExpression: '`value ${id}`',
  ClassExpression: 'class Worker {}',
  AsExpression: 'value as number',
  NonNullExpression: 'value!',
  MetaProperty: 'import.meta',
  SatisfiesExpression: 'value satisfies number',
  JsxElement: '<Panel id={id}>ready</Panel>',
  JsxSelfClosingElement: '<Panel id={id} />',
  JsxFragment: '<>ready</>',
} as const

describe('TypeScript syntax coverage', () => {
  it('classifies every public compiler expression and statement kind', () => {
    const inventory = compilerSyntaxInventory()
    expect(Object.keys(EXPRESSION_SYNTAX).sort()).toEqual(inventory.expressions.sort())
    expect(Object.keys(STATEMENT_SYNTAX).sort()).toEqual(inventory.statements.sort())
  })

  it('renders every directly readable expression family without source fallback', () => {
    for (const [kind, source] of Object.entries(EXPRESSION_PROBES)) {
      const scriptKind = kind.startsWith('Jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      const parsed = expressionFrom(source, scriptKind)
      expect(parsed.expression.kind, source).toBe(ts.SyntaxKind[kind as keyof typeof ts.SyntaxKind])
      expect(renderExpression(parsed.expression, parsed.sourceFile), source)
        .not.toEqual(expect.objectContaining({ fidelity: 'unresolved' }))
    }

    const contextualProbes = [
      firstExpressionOfKind('class Child extends Parent { read() { return super.value } }', ts.SyntaxKind.SuperKeyword),
      firstExpressionOfKind('function* values() { yield item }', ts.SyntaxKind.YieldExpression),
    ]
    for (const probe of contextualProbes) {
      expect(renderExpression(probe.expression, probe.sourceFile))
        .not.toEqual(expect.objectContaining({ fidelity: 'unresolved' }))
    }

    for (const [bodySource, text] of [
      ['{ delete account.secret }', /Remove “secret” from account/],
      ['{ count++ }', /Increase count by 1/],
    ] as const) {
      const translated = translateReadableTest({ file: 'syntax-probe.ts', title: bodySource, startLine: 1, bodySource })
      expect(storyItems(translated.story?.steps).map((item) => item.text).join('\n')).toMatch(text)
    }

    const contextualKinds = ['SuperKeyword', 'YieldExpression', 'DeleteExpression', 'PostfixUnaryExpression']
    const expected = Object.entries(EXPRESSION_SYNTAX)
      .filter(([, disposition]) => disposition === 'translated')
      .map(([kind]) => kind)
      .sort()
    expect([...Object.keys(EXPRESSION_PROBES), ...contextualKinds].sort()).toEqual(expected)
  })

  it('numbers every executable statement family while leaving definitions classified', () => {
    const probes: Array<[kind: keyof typeof STATEMENT_SYNTAX, bodySource: string, text: RegExp]> = [
      ['Block', '{ { submit() } }', /Send the request/],
      ['VariableStatement', '{ const value = 1 }', /Set value to 1/],
      ['ExpressionStatement', '{ submit() }', /Send the request/],
      ['IfStatement', '{ if (ready) submit() }', /If ready is true/],
      ['DoStatement', '{ do { submit() } while (ready) }', /Run once/],
      ['WhileStatement', '{ while (ready) { submit() } }', /While ready is true/],
      ['ForStatement', '{ for (let index = 0; index < 1; index += 1) submit(index) }', /Repeat/],
      ['ForInStatement', '{ for (const key in record) submit(key) }', /for each property key in record/i],
      ['ForOfStatement', '{ for (const value of values) submit(value) }', /for each value in values/i],
      ['ContinueStatement', '{ while (ready) { continue } }', /Skip to the next iteration/],
      ['BreakStatement', '{ while (ready) { break } }', /Stop this loop/],
      ['ReturnStatement', '{ return }', /Return without a value/],
      ['WithStatement', '{ with (record) { submit() } }', /active scope/],
      ['SwitchStatement', "{ switch (mode) { case 'a': submit(); break } }", /Choose a path/],
      ['LabeledStatement', '{ outer: while (ready) { break outer } }', /Leave outer/],
      ['ThrowStatement', "{ throw new Error('failed') }", /Fail with/],
      ['TryStatement', '{ try { submit() } catch { recover() } }', /Attempt these steps/],
      ['DebuggerStatement', '{ debugger }', /Pause at the debugger statement/],
    ]

    const covered = new Set<keyof typeof STATEMENT_SYNTAX>()
    for (const [kind, bodySource, text] of probes) {
      covered.add(kind)
      const translated = translateReadableTest({ file: 'syntax-probe.ts', title: kind, startLine: 1, bodySource })
      expect(storyItems(translated.story?.steps).map((item) => item.text).join('\n'), kind).toMatch(text)
    }
    const expected = Object.entries(STATEMENT_SYNTAX)
      .filter(([, disposition]) => disposition === 'translated' || disposition === 'container')
      .map(([kind]) => kind)
      .sort()
    expect([...covered].sort()).toEqual(expected)
  })
})
