import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  compileSemanticSource,
  rootIdentifierForExpression,
  symbolEvidence,
} from './semantic-context'

function identifiers(sourceFile: ts.SourceFile, name: string): ts.Identifier[] {
  const found: ts.Identifier[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) found.push(node)
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return found
}

describe('semantic compiler context', () => {
  it('builds TypeChecker Symbols for imports, aliases, factories, and Playwright fixtures', () => {
    const context = compileSemanticSource('/workspace/evidence.ts', `
import { test } from '@playwright/test'
import { ApiClient, createClient } from '@company/api'
import api from '@company/api'
import legacy = require('@company/legacy')
import qualified = Namespace.Client
import * as namespaceClient from '@company/namespace'

const constructed = new ApiClient()
const factory = createClient()
const propertyFactory = api.create()
const alias = constructed
const propertyAlias = api.client
const response = api.fetch()
const wrapped = (constructed!)
const data = 42
const { local } = holder
const assigned = ({ request: assignedRequest }: any) => assignedRequest
const odd = (flag ? one : two)()
namespaceClient.create()

test('works', async ({ request }) => request.get('/'))
other(async ({ request: otherRequest }) => otherRequest.get('/'))
function detached({ request: detachedRequest }: any) { return detachedRequest }
function typed(typedClient: ApiClient) { return typedClient }
function parenthesizedType(parenthesizedClient: (ApiClient)) { return parenthesizedClient }
function primitiveType(primitiveValue: number) { return primitiveValue }
function qualifiedType(qualifiedClient: namespaceClient.ApiClient) { return qualifiedClient }
`, {
      semanticRules: { apiClients: ['@company/api'], databaseClients: ['@company/legacy'] },
      absoluteSourceRanges: false,
    })

    expect(context.absoluteSourceRanges).toBe(false)
    expect(context.config).toEqual({
      apiClients: ['@company/api'],
      databaseClients: ['@company/legacy'],
    })
    expect(Object.isFrozen(context.config)).toBe(true)
    expect(Object.isFrozen(context.config.apiClients)).toBe(true)
    expect(Object.isFrozen(context.config.databaseClients)).toBe(true)
    for (const name of ['constructed', 'factory', 'propertyFactory', 'alias', 'propertyAlias', 'wrapped']) {
      const use = identifiers(context.sourceFile, name).at(-1)!
      expect(symbolEvidence(use, context).modules).toContain('@company/api')
    }
    expect(symbolEvidence(identifiers(context.sourceFile, 'typedClient').at(-1)!, context))
      .toMatchObject({ modules: ['@company/api'], importedNames: ['ApiClient'] })
    expect(symbolEvidence(identifiers(context.sourceFile, 'parenthesizedClient').at(-1)!, context))
      .toMatchObject({ modules: ['@company/api'], importedNames: ['ApiClient'] })
    expect(symbolEvidence(identifiers(context.sourceFile, 'primitiveValue').at(-1)!, context))
      .toEqual({ modules: [], importedNames: [], declaredInSource: true })
    expect(symbolEvidence(identifiers(context.sourceFile, 'qualifiedClient').at(-1)!, context))
      .toMatchObject({ modules: ['@company/namespace'], importedNames: ['*'] })
    expect(symbolEvidence(identifiers(context.sourceFile, 'response').at(-1)!, context).modules).toEqual([])
    expect(symbolEvidence(identifiers(context.sourceFile, 'data').at(-1)!, context).modules).toEqual([])
    expect(symbolEvidence(identifiers(context.sourceFile, 'legacy')[0], context).modules).toEqual(['@company/legacy'])
    expect(symbolEvidence(identifiers(context.sourceFile, 'namespaceClient')[0], context))
      .toMatchObject({ modules: ['@company/namespace'], importedNames: ['*'] })
    expect(symbolEvidence(identifiers(context.sourceFile, 'qualified')[0], context).modules).toEqual([])

    const request = identifiers(context.sourceFile, 'request')
      .find((identifier) => ts.isPropertyAccessExpression(identifier.parent))!
    expect(symbolEvidence(request, context)).toEqual({
      modules: ['@playwright/test'],
      importedNames: [],
      declaredInSource: true,
      fixture: 'request',
    })
    for (const name of ['otherRequest', 'detachedRequest', 'local', 'assignedRequest', 'odd']) {
      expect(symbolEvidence(identifiers(context.sourceFile, name).at(-1)!, context))
        .toEqual({ modules: [], importedNames: [], declaredInSource: true })
    }

    const constructedSymbol = context.checker.getSymbolAtLocation(identifiers(context.sourceFile, 'constructed')[0])!
    expect(symbolEvidence(identifiers(context.sourceFile, 'constructed')[0], context, new Set([constructedSymbol])))
      .toEqual({ modules: [], importedNames: [], declaredInSource: false })
    const synthetic = ts.factory.createIdentifier('missing')
    expect(symbolEvidence(synthetic, context))
      .toEqual({ modules: [], importedNames: [], declaredInSource: false })
    expect(symbolEvidence(identifiers(context.sourceFile, 'constructed')[0], {
      ...context,
      checker: {
        getSymbolAtLocation: () => ({ flags: ts.SymbolFlags.None }),
      } as unknown as ts.TypeChecker,
    })).toEqual({ modules: [], importedNames: [], declaredInSource: false })
  })

  it('finds roots through every supported expression wrapper and rejects computed roots', () => {
    const context = compileSemanticSource('/workspace/roots.ts', `async function scenario() {
  root.member;
  root[key];
  root();
  new root();
  root!;
  (root);
  await root;
  (ready ? left : right);
}`)
    const expressions: ts.Expression[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) expressions.push(node.expression)
      node.forEachChild(visit)
    }
    visit(context.sourceFile)
    expect(expressions.slice(0, 7).map((expression) => rootIdentifierForExpression(expression)?.text))
      .toEqual(['root', 'root', 'root', 'root', 'root', 'root', 'root'])
    expect(rootIdentifierForExpression(expressions[7])).toBeUndefined()
  })

  it('delegates non-root compiler files when resolution and standard libraries are enabled', () => {
    const context = compileSemanticSource('/workspace/with-lib.ts', 'const value: Promise<number> = Promise.resolve(1)', {
      compilerOptions: { noLib: false, noResolve: false, lib: ['lib.es2022.d.ts'] },
    })
    expect(context.sourceFile.fileName).toContain('with-lib.ts')
    expect(context.checker.getTypeAtLocation(context.sourceFile.statements[0]).flags).toBeTypeOf('number')
    expect(symbolEvidence(identifiers(context.sourceFile, 'Promise')[0], context))
      .toEqual({ modules: [], importedNames: [], declaredInSource: false })
  })
})
