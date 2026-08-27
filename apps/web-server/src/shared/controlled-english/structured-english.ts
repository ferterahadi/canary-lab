import ts from 'typescript'
import type {
  ReadableEnglishBlock,
  ReadableEnglishSpan,
  ReadableSemanticCategory,
  ReadableSyntaxCategory,
} from '../../../../../shared/readable-tests/types'
import {
  canonicalCodeExpression,
  canonicalStatement,
  type CanonicalCall,
  type CanonicalExpression,
  type CanonicalStatement,
} from './canonical-ir'
import {
  BINARY_OPERATOR_PHRASES,
  COMPOUND_ASSIGNMENT_PHRASES,
} from './ast-to-ir'
import {
  SEMANTIC_PRECEDENCE,
  classifyExpression,
  createSemanticRuleRegistry,
  type SemanticRuleRegistry,
} from './semantic-rules'
import type { SemanticContext } from './semantic-context'

interface AssertionRule {
  matcher: string
  expectedArguments: 0 | 1
  relation: string
  negatedRelation: string
}

/** Explicit matcher meanings. An unknown matcher remains a normal call. */
export const ASSERTION_RULES: readonly AssertionRule[] = [
  { matcher: 'toBe', expectedArguments: 1, relation: 'equals', negatedRelation: 'does not equal' },
  { matcher: 'toEqual', expectedArguments: 1, relation: 'deeply equals', negatedRelation: 'does not deeply equal' },
  { matcher: 'toStrictEqual', expectedArguments: 1, relation: 'strictly equals', negatedRelation: 'does not strictly equal' },
  { matcher: 'toContain', expectedArguments: 1, relation: 'contains', negatedRelation: 'does not contain' },
  { matcher: 'toContainEqual', expectedArguments: 1, relation: 'contains an item equal to', negatedRelation: 'does not contain an item equal to' },
  { matcher: 'toMatch', expectedArguments: 1, relation: 'matches', negatedRelation: 'does not match' },
  { matcher: 'toMatchObject', expectedArguments: 1, relation: 'includes', negatedRelation: 'does not include' },
  { matcher: 'toHaveText', expectedArguments: 1, relation: 'has text', negatedRelation: 'does not have text' },
  { matcher: 'toContainText', expectedArguments: 1, relation: 'contains text', negatedRelation: 'does not contain text' },
  { matcher: 'toHaveValue', expectedArguments: 1, relation: 'has value', negatedRelation: 'does not have value' },
  { matcher: 'toHaveCount', expectedArguments: 1, relation: 'has count', negatedRelation: 'does not have count' },
  { matcher: 'toHaveLength', expectedArguments: 1, relation: 'has length', negatedRelation: 'does not have length' },
  { matcher: 'toHaveURL', expectedArguments: 1, relation: 'has URL', negatedRelation: 'does not have URL' },
  { matcher: 'toHaveTitle', expectedArguments: 1, relation: 'has title', negatedRelation: 'does not have title' },
  { matcher: 'toBeGreaterThan', expectedArguments: 1, relation: 'is greater than', negatedRelation: 'is not greater than' },
  { matcher: 'toBeGreaterThanOrEqual', expectedArguments: 1, relation: 'is greater than or equal to', negatedRelation: 'is not greater than or equal to' },
  { matcher: 'toBeLessThan', expectedArguments: 1, relation: 'is less than', negatedRelation: 'is not less than' },
  { matcher: 'toBeLessThanOrEqual', expectedArguments: 1, relation: 'is less than or equal to', negatedRelation: 'is not less than or equal to' },
  { matcher: 'toBeInstanceOf', expectedArguments: 1, relation: 'is an instance of', negatedRelation: 'is not an instance of' },
  { matcher: 'toBeTruthy', expectedArguments: 0, relation: 'is truthy', negatedRelation: 'is falsy' },
  { matcher: 'toBeFalsy', expectedArguments: 0, relation: 'is falsy', negatedRelation: 'is truthy' },
  { matcher: 'toBeDefined', expectedArguments: 0, relation: 'is defined', negatedRelation: 'is undefined' },
  { matcher: 'toBeUndefined', expectedArguments: 0, relation: 'is undefined', negatedRelation: 'is defined' },
  { matcher: 'toBeNull', expectedArguments: 0, relation: 'is null', negatedRelation: 'is not null' },
  { matcher: 'toBeNaN', expectedArguments: 0, relation: 'is NaN', negatedRelation: 'is not NaN' },
  { matcher: 'toBeVisible', expectedArguments: 0, relation: 'is visible', negatedRelation: 'is not visible' },
  { matcher: 'toBeHidden', expectedArguments: 0, relation: 'is hidden', negatedRelation: 'is not hidden' },
  { matcher: 'toBeEnabled', expectedArguments: 0, relation: 'is enabled', negatedRelation: 'is not enabled' },
  { matcher: 'toBeDisabled', expectedArguments: 0, relation: 'is disabled', negatedRelation: 'is not disabled' },
  { matcher: 'toBeChecked', expectedArguments: 0, relation: 'is checked', negatedRelation: 'is not checked' },
  { matcher: 'toBeEditable', expectedArguments: 0, relation: 'is editable', negatedRelation: 'is not editable' },
  { matcher: 'toBeEmpty', expectedArguments: 0, relation: 'is empty', negatedRelation: 'is not empty' },
  { matcher: 'toBeFocused', expectedArguments: 0, relation: 'is focused', negatedRelation: 'is not focused' },
  { matcher: 'toBeAttached', expectedArguments: 0, relation: 'is attached', negatedRelation: 'is not attached' },
  { matcher: 'toBeOK', expectedArguments: 0, relation: 'is successful', negatedRelation: 'is not successful' },
]

