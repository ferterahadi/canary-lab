import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import type { ReadableFidelity } from '../../../../../shared/readable-tests/types'
import { humanizeIdentifier, identifierWords, readableObject } from './language'

export interface RenderedExpression {
  text: string
  fidelity: ReadableFidelity
}

interface RenderedPart extends RenderedExpression {
  compound: boolean
}

type ExpressionBindings = ReadonlyMap<string, string>

const NO_BINDINGS: ExpressionBindings = new Map()

/** Dotted call-target path (`expect.any`, `JSON.stringify`), or undefined for
 *  anything dynamic. Raw identifier text, never humanized — it's a lookup key. */
export function expressionPath(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) {
    const owner = expressionPath(node.expression)
    return owner ? `${owner}.${node.name.text}` : undefined
  }
  return undefined
}

// Calls whose result is a fresh value with a stable meaning. Describing the
// value ("a new unique identifier") is faithful; naming the mechanism is not
// what a reader needs.
const VALUE_GENERATOR_CALLS = new Map<string, string>([
  ['uuidv4', 'a new unique identifier'],
  ['randomUUID', 'a new unique identifier'],
  ['crypto.randomUUID', 'a new unique identifier'],
  ['Date.now', 'the current time'],
  ['Math.random', 'a random number'],
])

// Zero-argument methods that reshape their receiver without side effects.
const CONVERSION_METHOD_TEXT = new Map<string, string>([
  ['toLowerCase', '{owner} in lowercase'],
  ['toUpperCase', '{owner} in uppercase'],
  ['trim', '{owner} without surrounding spaces'],
  ['getTime', '{owner} as a timestamp'],
  ['toISOString', '{owner} as an ISO timestamp'],
  ['toString', '{owner} as text'],
  ['json', 'the JSON body of {owner}'],
  ['text', 'the text body of {owner}'],
])

// One-argument membership/shape predicates common in test conditions.
const RELATION_METHOD_TEXT = new Map<string, string>([
  ['includes', '{owner} contains {value}'],
  ['has', '{owner} contains {value}'],
  ['startsWith', '{owner} starts with {value}'],
  ['endsWith', '{owner} ends with {value}'],
])

// Asymmetric expect matchers used inside expected payloads.
const EXPECT_MATCHER_TEXT = new Map<string, string>([
  ['any', 'any {value}'],
  ['anything', 'anything'],
  ['stringContaining', 'text containing {value}'],
  ['stringMatching', 'text matching {value}'],
  ['objectContaining', 'an object containing {value}'],
  ['arrayContaining', 'a list containing {value}'],
])

const OBJECT_INSPECTION_TEXT = new Map<string, string>([
  ['Object.keys', 'the keys of {value}'],
  ['Object.values', 'the values of {value}'],
  ['Object.entries', 'the entries of {value}'],
])

// Read-style verbs whose call result is safely described as the thing read:
// `getBaseUrl()` means "the base url" to a reader, not a procedure.
const GETTER_VERBS = new Set(['get', 'read', 'fetch', 'load', 'query', 'find'])

const BINARY_OPERATORS = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.EqualsEqualsToken, 'equals'],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, 'equals'],
  [ts.SyntaxKind.ExclamationEqualsToken, 'does not equal'],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, 'does not equal'],
  [ts.SyntaxKind.LessThanToken, 'is less than'],
  [ts.SyntaxKind.LessThanEqualsToken, 'is at most'],
  [ts.SyntaxKind.GreaterThanToken, 'is greater than'],
  [ts.SyntaxKind.GreaterThanEqualsToken, 'is at least'],
  [ts.SyntaxKind.AmpersandAmpersandToken, 'and'],
  [ts.SyntaxKind.BarBarToken, 'or'],
  [ts.SyntaxKind.QuestionQuestionToken, 'or, when missing,'],
  [ts.SyntaxKind.PlusToken, 'plus'],
  [ts.SyntaxKind.MinusToken, 'minus'],
  [ts.SyntaxKind.AsteriskToken, 'multiplied by'],
  [ts.SyntaxKind.SlashToken, 'divided by'],
  [ts.SyntaxKind.PercentToken, 'modulo'],
  [ts.SyntaxKind.AsteriskAsteriskToken, 'raised to'],
  [ts.SyntaxKind.InKeyword, 'is in'],
  [ts.SyntaxKind.InstanceOfKeyword, 'is an instance of'],
])

