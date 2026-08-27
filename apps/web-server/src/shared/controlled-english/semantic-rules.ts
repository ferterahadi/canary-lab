import ts from 'typescript'
import type {
  ReadableSemanticCategory,
  ReadableSemanticRuleConfig,
} from '../../../../../shared/readable-tests/types'
import type { CanonicalCall, CanonicalExpression } from './canonical-ir'

export interface SemanticRule {
  id: string
  category: ReadableSemanticCategory
  match(call: CanonicalCall): boolean
  /** Optional canonical phrase owned by this adapter, never by the AST layer. */
  translation?: string
}

export interface SemanticRuleRegistry {
  rules: readonly SemanticRule[]
  classifyCall(call: CanonicalCall): ReadableSemanticCategory[]
}

export const SEMANTIC_PRECEDENCE: readonly ReadableSemanticCategory[] = [
  'error-control-flow',
  'assertion',
  'database',
  'external-api',
  'filesystem',
  'logging',
  'branch',
  'iteration',
  'return',
  'declaration',
  'assignment',
  'async',
  'function-call',
  'unknown',
]

const KNOWN_API_MODULES = [
  'axios',
  'got',
  'undici',
  'superagent',
  'request',
  'node-fetch',
] as const

const KNOWN_DATABASE_MODULES = [
  '@prisma/client',
  'drizzle-orm',
  'typeorm',
  'sequelize',
  'mongoose',
  'knex',
  '@supabase/supabase-js',
  'pg',
  'mysql2',
  'mongodb',
  'cassandra-driver',
] as const

const FILESYSTEM_MODULES = ['node:fs', 'node:fs/promises', 'fs', 'fs/promises'] as const
const ASSERTION_MODULES = [
  '@playwright/test',
  'canary-lab/feature-support/log-marker-fixture',
  'vitest',
  '@jest/globals',
  'expect',
] as const

function moduleMatches(candidate: string, registered: string): boolean {
  return candidate === registered || candidate.startsWith(`${registered}/`)
}

function comesFrom(call: CanonicalCall, modules: readonly string[]): boolean {
  return call.symbolEvidence.modules.some(
    (candidate) => modules.some((registered) => moduleMatches(candidate, registered)),
  )
}

function uniqueByPrecedence(categories: Iterable<ReadableSemanticCategory>): ReadableSemanticCategory[] {
  const set = new Set(categories)
  return SEMANTIC_PRECEDENCE.filter((category) => set.has(category))
}

function builtInRules(config: ReadableSemanticRuleConfig): SemanticRule[] {
  const apiModules = [...KNOWN_API_MODULES, ...(config.apiClients ?? [])]
  const databaseModules = [...KNOWN_DATABASE_MODULES, ...(config.databaseClients ?? [])]
  return [
    {
      id: 'expect-assertion',
      category: 'assertion',
      match: (call) => (
        call.calleePath.length >= 2
        && (
          call.rootName === 'expect'
            && (!call.symbolEvidence.declaredInSource || comesFrom(call, ASSERTION_MODULES))
          || comesFrom(call, ASSERTION_MODULES)
            && call.symbolEvidence.importedNames.includes('expect')
        )
      ),
    },
    {
      id: 'fetch-api',
      category: 'external-api',
      match: (call) => call.rootName === 'fetch' && !call.symbolEvidence.declaredInSource,
    },
    {
      id: 'playwright-request-fixture',
      category: 'external-api',
      match: (call) => (
        call.symbolEvidence.fixture === 'request'
        && comesFrom(call, ['@playwright/test'])
      ),
    },
    {
      id: 'playwright-api-request-context',
      category: 'external-api',
      match: (call) => (
        comesFrom(call, ['@playwright/test'])
        && call.symbolEvidence.importedNames.includes('APIRequestContext')
      ),
    },
    {
      id: 'known-api-module',
      category: 'external-api',
      match: (call) => comesFrom(call, apiModules),
    },
    {
      id: 'known-database-module',
      category: 'database',
      match: (call) => comesFrom(call, databaseModules),
    },
    {
      id: 'filesystem-module',
      category: 'filesystem',
      match: (call) => comesFrom(call, FILESYSTEM_MODULES),
    },
    {
      id: 'console-logging',
      category: 'logging',
      match: (call) => call.rootName === 'console' && !call.symbolEvidence.declaredInSource,
    },
  ]
}

export function createSemanticRuleRegistry(
  config: ReadableSemanticRuleConfig = {},
  extraRules: readonly SemanticRule[] = [],
): SemanticRuleRegistry {
  const rules = [...builtInRules(config), ...extraRules]
  return {
    rules,
    classifyCall(call) {
      return uniqueByPrecedence([
        ...rules.filter((rule) => rule.match(call)).map((rule) => rule.category),
        'function-call',
      ])
    },
  }
}

export function classifyExpression(
  expression: CanonicalExpression,
  registry: SemanticRuleRegistry,
): ReadableSemanticCategory[] {
  switch (expression.kind) {
    case 'await':
      return uniqueByPrecedence(['async', ...classifyExpression(expression.expression, registry)])
    case 'call':
      return uniqueByPrecedence([
        ...registry.classifyCall(expression),
        ...classifyExpression(expression.callee, registry),
        ...expression.arguments.flatMap((argument) => classifyExpression(argument, registry)),
      ])
    case 'member-access':
      return classifyExpression(expression.owner, registry)
    case 'element-access':
      return uniqueByPrecedence([
        ...classifyExpression(expression.owner, registry),
        ...classifyExpression(expression.element, registry),
      ])
    case 'binary':
      return uniqueByPrecedence([
        ...(expression.operator === ts.SyntaxKind.EqualsToken
          || expression.operator >= ts.SyntaxKind.FirstCompoundAssignment
          && expression.operator <= ts.SyntaxKind.LastCompoundAssignment
          ? ['assignment' as const]
          : []),
        ...classifyExpression(expression.left, registry),
        ...classifyExpression(expression.right, registry),
      ])
    case 'arrow-function':
      return expression.expressionBody
        ? classifyExpression(expression.expressionBody, registry)
        : []
    case 'identifier':
    case 'literal':
    case 'source-expression':
      return []
  }
}

export function highestPrecedenceCategory(
  categories: readonly ReadableSemanticCategory[],
): ReadableSemanticCategory | undefined {
  const set = new Set(categories)
  return SEMANTIC_PRECEDENCE.find((category) => set.has(category))
}