const ASSERTION_RULE_BY_MATCHER = new Map(
  ASSERTION_RULES.map((rule) => [rule.matcher, rule] as const),
)
const SEMANTIC_REGISTRY_BY_CONTEXT = new WeakMap<SemanticContext, SemanticRuleRegistry>()

function registryFor(context: SemanticContext): SemanticRuleRegistry {
  const existing = SEMANTIC_REGISTRY_BY_CONTEXT.get(context)
  if (existing) return existing
  const created = createSemanticRuleRegistry(context.config)
  SEMANTIC_REGISTRY_BY_CONTEXT.set(context, created)
  return created
}

function ordered(categories: Iterable<ReadableSemanticCategory>): ReadableSemanticCategory[] {
  const set = new Set(categories)
  return SEMANTIC_PRECEDENCE.filter((category) => set.has(category))
}

function prose(
  text: string,
  semanticCategories: readonly ReadableSemanticCategory[],
  syntaxCategory?: ReadableSyntaxCategory,
): ReadableEnglishSpan {
  return {
    text,
    ...(syntaxCategory ? { syntaxCategory } : {}),
    semanticCategories: ordered(semanticCategories),
  }
}

function code(
  expression: Pick<CanonicalExpression, 'code' | 'sourceRange'>,
  semanticCategories: readonly ReadableSemanticCategory[],
  syntaxCategory?: ReadableSyntaxCategory,
): ReadableEnglishSpan {
  return {
    text: expression.code,
    kind: 'code',
    ...(syntaxCategory ? { syntaxCategory } : {}),
    semanticCategories: ordered(semanticCategories),
    ...(expression.sourceRange ? { sourceRange: expression.sourceRange } : {}),
  }
}

export function renderEnglishSpans(spans: readonly ReadableEnglishSpan[]): string {
  return spans.map((span) => span.kind === 'code' ? `\`${span.text}\`` : span.text).join('')
}