function mergeFidelity(parts: RenderedExpression[], fallback: ReadableFidelity = 'derived'): ReadableFidelity {
  if (parts.some((part) => part.fidelity === 'unresolved')) return 'unresolved'
  if (parts.every((part) => part.fidelity === 'exact')) return fallback
  return 'derived'
}

export function quoteReadableText(value: string): string {
  return `“${value.replace(/“/g, '\\“').replace(/”/g, '\\”')}”`
}

function unresolved(node: ts.Node, sourceFile: ts.SourceFile): RenderedPart {
  return {
    text: formatSourceSnippetForDisplay(node.getText(sourceFile)),
    fidelity: 'unresolved',
    compound: false,
  }
}

function childText(part: RenderedPart): string {
  return part.compound ? `(${part.text})` : part.text
}

function renderPropertyName(name: ts.PropertyName, sourceFile: ts.SourceFile): RenderedExpression {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return { text: humanizeIdentifier(name.text), fidelity: 'derived' }
  }
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return { text: name.text, fidelity: 'exact' }
  }
  return { text: formatSourceSnippetForDisplay(name.getText(sourceFile)), fidelity: 'unresolved' }
}

function renderTemplate(
  node: ts.TemplateExpression,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart {
  const parts: RenderedExpression[] = []
  let text = node.head.text
  for (const span of node.templateSpans) {
    const rendered = renderPart(span.expression, sourceFile, bindings)
    parts.push(rendered)
    text += `{${rendered.text}}${span.literal.text}`
  }
  return {
    text: quoteReadableText(text),
    fidelity: mergeFidelity(parts),
    compound: false,
  }
}

function renderArray(
  node: ts.ArrayLiteralExpression,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart {
  if (!node.elements.length) return { text: 'an empty list', fidelity: 'derived', compound: false }
  const elements = node.elements.map((element) => {
    if (!ts.isSpreadElement(element)) return renderPart(element, sourceFile, bindings)
    const spread = renderPart(element.expression, sourceFile, bindings)
    return spread.fidelity === 'unresolved'
      ? spread
      : { text: `all items of ${spread.text}`, fidelity: spread.fidelity, compound: false }
  })
  if (elements.some((element) => element.fidelity === 'unresolved')) return unresolved(node, sourceFile)
  return {
    text: `a list containing ${elements.map((element) => element.text).join(', ')}`,
    fidelity: 'derived',
    compound: false,
  }
}

function renderObject(
  node: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart {
  if (!node.properties.length) return { text: 'an empty object', fidelity: 'derived', compound: false }
  const properties: RenderedExpression[] = []
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = renderPropertyName(property.name, sourceFile)
      const value = renderPart(property.initializer, sourceFile, bindings)
      properties.push({
        text: `${name.text} set to ${value.text}`,
        fidelity: mergeFidelity([name, value]),
      })
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      properties.push({ text: humanizeIdentifier(property.name.text), fidelity: 'derived' })
      continue
    }
    if (ts.isSpreadAssignment(property)) {
      const spread = renderPart(property.expression, sourceFile, bindings)
      if (spread.fidelity === 'unresolved') return unresolved(node, sourceFile)
      properties.push({ text: `everything in ${spread.text}`, fidelity: spread.fidelity })
      continue
    }
    return unresolved(node, sourceFile)
  }
  if (properties.some((property) => property.fidelity === 'unresolved')) return unresolved(node, sourceFile)
  return {
    text: `an object with ${properties.map((property) => property.text).join(', ')}`,
    fidelity: 'derived',
    compound: false,
  }
}

function renderedArguments(
  callArguments: readonly ts.Expression[],
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart[] | undefined {
  const rendered = callArguments.map((argument) => renderPart(argument, sourceFile, bindings))
  return rendered.some((argument) => argument.fidelity === 'unresolved') ? undefined : rendered
}

function predicateBody(callback: ts.Expression): { parameter: string; body: ts.Expression } | undefined {
  let expression = callback
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return undefined
  if (expression.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined
  if (ts.isFunctionExpression(expression) && expression.asteriskToken) return undefined
  if (expression.parameters.length !== 1) return undefined
  const [parameter] = expression.parameters
  if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) return undefined
  if (!ts.isBlock(expression.body)) return { parameter: parameter.name.text, body: expression.body }
  if (expression.body.statements.length !== 1) return undefined
  const [statement] = expression.body.statements
  if (!ts.isReturnStatement(statement) || !statement.expression) return undefined
  return { parameter: parameter.name.text, body: statement.expression }
}

function preservePredicateIdentifierNames(node: ts.Node, bindings: Map<string, string>): void {
  if (ts.isIdentifier(node) && !bindings.has(node.text)) bindings.set(node.text, node.text)
  ts.forEachChild(node, (child) => preservePredicateIdentifierNames(child, bindings))
}

function renderCollectionPredicate(
  node: ts.CallExpression,
  method: string,
  ownerExpression: ts.Expression,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart | undefined {
  if ((method !== 'every' && method !== 'some') || node.arguments.length !== 1) return undefined
  const callback = predicateBody(node.arguments[0])
  if (!callback) return undefined
  const owner = renderPart(ownerExpression, sourceFile, bindings)
  if (owner.fidelity === 'unresolved') return undefined
  const callbackBindings = new Map(bindings)
  // Keep free variables recognizable (`txId`, `EXPECTED_STATUS`) while giving
  // the callback's local parameter a generic, project-independent name.
  preservePredicateIdentifierNames(callback.body, callbackBindings)
  callbackBindings.set(callback.parameter, 'item')
  const predicate = renderPart(callback.body, sourceFile, callbackBindings)
  if (predicate.fidelity === 'unresolved') return undefined
  const quantifier = method === 'every' ? 'every' : 'at least one'
  return {
    text: `for ${quantifier} item in ${childText(owner)}, ${predicate.text}`,
    fidelity: 'derived',
    compound: true,
  }
}

/** Calls whose *result* has a describable meaning render as that meaning;
 *  everything else returns undefined and stays as source. */
function renderCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart | undefined {
  const path = expressionPath(node.expression)
  if (path) {
    const generated = VALUE_GENERATOR_CALLS.get(path)
    if (generated && node.arguments.length === 0) return { text: generated, fidelity: 'derived', compound: false }

    const matcher = path.startsWith('expect.') ? EXPECT_MATCHER_TEXT.get(path.slice('expect.'.length)) : undefined
    if (matcher === 'anything' && node.arguments.length === 0) return { text: matcher, fidelity: 'derived', compound: false }
    if (matcher && matcher !== 'anything' && node.arguments.length === 1) {
      const value = renderPart(node.arguments[0], sourceFile, bindings)
      if (value.fidelity !== 'unresolved') {
        return { text: matcher.replace('{value}', value.text), fidelity: 'derived', compound: false }
      }
    }

    if (path === 'JSON.parse' && node.arguments.length === 1) {
      const value = renderPart(node.arguments[0], sourceFile, bindings)
      if (value.fidelity !== 'unresolved') {
        return { text: `${childText(value)} parsed as JSON`, fidelity: 'derived', compound: false }
      }
    }
    if (path === 'JSON.stringify' && node.arguments.length >= 1) {
      // A replacer argument changes what gets serialized; only formatting-only
      // calls (no replacer, or an inert null/undefined one) are safe to reword.
      const replacer = node.arguments[1]
      const replacerIsInert = !replacer
        || replacer.kind === ts.SyntaxKind.NullKeyword
        || (ts.isIdentifier(replacer) && replacer.text === 'undefined')
      if (replacerIsInert) {
        const value = renderPart(node.arguments[0], sourceFile, bindings)
        if (value.fidelity !== 'unresolved') {
          return { text: `${childText(value)} as JSON text`, fidelity: 'derived', compound: false }
        }
      }
    }

    const inspection = OBJECT_INSPECTION_TEXT.get(path)
    if (inspection && node.arguments.length === 1) {
      const value = renderPart(node.arguments[0], sourceFile, bindings)
      if (value.fidelity !== 'unresolved') {
        return { text: inspection.replace('{value}', childText(value)), fidelity: 'derived', compound: false }
      }
    }
  }

  if (ts.isIdentifier(node.expression)) {
    const words = identifierWords(node.expression.text)
    if (words.length > 1 && GETTER_VERBS.has(words[0])) {
      const object = readableObject(words.slice(1))
      const callArguments = renderedArguments(node.arguments, sourceFile, bindings)
      if (object && callArguments) {
        const text = callArguments.length
          ? `the ${object} for ${callArguments.map((argument) => argument.text).join(' and ')}`
          : `the ${object}`
        return { text, fidelity: 'derived', compound: false }
      }
    }
  }

  if (ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text
    const collectionPredicate = renderCollectionPredicate(
      node,
      method,
      node.expression.expression,
      sourceFile,
      bindings,
    )
    if (collectionPredicate) return collectionPredicate
    if (method === 'toString' && node.arguments.length === 1) {
      const owner = renderPart(node.expression.expression, sourceFile, bindings)
      const radix = renderPart(node.arguments[0], sourceFile, bindings)
      if (owner.fidelity !== 'unresolved' && radix.fidelity !== 'unresolved') {
        return {
          text: `${childText(owner)} as base ${childText(radix)} text`,
          fidelity: mergeFidelity([owner, radix]),
          compound: false,
        }
      }
    }
    if (method === 'slice' && (node.arguments.length === 1 || node.arguments.length === 2)) {
      const owner = renderPart(node.expression.expression, sourceFile, bindings)
      const bounds = renderedArguments(node.arguments, sourceFile, bindings)
      if (owner.fidelity !== 'unresolved' && bounds) {
        return {
          text: `${childText(owner)} sliced from ${childText(bounds[0])}${bounds[1] ? ` to ${childText(bounds[1])}` : ''}`,
          fidelity: mergeFidelity([owner, ...bounds]),
          compound: false,
        }
      }
    }
    const conversion = CONVERSION_METHOD_TEXT.get(method)
    if (conversion && node.arguments.length === 0) {
      const owner = renderPart(node.expression.expression, sourceFile, bindings)
      if (owner.fidelity !== 'unresolved') {
        return { text: conversion.replace('{owner}', childText(owner)), fidelity: 'derived', compound: false }
      }
    }
    const relation = RELATION_METHOD_TEXT.get(method)
    if (relation && node.arguments.length === 1) {
      const owner = renderPart(node.expression.expression, sourceFile, bindings)
      const value = renderPart(node.arguments[0], sourceFile, bindings)
      if (owner.fidelity !== 'unresolved' && value.fidelity !== 'unresolved') {
        return {
          text: relation.replace('{owner}', childText(owner)).replace('{value}', childText(value)),
          fidelity: 'derived',
          compound: true,
        }
      }
    }
  }

  return undefined
}

function renderNew(
  node: ts.NewExpression,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart | undefined {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'Date') return undefined
  const callArguments = renderedArguments(node.arguments ?? [], sourceFile, bindings)
  if (!callArguments) return undefined
  if (callArguments.length === 0) return { text: 'the current time', fidelity: 'derived', compound: false }
  if (callArguments.length === 1) return { text: `${childText(callArguments[0])} as a date`, fidelity: 'derived', compound: false }
  return undefined
}

function renderPart(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings = NO_BINDINGS,
): RenderedPart {
  if (ts.isStringLiteralLike(node)) {
    return { text: quoteReadableText(node.text), fidelity: 'exact', compound: false }
  }
  if (ts.isNumericLiteral(node)) {
    return { text: node.text, fidelity: 'exact', compound: false }
  }
  if (ts.isRegularExpressionLiteral(node)) {
    return { text: node.getText(sourceFile), fidelity: 'exact', compound: false }
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { text: 'true', fidelity: 'exact', compound: false }
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { text: 'false', fidelity: 'exact', compound: false }
  if (node.kind === ts.SyntaxKind.NullKeyword) return { text: 'null', fidelity: 'exact', compound: false }
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined') return { text: 'undefined', fidelity: 'exact', compound: false }
    const bound = bindings.get(node.text)
    if (bound) return { text: bound, fidelity: 'derived', compound: false }
    return { text: humanizeIdentifier(node.text), fidelity: 'derived', compound: false }
  }
  if (ts.isTemplateExpression(node)) return renderTemplate(node, sourceFile, bindings)
  if (ts.isParenthesizedExpression(node)) {
    const rendered = renderPart(node.expression, sourceFile, bindings)
    return { ...rendered, compound: true }
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return renderPart(node.expression, sourceFile, bindings)
  }
  if (ts.isAwaitExpression(node)) {
    const expression = renderPart(node.expression, sourceFile, bindings)
    return expression.fidelity === 'unresolved' ? unresolved(node, sourceFile) : expression
  }
  if (ts.isCallExpression(node)) {
    return renderCall(node, sourceFile, bindings) ?? unresolved(node, sourceFile)
  }
  if (ts.isNewExpression(node)) {
    return renderNew(node, sourceFile, bindings) ?? unresolved(node, sourceFile)
  }
  if (ts.isArrowFunction(node) && node.parameters.length === 0 && !ts.isBlock(node.body)) {
    const body = renderPart(node.body, sourceFile, bindings)
    if (body.fidelity !== 'unresolved') {
      return { text: `a function returning ${body.text}`, fidelity: 'derived', compound: false }
    }
  }
  if (ts.isPropertyAccessExpression(node)) {
    const owner = renderPart(node.expression, sourceFile, bindings)
    if (owner.fidelity === 'unresolved') return unresolved(node, sourceFile)
    const property = humanizeIdentifier(node.name.text)
    return {
      text: `${owner.text} ${property}${node.questionDotToken ? ', if available' : ''}`,
      fidelity: 'derived',
      compound: false,
    }
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression && (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))) {
    const owner = renderPart(node.expression, sourceFile, bindings)
    if (owner.fidelity === 'unresolved') return unresolved(node, sourceFile)
    return {
      text: `${owner.text} ${node.argumentExpression.text}${node.questionDotToken ? ', if available' : ''}`,
      fidelity: 'derived',
      compound: false,
    }
  }
  if (ts.isElementAccessExpression(node)) {
    const owner = renderPart(node.expression, sourceFile, bindings)
    const key = renderPart(node.argumentExpression, sourceFile, bindings)
    if (owner.fidelity === 'unresolved' || key.fidelity === 'unresolved') return unresolved(node, sourceFile)
    return {
      text: `${owner.text} at ${childText(key)}${node.questionDotToken ? ', if available' : ''}`,
      fidelity: 'derived',
      compound: false,
    }
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = renderPart(node.operand, sourceFile, bindings)
    if (operand.fidelity === 'unresolved') return unresolved(node, sourceFile)
    const operator = new Map<ts.PrefixUnaryOperator, string>([
      [ts.SyntaxKind.ExclamationToken, 'not'],
      [ts.SyntaxKind.PlusToken, 'positive'],
      [ts.SyntaxKind.MinusToken, 'negative'],
      [ts.SyntaxKind.TildeToken, 'bitwise not'],
    ]).get(node.operator)
    return operator
      ? { text: `${operator} ${childText(operand)}`, fidelity: 'derived', compound: true }
      : unresolved(node, sourceFile)
  }
  if (ts.isTypeOfExpression(node)) {
    const expression = renderPart(node.expression, sourceFile, bindings)
    return expression.fidelity === 'unresolved'
      ? unresolved(node, sourceFile)
      : { text: `the type of ${childText(expression)}`, fidelity: 'derived', compound: true }
  }
  if (ts.isBinaryExpression(node)) {
    const operator = BINARY_OPERATORS.get(node.operatorToken.kind)
    if (!operator) return unresolved(node, sourceFile)
    const left = renderPart(node.left, sourceFile, bindings)
    const right = renderPart(node.right, sourceFile, bindings)
    if (left.fidelity === 'unresolved' || right.fidelity === 'unresolved') return unresolved(node, sourceFile)
    return {
      text: `${childText(left)} ${operator} ${childText(right)}`,
      fidelity: 'derived',
      compound: true,
    }
  }
  if (ts.isConditionalExpression(node)) {
    const condition = renderPart(node.condition, sourceFile, bindings)
    const whenTrue = renderPart(node.whenTrue, sourceFile, bindings)
    const whenFalse = renderPart(node.whenFalse, sourceFile, bindings)
    if ([condition, whenTrue, whenFalse].some((part) => part.fidelity === 'unresolved')) return unresolved(node, sourceFile)
    return {
      text: `${whenTrue.text} when ${condition.text}; otherwise ${whenFalse.text}`,
      fidelity: 'derived',
      compound: true,
    }
  }
  if (ts.isArrayLiteralExpression(node)) return renderArray(node, sourceFile, bindings)
  if (ts.isObjectLiteralExpression(node)) return renderObject(node, sourceFile, bindings)
  return unresolved(node, sourceFile)
}

/** Renders syntax only. The source is never evaluated, imported, or executed. */
export function renderExpression(node: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression {
  const { compound: _compound, ...rendered } = renderPart(node, sourceFile)
  return rendered
}

export function renderCondition(node: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression {
  return renderExpression(node, sourceFile)
}
