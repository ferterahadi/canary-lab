import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { canonicalExpression, type CanonicalCall, type CanonicalExpression } from './canonical-ir'
import { compileSemanticSource } from './semantic-context'
import {
  classifyExpression,
  createSemanticRuleRegistry,
  highestPrecedenceCategory,
} from './semantic-rules'

function canonicalExpressions(source: string): CanonicalExpression[] {
  const context = compileSemanticSource('/workspace/rules.ts', source)
  const out: CanonicalExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node)) out.push(canonicalExpression(node.expression, context))
    node.forEachChild(visit)
  }
  visit(context.sourceFile)
  return out
}

describe('semantic rule registry', () => {
  it('classifies registered libraries, globals, fixtures, filesystem, and logging independently', () => {
    const context = compileSemanticSource('/workspace/rules.spec.ts', `
import axios from 'axios/subpath'
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import customApi from '@company/api'
import customDb from '@company/db'
import { test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
const prisma = new PrismaClient()
fetch('/health')
axios.get('/health')
prisma.user.findMany()
fs.readFileSync('/tmp/value')
customApi.send(payload)
customDb.query()
console.log('ready')
test('fixture', async ({ request }) => request.get('/health'))
function typedRequest(client: APIRequestContext) { client.get('/typed') }
`, { semanticRules: { apiClients: ['@company/api'], databaseClients: ['@company/db'] } })
    const registry = createSemanticRuleRegistry(context.config)
    const calls: CanonicalCall[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const value = canonicalExpression(node, context)
        if (value.kind === 'call') calls.push(value)
      }
      node.forEachChild(visit)
    }
    visit(context.sourceFile)
    const categoriesFor = (code: string) => registry.classifyCall(calls.find((call) => call.code === code)!)
    expect(categoriesFor("fetch('/health')")).toEqual(['external-api', 'function-call'])
    expect(categoriesFor("axios.get('/health')")).toEqual(['external-api', 'function-call'])
    expect(categoriesFor('prisma.user.findMany()')).toEqual(['database', 'function-call'])
    expect(categoriesFor("fs.readFileSync('/tmp/value')")).toEqual(['filesystem', 'function-call'])
    expect(categoriesFor('customApi.send(payload)')).toEqual(['external-api', 'function-call'])
    expect(categoriesFor('customDb.query()')).toEqual(['database', 'function-call'])
    expect(categoriesFor("console.log('ready')")).toEqual(['logging', 'function-call'])
    expect(categoriesFor("request.get('/health')")).toEqual(['external-api', 'function-call'])
    expect(categoriesFor("client.get('/typed')")).toEqual(['external-api', 'function-call'])
  })

  it('accepts extra adapters and preserves every nested expression category', () => {
    const expressions = canonicalExpressions(`async function scenario() {
  await fetch('/health');
  fetch('/health').result[lookup()];
  left = fetch('/left');
  right += fetch('/right');
  plain + value;
  (value => fetch(value));
  (value => { return value });
  identifier;
  1;
  new Service();
}`)
    const registry = createSemanticRuleRegistry({}, [{
      id: 'custom',
      category: 'database',
      translation: 'Query',
      match: (call) => call.rootName === 'lookup',
    }])
    expect(classifyExpression(expressions[0], registry)).toEqual(['external-api', 'async', 'function-call'])
    expect(classifyExpression(expressions[1], registry)).toEqual(['database', 'external-api', 'function-call'])
    expect(classifyExpression(expressions[2], registry)).toEqual(['external-api', 'assignment', 'function-call'])
    expect(classifyExpression(expressions[3], registry)).toEqual(['external-api', 'assignment', 'function-call'])
    expect(classifyExpression(expressions[4], registry)).toEqual([])
    expect(classifyExpression(expressions[5], registry)).toEqual(['external-api', 'function-call'])
    expect(classifyExpression(expressions[6], registry)).toEqual([])
    expect(classifyExpression(expressions[7], registry)).toEqual([])
    expect(classifyExpression(expressions[8], registry)).toEqual([])
    expect(classifyExpression(expressions[9], registry)).toEqual([])
    expect(registry.rules.at(-1)).toMatchObject({ id: 'custom', translation: 'Query' })
  })

  it('does not classify locally shadowed global names from their spelling alone', () => {
    const expressions = canonicalExpressions(`function fetch() {}
function expect() { return { toBe() {} } }
const console = { log() {} }
fetch('/local')
expect(value).toBe(expected)
console.log('local')`)
    const registry = createSemanticRuleRegistry()
    expect(expressions.slice(-3).map((expression) => classifyExpression(expression, registry)))
      .toEqual([
        ['function-call'],
        ['function-call'],
        ['function-call'],
      ])
  })

  it('returns the highest category by fixed precedence or undefined', () => {
    expect(highestPrecedenceCategory(['function-call', 'assertion', 'async'])).toBe('assertion')
    expect(highestPrecedenceCategory([])).toBeUndefined()
  })
})