function block(
  kind: ReadableEnglishBlock['kind'],
  spans: ReadableEnglishSpan[],
  categories: readonly ReadableSemanticCategory[],
  sourceRange?: ReadableEnglishBlock['sourceRange'],
): ReadableEnglishBlock {
  const sourceLinkedSpans = sourceRange
    ? spans.map((span) => span.sourceRange ? span : { ...span, sourceRange })
    : spans
  return {
    kind,
    text: renderEnglishSpans(sourceLinkedSpans),
    spans: sourceLinkedSpans,
    semanticCategories: ordered(categories),
    ...(sourceRange ? { sourceRange } : {}),
  }
}

function expressionCategories(
  expression: CanonicalExpression,
  registry: SemanticRuleRegistry,
): ReadableSemanticCategory[] {
  return classifyExpression(expression, registry)
}

function callInside(expression: CanonicalExpression): CanonicalCall | undefined {
  if (expression.kind === 'call') return expression
  if (expression.kind === 'await' && expression.expression.kind === 'call') return expression.expression
  return undefined
}

function findExpectCall(
  expression: CanonicalExpression,
  rootName: string,
): CanonicalCall | undefined {
  if (expression.kind === 'call' && expression.rootName === rootName) {
    if (expression.calleePath.at(-1) === rootName || expression.calleePath.at(-1) === 'soft') {
      return expression
    }
    return findExpectCall(expression.callee, rootName)
  }
  if (expression.kind === 'member-access') return findExpectCall(expression.owner, rootName)
  if (expression.kind === 'element-access') return findExpectCall(expression.owner, rootName)
  return undefined
}

function assertionEnglish(
  expression: CanonicalExpression,
  registry: SemanticRuleRegistry,
): ReadableEnglishBlock | undefined {
  const awaited = expression.kind === 'await'
  const outer = awaited ? expression.expression : expression
  if (outer.kind !== 'call' || !outer.rootName) return undefined
  const matcher = outer.calleePath.at(-1)
  const rule = matcher ? ASSERTION_RULE_BY_MATCHER.get(matcher) : undefined
  const expectCall = findExpectCall(outer.callee, outer.rootName)
  const actual = expectCall?.arguments[0]
  const modifiers = outer.calleePath.slice(1, -1)
  const supportedModifiers = modifiers.every((modifier) => modifier === 'soft' || modifier === 'not')
    && modifiers.filter((modifier) => modifier === 'soft').length <= 1
    && modifiers.filter((modifier) => modifier === 'not').length <= 1
  if (
    !rule
    || !actual
    || !expectCall
    || expectCall.arguments.length !== 1
    || outer.arguments.length !== rule.expectedArguments
    || !supportedModifiers
    || !registry.classifyCall(outer).includes('assertion')
  ) return undefined

  const negated = outer.calleePath.includes('not')
  const assertionCategories: ReadableSemanticCategory[] = awaited
    ? ['assertion', 'async']
    : ['assertion']
  const actualCategories = expressionCategories(actual, registry)
  const spans: ReadableEnglishSpan[] = [
    prose(awaited ? 'Await the check that ' : 'Check that ', assertionCategories, 'keyword'),
    code(actual, actualCategories, actual.syntaxCategory),
    prose(` ${negated ? rule.negatedRelation : rule.relation}`, ['assertion'], 'operator'),
  ]
  const expected = rule.expectedArguments === 1 ? outer.arguments[0] : undefined
  const expectedCategories = expected ? expressionCategories(expected, registry) : []
  if (expected) {
    spans.push(prose(' ', ['assertion']))
    spans.push(code(expected, expectedCategories, expected.syntaxCategory))
  }
  spans.push(prose('.', ['assertion']))
  return block(
    'sentence',
    spans,
    ordered([
      ...assertionCategories,
      ...actualCategories,
      ...expectedCategories,
    ]),
    expression.sourceRange,
  )
}

function declarationEnglish(
  statement: Extract<CanonicalStatement, { kind: 'declaration' }>,
  registry: SemanticRuleRegistry,
): ReadableEnglishBlock | undefined {
  if (statement.bindings.length !== 1) return undefined
  const item = statement.bindings[0]
  const categories: ReadableSemanticCategory[] = ['declaration']
  const spans: ReadableEnglishSpan[] = []
  const initializer = item.initializer
  if (!initializer) {
    spans.push(prose('Declare ', ['declaration'], 'keyword'))
    spans.push(prose(`${statement.declarationKind} `, ['declaration']))
    spans.push(code(item.binding, [], 'identifier'))
  } else if (initializer.kind === 'await') {
    const nestedCategories = expressionCategories(initializer.expression, registry)
    categories.push('async', ...nestedCategories)
    spans.push(prose('Await ', ['async'], 'keyword'))
    spans.push(code(initializer.expression, nestedCategories, initializer.expression.syntaxCategory))
    spans.push(prose(` and store the result in ${statement.declarationKind} `, ['declaration']))
    spans.push(code(item.binding, [], 'identifier'))
  } else if (initializer.kind === 'call') {
    const nestedCategories = expressionCategories(initializer, registry)
    categories.push(...nestedCategories)
    spans.push(prose('Call ', ['function-call'], 'keyword'))
    spans.push(code(initializer, nestedCategories, initializer.syntaxCategory))
    spans.push(prose(` and store the result in ${statement.declarationKind} `, ['declaration']))
    spans.push(code(item.binding, [], 'identifier'))
  } else {
    const nestedCategories = expressionCategories(initializer, registry)
    categories.push(...nestedCategories)
    spans.push(prose('Store ', ['declaration'], 'keyword'))
    spans.push(code(initializer, nestedCategories, initializer.syntaxCategory))
    spans.push(prose(` in ${statement.declarationKind} `, ['declaration']))
    spans.push(code(item.binding, [], 'identifier'))
  }
  if (item.type) {
    spans.push(prose(' with type ', ['declaration']))
    spans.push(code(item.type, [], 'type'))
  }
  spans.push(prose('.', ['declaration']))
  return block('sentence', spans, categories, statement.sourceRange)
}

function assignmentEnglish(
  expression: Extract<CanonicalExpression, { kind: 'binary' }>,
  registry: SemanticRuleRegistry,
): ReadableEnglishBlock | undefined {
  const leftCategories = expressionCategories(expression.left, registry)
  const rightCategories = expressionCategories(expression.right, registry)
  const nestedCategories = ordered(['assignment', ...leftCategories, ...rightCategories])
  if (expression.operator === ts.SyntaxKind.EqualsToken) {
    const spans = [
      prose('Set ', ['assignment'], 'keyword'),
      code(expression.left, leftCategories, expression.left.syntaxCategory),
      prose(' to ', ['assignment'], 'operator'),
      code(expression.right, rightCategories, expression.right.syntaxCategory),
      prose('.', ['assignment']),
    ]
    return block('sentence', spans, nestedCategories, expression.sourceRange)
  }
  const phrase = COMPOUND_ASSIGNMENT_PHRASES.get(expression.operator)
  if (!phrase) return undefined
  const spans = [
    prose(`${phrase[0].toUpperCase()}${phrase.slice(1)} `, ['assignment'], 'keyword'),
    code(expression.left, leftCategories, expression.left.syntaxCategory),
    prose(' using ', ['assignment'], 'operator'),
    code(expression.right, rightCategories, expression.right.syntaxCategory),
    prose('.', ['assignment']),
  ]
  return block('sentence', spans, nestedCategories, expression.sourceRange)
}

function expressionStatementEnglish(
  statement: Extract<CanonicalStatement, { kind: 'expression-statement' }>,
  registry: SemanticRuleRegistry,
): ReadableEnglishBlock | undefined {
  const assertion = assertionEnglish(statement.expression, registry)
  if (assertion) return assertion
  if (statement.expression.kind === 'binary') {
    const assignment = assignmentEnglish(statement.expression, registry)
    if (assignment) return assignment
  }
  const call = callInside(statement.expression)
  if (call) {
    const awaited = statement.expression.kind === 'await'
    const callCategories = expressionCategories(call, registry)
    const categories = ordered([
      ...(awaited ? ['async' as const] : []),
      ...callCategories,
    ])
    const arrow = call.arguments.length === 1 && call.arguments[0].kind === 'arrow-function'
      ? call.arguments[0]
      : undefined
    if (arrow?.expressionBody) {
      const bodyCategories = expressionCategories(arrow.expressionBody, registry)
      const calleeCategories = expressionCategories(call.callee, registry)
      return block('control-flow', [
        prose(awaited ? 'Await a call to ' : 'Call ', awaited ? ['async'] : ['function-call'], 'keyword'),
        code(call.callee, calleeCategories, call.callee.syntaxCategory),
        prose(' with an arrow function that:\n    Returns ', ['function-call']),
        code(arrow.expressionBody, bodyCategories, arrow.expressionBody.syntaxCategory),
        prose('.', ['function-call']),
      ], ordered([...categories, ...bodyCategories]), statement.sourceRange)
    }
    return block('sentence', [
      prose(awaited ? 'Await ' : 'Call ', awaited ? ['async'] : ['function-call'], 'keyword'),
      code(call, callCategories, 'function'),
      prose('.', awaited ? ['async'] : ['function-call']),
    ], categories, statement.sourceRange)
  }
  if (statement.expression.kind === 'await') {
    const categories = ordered(['async', ...expressionCategories(statement.expression.expression, registry)])
    return block('sentence', [
      prose('Await ', ['async'], 'keyword'),
      code(
        statement.expression.expression,
        expressionCategories(statement.expression.expression, registry),
        statement.expression.expression.syntaxCategory,
      ),
      prose('.', ['async']),
    ], categories, statement.sourceRange)
  }
  return undefined
}

function returnEnglish(
  statement: Extract<CanonicalStatement, { kind: 'return' }>,
  registry: SemanticRuleRegistry,
): ReadableEnglishBlock {
  const expressionCategoriesValue = statement.expression
    ? expressionCategories(statement.expression, registry)
    : []
  const spans = statement.expression
    ? [
        prose('Return ', ['return'], 'keyword'),
        code(statement.expression, expressionCategoriesValue, statement.expression.syntaxCategory),
        prose('.', ['return']),
      ]
    : [prose('Return.', ['return'], 'keyword')]
  return block('sentence', spans, ['return', ...expressionCategoriesValue], statement.sourceRange)
}

export function composeStatementEnglish(
  node: ts.Statement,
  context: SemanticContext,
): ReadableEnglishBlock | undefined {
  const statement = canonicalStatement(node, context)
  const registry = registryFor(context)
  switch (statement.kind) {
    case 'declaration': return declarationEnglish(statement, registry)
    case 'expression-statement': return expressionStatementEnglish(statement, registry)
    case 'return': return returnEnglish(statement, registry)
    case 'throw': {
      const categories = expressionCategories(statement.expression, registry)
      return block('sentence', [
        prose('Throw ', ['error-control-flow'], 'keyword'),
        code(statement.expression, categories, statement.expression.syntaxCategory),
        prose('.', ['error-control-flow']),
      ], ['error-control-flow', ...categories], statement.sourceRange)
    }
    case 'source-statement': return undefined
  }
}

function predicateSpans(
  expression: CanonicalExpression,
  registry: SemanticRuleRegistry,
  controlCategory: 'branch' | 'iteration',
): ReadableEnglishSpan[] {
  if (expression.kind === 'binary') {
    const phrase = CONTROL_FLOW_OPERATOR_PHRASES.get(expression.operator)
    if (phrase) {
      return [
        code(
          expression.left,
          expressionCategories(expression.left, registry),
          expression.left.syntaxCategory,
        ),
        prose(` ${phrase} `, [controlCategory], 'operator'),
        code(
          expression.right,
          expressionCategories(expression.right, registry),
          expression.right.syntaxCategory,
        ),
      ]
    }
  }
  return [
    code(expression, expressionCategories(expression, registry), expression.syntaxCategory),
    prose(' is truthy', [controlCategory], 'operator'),
  ]
}

/** The exhaustive syntax renderer keeps its established vocabulary. Natural
 * control-flow sentences use the product's canonical predicate wording. */
const CONTROL_FLOW_OPERATOR_PHRASES: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  ...BINARY_OPERATOR_PHRASES,
  [ts.SyntaxKind.EqualsEqualsEqualsToken, 'strictly equals'],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, 'does not strictly equal'],
  [ts.SyntaxKind.EqualsEqualsToken, 'loosely equals'],
  [ts.SyntaxKind.ExclamationEqualsToken, 'does not loosely equal'],
])

export function composeIfHeader(node: ts.IfStatement, context: SemanticContext): ReadableEnglishBlock {
  const condition = canonicalCodeExpression(node.expression, context)
  const registry = registryFor(context)
  const categories = expressionCategories(condition, registry)
  return block('control-flow', [
    prose('If ', ['branch'], 'keyword'),
    ...predicateSpans(condition, registry, 'branch'),
    prose(':', ['branch']),
  ], ['branch', ...categories], context.absoluteSourceRanges
    ? { start: node.getStart(context.sourceFile), end: node.expression.getEnd() }
    : undefined)
}

export function composeIfPath(
  role: 'then' | 'otherwise',
  node: ts.Node,
  context: SemanticContext,
): ReadableEnglishBlock {
  const text = role === 'then' ? 'Then:' : 'Otherwise:'
  return block(
    'control-flow',
    [prose(text, ['branch'], 'keyword')],
    ['branch'],
    context.absoluteSourceRanges ? { start: node.getStart(context.sourceFile), end: node.getEnd() } : undefined,
  )
}

export function composeSwitchHeader(node: ts.SwitchStatement, context: SemanticContext): ReadableEnglishBlock {
  const expression = canonicalCodeExpression(node.expression, context)
  const categories = expressionCategories(expression, registryFor(context))
  return block('control-flow', [
    prose('Switch on ', ['branch'], 'keyword'),
    code(expression, categories, expression.syntaxCategory),
    prose(':', ['branch']),
  ], ['branch', ...categories], context.absoluteSourceRanges
    ? { start: node.getStart(context.sourceFile), end: node.expression.getEnd() }
    : undefined)
}

export function composeSwitchPath(
  node: ts.CaseOrDefaultClause,
  context: SemanticContext,
): ReadableEnglishBlock {
  if (ts.isDefaultClause(node)) {
    return block('control-flow', [prose('Otherwise:', ['branch'], 'keyword')], ['branch'],
      context.absoluteSourceRanges ? { start: node.getStart(context.sourceFile), end: node.getEnd() } : undefined)
  }
  const expression = canonicalCodeExpression(node.expression, context)
  const categories = expressionCategories(expression, registryFor(context))
  return block('control-flow', [
    prose('When ', ['branch'], 'keyword'),
    code(expression, categories, expression.syntaxCategory),
    prose(' matches:', ['branch'], 'operator'),
  ], ['branch', ...categories], context.absoluteSourceRanges
    ? { start: node.getStart(context.sourceFile), end: node.expression.getEnd() }
    : undefined)
}

export function composeTryHeader(node: ts.TryStatement, context: SemanticContext): ReadableEnglishBlock {
  return block('control-flow', [prose('Try:', ['error-control-flow'], 'keyword')], ['error-control-flow'],
    context.absoluteSourceRanges ? { start: node.getStart(context.sourceFile), end: node.tryBlock.getStart(context.sourceFile) } : undefined)
}

export function composeCatchHeader(node: ts.CatchClause, context: SemanticContext): ReadableEnglishBlock {
  const binding = node.variableDeclaration?.name
  const spans = [prose('Catch', ['error-control-flow'], 'keyword')]
  if (binding) {
    spans.push(prose(' error ', ['error-control-flow']))
    spans.push(code({
      code: binding.getText(context.sourceFile),
      ...(context.absoluteSourceRanges
        ? { sourceRange: { start: binding.getStart(context.sourceFile), end: binding.getEnd() } }
        : {}),
    }, [], 'identifier'))
  }
  spans.push(prose(':', ['error-control-flow']))
  return block('control-flow', spans, ['error-control-flow'], context.absoluteSourceRanges
    ? { start: node.getStart(context.sourceFile), end: node.block.getStart(context.sourceFile) }
    : undefined)
}

export function composeFinallyHeader(node: ts.Block, context: SemanticContext): ReadableEnglishBlock {
  return block('control-flow', [prose('Finally:', ['error-control-flow'], 'keyword')], ['error-control-flow'],
    context.absoluteSourceRanges ? { start: node.getStart(context.sourceFile), end: node.getEnd() } : undefined)
}

export function composeLoopHeader(
  node: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement | ts.WhileStatement | ts.DoStatement,
  context: SemanticContext,
): ReadableEnglishBlock {
  const registry = registryFor(context)
  const range = context.absoluteSourceRanges
    ? { start: node.getStart(context.sourceFile), end: node.statement.getStart(context.sourceFile) }
    : undefined
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const binding = node.initializer.getText(context.sourceFile)
      .replace(/^(?:const|let|var)\s+/, '')
    const source = canonicalCodeExpression(node.expression, context)
    const sourceCategories = expressionCategories(source, registry)
    const controlCategories: ReadableSemanticCategory[] = ts.isForOfStatement(node)
      && node.awaitModifier
      ? ['iteration', 'async']
      : ['iteration']
    const prefix = ts.isForOfStatement(node)
      ? node.awaitModifier ? 'For await each ' : 'For each '
      : 'For each key '
    return block('control-flow', [
      prose(prefix, controlCategories, 'keyword'),
      code({ code: binding }, [], 'identifier'),
      prose(' in ', ['iteration'], 'operator'),
      code(source, sourceCategories, source.syntaxCategory),
      prose(':', ['iteration']),
    ], [...controlCategories, ...sourceCategories], range)
  }
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    const condition = canonicalCodeExpression(node.expression, context)
    const conditionCategories = expressionCategories(condition, registry)
    return block('control-flow', [
      prose(ts.isWhileStatement(node) ? 'While ' : 'Repeat, then continue while ', ['iteration'], 'keyword'),
      ...predicateSpans(condition, registry, 'iteration'),
      prose(':', ['iteration']),
    ], ['iteration', ...conditionCategories], range)
  }
  const spans: ReadableEnglishSpan[] = [prose('Repeat', ['iteration'], 'keyword')]
  const categories: ReadableSemanticCategory[] = ['iteration']
  if (node.initializer) {
    spans.push(prose(' with setup ', ['iteration']))
    if (ts.isVariableDeclarationList(node.initializer)) {
      spans.push(code({ code: node.initializer.getText(context.sourceFile) }, [], 'identifier'))
    } else {
      const initializer = canonicalCodeExpression(node.initializer, context)
      const initializerCategories = expressionCategories(initializer, registry)
      categories.push(...initializerCategories)
      spans.push(code(initializer, initializerCategories, initializer.syntaxCategory))
    }
  }
  if (node.condition) {
    const condition = canonicalCodeExpression(node.condition, context)
    categories.push(...expressionCategories(condition, registry))
    spans.push(prose(', while ', ['iteration']))
    spans.push(...predicateSpans(condition, registry, 'iteration'))
  }
  if (node.incrementor) {
    const incrementor = canonicalCodeExpression(node.incrementor, context)
    const incrementorCategories = expressionCategories(incrementor, registry)
    categories.push(...incrementorCategories)
    spans.push(prose(', and after each pass ', ['iteration']))
    spans.push(code(incrementor, incrementorCategories, 'operator'))
  }
  spans.push(prose(':', ['iteration']))
  return block('control-flow', spans, categories, range)
}
