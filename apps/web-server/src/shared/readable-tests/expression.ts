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

/** Keeps member boundaries visible without erasing optional-access semantics. */
export function exactPropertyAccessPath(node: ts.Expression): string | undefined {
  let property = node
  while (
    ts.isParenthesizedExpression(property)
    || ts.isAsExpression(property)
    || ts.isTypeAssertionExpression(property)
    || ts.isNonNullExpression(property)
    || ts.isSatisfiesExpression(property)
  ) property = property.expression
  if (!ts.isPropertyAccessExpression(property)) return undefined

  let owner: ts.Expression = property
  while (ts.isPropertyAccessExpression(owner)) {
    if (owner.questionDotToken) return undefined
    owner = owner.expression
  }
  return expressionPath(property)
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

// Zero-argument methods whose result has one stable, side-effect-free meaning.
const ZERO_ARGUMENT_METHOD_TEXT = new Map<string, string>([
  ['toLowerCase', '{owner} in lowercase'],
  ['toUpperCase', '{owner} in uppercase'],
  ['trim', '{owner} without surrounding spaces'],
  ['getTime', '{owner} as a timestamp'],
  ['toISOString', '{owner} as an ISO timestamp'],
  ['toString', '{owner} as text'],
  ['json', 'the JSON body of {owner}'],
  ['text', 'the text body of {owner}'],
  ['status', '{owner} status'],
  ['url', '{owner} URL'],
  ['ok', 'whether {owner} is successful'],
  ['headers', 'the headers of {owner}'],
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
  ['Array.isArray', '{value} is a list'],
])

// Standard URI codecs have deterministic value semantics. Supporting them in
// the shared expression renderer also keeps calls nested inside URL templates
// readable, instead of dropping the whole HTTP action from the concise story.
const URI_CODEC_TEXT = new Map<string, string>([
  ['encodeURI', '{value} encoded for a URL'],
  ['decodeURI', '{value} decoded from a URL'],
  ['encodeURIComponent', '{value} encoded for a URL component'],
  ['decodeURIComponent', '{value} decoded from a URL component'],
])

const STANDARD_CONVERSION_TEXT = new Map<string, string>([
  ['String', '{value} as text'],
  ['Number', '{value} as a number'],
  ['Boolean', '{value} as a boolean'],
  ['BigInt', '{value} as a big integer'],
])

const MATH_CALL_TEXT = new Map<string, string>([
  ['Math.abs', 'the absolute value of {value}'],
  ['Math.ceil', '{value} rounded up'],
  ['Math.floor', '{value} rounded down'],
  ['Math.round', '{value} rounded to the nearest integer'],
  ['Math.trunc', 'the integer part of {value}'],
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
  [ts.SyntaxKind.LessThanLessThanToken, 'shifted left by'],
  [ts.SyntaxKind.GreaterThanGreaterThanToken, 'shifted right by'],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, 'unsigned-shifted right by'],
  [ts.SyntaxKind.AmpersandToken, 'bitwise AND'],
  [ts.SyntaxKind.BarToken, 'bitwise OR'],
  [ts.SyntaxKind.CaretToken, 'bitwise XOR'],
  [ts.SyntaxKind.CommaToken, 'then'],
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

function renderPropertyName(
  name: ts.PropertyName,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedExpression {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return { text: humanizeIdentifier(name.text), fidelity: 'derived' }
  }
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) || ts.isBigIntLiteral(name)) {
    return { text: name.text, fidelity: 'exact' }
  }
  // PropertyName has no remaining source-authored variant after the literal
  // and identifier returns above, so TypeScript narrows this to computed.
  const expression = renderPart(name.expression, sourceFile, bindings)
  if (expression.fidelity !== 'unresolved') {
    return { text: `property named by ${expression.text}`, fidelity: 'derived' }
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
      const name = renderPropertyName(property.name, sourceFile, bindings)
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

interface SafeCallbackExpression {
  parameters: string[]
  body: ts.Expression
}

function safeCallbackExpression(
  callback: ts.Expression,
  parameterCount: number | readonly [minimum: number, maximum: number],
): SafeCallbackExpression | undefined {
  let expression = callback
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return undefined
  if (expression.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined
  if (ts.isFunctionExpression(expression) && expression.asteriskToken) return undefined
  const minimum = typeof parameterCount === 'number' ? parameterCount : parameterCount[0]
  const maximum = typeof parameterCount === 'number' ? parameterCount : parameterCount[1]
  if (expression.parameters.length < minimum || expression.parameters.length > maximum) return undefined
  const parameters = expression.parameters.flatMap((parameter) => (
    ts.isIdentifier(parameter.name) && !parameter.initializer && !parameter.dotDotDotToken
      ? [parameter.name.text]
      : []
  ))
  if (parameters.length !== expression.parameters.length) return undefined
  if (!ts.isBlock(expression.body)) return { parameters, body: expression.body }
  if (expression.body.statements.length !== 1) return undefined
  const [statement] = expression.body.statements
  if (!ts.isReturnStatement(statement) || !statement.expression) return undefined
  return { parameters, body: statement.expression }
}

function preservePredicateIdentifierNames(node: ts.Node, bindings: Map<string, string>): void {
  if (ts.isIdentifier(node) && !bindings.has(node.text)) bindings.set(node.text, node.text)
  ts.forEachChild(node, (child) => preservePredicateIdentifierNames(child, bindings))
}

function renderCallbackExpression(
  callback: SafeCallbackExpression,
  parameterLabels: readonly string[],
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart | undefined {
  const callbackBindings = new Map(bindings)
  // Keep free variables recognizable (`txId`, `EXPECTED_STATUS`) while giving
  // callback-local parameters generic, project-independent names.
  preservePredicateIdentifierNames(callback.body, callbackBindings)
  callback.parameters.forEach((parameter, index) => callbackBindings.set(parameter, parameterLabels[index]))
  const rendered = renderPart(callback.body, sourceFile, callbackBindings)
  return rendered.fidelity === 'unresolved' ? undefined : rendered
}

function renderZeroBasedSum(
  callback: SafeCallbackExpression,
  owner: RenderedPart,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): string | undefined {
  if (!ts.isBinaryExpression(callback.body)
    || callback.body.operatorToken.kind !== ts.SyntaxKind.PlusToken
    || !ts.isIdentifier(callback.body.left)
    || callback.body.left.text !== callback.parameters[0]) return undefined

  const contribution = ts.isIdentifier(callback.body.right)
    && callback.body.right.text === callback.parameters[1]
    ? { text: 'each item' }
    : renderCallbackExpression(
        { ...callback, body: callback.body.right },
        ['the running value', "each item's", "each item's index", "the collection's"],
        sourceFile,
        bindings,
      )
  return contribution ? `the sum of ${contribution.text} in ${childText(owner)}` : undefined
}

function renderCollectionPredicate(
  node: ts.CallExpression,
  method: string,
  ownerExpression: ts.Expression,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart | undefined {
  if ((method !== 'every' && method !== 'some' && method !== 'find') || node.arguments.length !== 1) return undefined
  if (ts.isIdentifier(node.arguments[0])) {
    const owner = renderPart(ownerExpression, sourceFile, bindings)
    const predicate = renderPart(node.arguments[0], sourceFile, bindings)
    if (owner.fidelity === 'unresolved' || predicate.fidelity === 'unresolved') return undefined
    const text = method === 'find'
      ? `the first item in ${childText(owner)} matching ${predicate.text}`
      : method === 'every'
        ? `every item in ${childText(owner)} matches ${predicate.text}`
        : `at least one item in ${childText(owner)} matches ${predicate.text}`
    return { text, fidelity: 'derived', compound: method !== 'find' }
  }
  const callback = safeCallbackExpression(node.arguments[0], [1, 3])
  if (!callback) return undefined
  const owner = renderPart(ownerExpression, sourceFile, bindings)
  if (owner.fidelity === 'unresolved') return undefined
  const predicate = renderCallbackExpression(callback, ['item', 'item index', 'collection'], sourceFile, bindings)
  if (!predicate) return undefined
  if (method === 'find') {
    return {
      text: `the first item in ${childText(owner)} where ${predicate.text}`,
      fidelity: 'derived',
      compound: false,
    }
  }
  const quantifier = method === 'every' ? 'every' : 'at least one'
  return {
    text: `for ${quantifier} item in ${childText(owner)}, ${predicate.text}`,
    fidelity: 'derived',
    compound: true,
  }
}

function renderCollectionTransform(
  node: ts.CallExpression,
  method: string,
  ownerExpression: ts.Expression,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart | undefined {
  const owner = renderPart(ownerExpression, sourceFile, bindings)
  if (owner.fidelity === 'unresolved') return undefined

  if (method === 'map' || method === 'flatMap' || method === 'filter' || method === 'findIndex') {
    if (node.arguments.length !== 1) return undefined
    if (method === 'filter' && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === 'Boolean') {
      return {
        text: `${childText(owner)} filtered to keep truthy items`,
        fidelity: 'derived',
        compound: false,
      }
    }
    const callback = safeCallbackExpression(node.arguments[0], [1, 3])
    const result = callback && renderCallbackExpression(
      callback,
      ['item', 'item index', 'collection'],
      sourceFile,
      bindings,
    )
    if (!result) return undefined
    const text = method === 'map'
      ? `${childText(owner)} transformed so each item becomes ${result.text}`
      : method === 'flatMap'
        ? `${childText(owner)} transformed and flattened so each item becomes ${result.text}`
        : method === 'filter'
          ? `${childText(owner)} filtered to keep each item where ${result.text}`
          : `the index of the first item in ${childText(owner)} where ${result.text}`
    return { text, fidelity: 'derived', compound: false }
  }

  if (method === 'reduce') {
    if (node.arguments.length < 1 || node.arguments.length > 2) return undefined
    const callback = safeCallbackExpression(node.arguments[0], [2, 4])
    if (!callback) return undefined
    const initialExpression = node.arguments[1]
    const naturalSum = initialExpression
      && ts.isNumericLiteral(initialExpression)
      && initialExpression.text === '0'
      && renderZeroBasedSum(callback, owner, sourceFile, bindings)
    if (naturalSum) return { text: naturalSum, fidelity: 'derived', compound: false }
    const result = renderCallbackExpression(
      callback,
      ['the running value', "that item's", "that item's index", "the collection's"],
      sourceFile,
      bindings,
    )
    if (!result) return undefined
    const initial = initialExpression && renderPart(initialExpression, sourceFile, bindings)
    if (initial?.fidelity === 'unresolved') return undefined
    return {
      text: initial
        ? `the result of combining ${childText(owner)}, starting with ${childText(initial)} and updating the running value for each item to ${result.text}`
        : `the result of combining ${childText(owner)}, starting with the first item and updating the running value for each remaining item to ${result.text}`,
      fidelity: 'derived',
      compound: false,
    }
  }

  if (method === 'sort' || method === 'toSorted') {
    if (node.arguments.length > 1) return undefined
    if (!node.arguments.length) {
      return { text: `${childText(owner)} sorted using default ordering`, fidelity: 'derived', compound: false }
    }
    const callback = safeCallbackExpression(node.arguments[0], 2)
    const comparison = callback && renderCallbackExpression(
      callback,
      ['left item', 'right item'],
      sourceFile,
      bindings,
    )
    return comparison
      ? { text: `${childText(owner)} sorted by comparing ${comparison.text}`, fidelity: 'derived', compound: false }
      : undefined
  }

  if (method === 'join') {
    if (node.arguments.length > 1) return undefined
    const separator = node.arguments[0]
      ? renderPart(node.arguments[0], sourceFile, bindings)
      : { text: quoteReadableText(','), fidelity: 'exact' as const, compound: false }
    return separator.fidelity === 'unresolved'
      ? undefined
      : { text: `${childText(owner)} joined with ${separator.text}`, fidelity: 'derived', compound: false }
  }

  if (method === 'split') {
    if (node.arguments.length > 2) return undefined
    if (!node.arguments.length) {
      return { text: `${childText(owner)} placed in a one-item list`, fidelity: 'derived', compound: false }
    }
    const parts = renderedArguments(node.arguments, sourceFile, bindings)
    if (!parts) return undefined
    return {
      text: `${childText(owner)} split using ${parts[0].text}${parts[1] ? `, limited to ${parts[1].text} items` : ''}`,
      fidelity: 'derived',
      compound: false,
    }
  }

  if (method === 'replace' || method === 'replaceAll') {
    if (node.arguments.length !== 2) return undefined
    const parts = renderedArguments(node.arguments, sourceFile, bindings)
    if (!parts) return undefined
    return {
      text: `${childText(owner)} with ${method === 'replaceAll' ? 'every match for' : 'the first match for'} ${parts[0].text} replaced by ${parts[1].text}`,
      fidelity: 'derived',
      compound: false,
    }
  }

  if (method === 'concat') {
    if (!node.arguments.length) return undefined
    const parts = renderedArguments(node.arguments, sourceFile, bindings)
    return parts
      ? {
          text: `${childText(owner)} combined with ${parts.map((part) => part.text).join(' and ')}`,
          fidelity: 'derived',
          compound: false,
        }
      : undefined
  }

  return undefined
}

/** Calls whose *result* has a describable meaning render as that meaning;
 *  everything else returns undefined and stays as source. */
function renderCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart | undefined {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
    const module = renderPart(node.arguments[0], sourceFile, bindings)
    if (module.fidelity !== 'unresolved') {
      return { text: `the module loaded from ${module.text}`, fidelity: 'derived', compound: false }
    }
  }

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
        // A nested property path is already the clearest stable name for the
        // value whose shape is being checked. Humanizing `res.data.data` into
        // "response data data" destroys the boundaries and reads like a typo.
        const inspectedValue = path === 'Array.isArray'
          ? exactPropertyAccessPath(node.arguments[0]) ?? childText(value)
          : childText(value)
        return { text: inspection.replace('{value}', inspectedValue), fidelity: 'derived', compound: false }
      }
    }

    const uriCodec = URI_CODEC_TEXT.get(path)
    if (uriCodec && node.arguments.length === 1) {
      const value = renderPart(node.arguments[0], sourceFile, bindings)
      if (value.fidelity !== 'unresolved') {
        return { text: uriCodec.replace('{value}', childText(value)), fidelity: 'derived', compound: false }
      }
    }

    const conversion = STANDARD_CONVERSION_TEXT.get(path)
    if (conversion && node.arguments.length === 1) {
      const value = renderPart(node.arguments[0], sourceFile, bindings)
      if (value.fidelity !== 'unresolved') {
        return { text: conversion.replace('{value}', childText(value)), fidelity: 'derived', compound: false }
      }
    }

    const mathCall = MATH_CALL_TEXT.get(path)
    if (mathCall && node.arguments.length === 1) {
      const value = renderPart(node.arguments[0], sourceFile, bindings)
      if (value.fidelity !== 'unresolved') {
        return { text: mathCall.replace('{value}', childText(value)), fidelity: 'derived', compound: false }
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
    const collectionTransform = renderCollectionTransform(
      node,
      method,
      node.expression.expression,
      sourceFile,
      bindings,
    )
    if (collectionTransform) return collectionTransform
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
    const conversion = ZERO_ARGUMENT_METHOD_TEXT.get(method)
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
    if (method === 'test' && node.arguments.length === 1) {
      const pattern = renderPart(node.expression.expression, sourceFile, bindings)
      const value = renderPart(node.arguments[0], sourceFile, bindings)
      if (pattern.fidelity !== 'unresolved' && value.fidelity !== 'unresolved') {
        return {
          text: `${childText(value)} matches ${childText(pattern)}`,
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
  const constructor = expressionPath(node.expression)
  if (!constructor) return undefined
  const callArguments = renderedArguments(node.arguments ?? [], sourceFile, bindings)
  if (!callArguments) return undefined
  if (constructor === 'Date') {
    if (callArguments.length === 0) return { text: 'the current time', fidelity: 'derived', compound: false }
    if (callArguments.length === 1) return { text: `${childText(callArguments[0])} as a date`, fidelity: 'derived', compound: false }
    return undefined
  }
  const name = constructor.split('.').map((part) => (
    /^[A-Z][A-Z0-9]*$/.test(part) ? part : humanizeIdentifier(part)
  )).join(' ')
  const using = callArguments.length ? ` using ${callArguments.map((argument) => argument.text).join(' and ')}` : ''
  return { text: `a new ${name}${using}`, fidelity: 'derived', compound: false }
}

function renderTaggedTemplate(
  node: ts.TaggedTemplateExpression,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart | undefined {
  const tag = expressionPath(node.tag)
  if (!tag) return undefined
  const template = renderPart(node.template, sourceFile, bindings)
  if (template.fidelity === 'unresolved') return undefined
  return {
    text: `${tag.split('.').map(humanizeIdentifier).join(' ')} result using ${template.text}`,
    fidelity: 'derived',
    compound: false,
  }
}

function renderJsxChildren(
  children: readonly ts.JsxChild[],
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart[] | undefined {
  const rendered: RenderedPart[] = []
  for (const child of children) {
    if (ts.isJsxText(child)) {
      const text = child.text.replace(/\s+/g, ' ').trim()
      if (text) rendered.push({ text: quoteReadableText(text), fidelity: 'exact', compound: false })
      continue
    }
    if (ts.isJsxExpression(child)) {
      if (!child.expression) continue
      const expression = renderPart(child.expression, sourceFile, bindings)
      if (expression.fidelity === 'unresolved') return undefined
      rendered.push(expression)
      continue
    }
    const element = renderPart(child, sourceFile, bindings)
    if (element.fidelity === 'unresolved') return undefined
    rendered.push(element)
  }
  return rendered
}

function renderJsxAttributes(
  attributes: ts.JsxAttributes,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): string[] | undefined {
  const rendered: string[] = []
  for (const property of attributes.properties) {
    if (ts.isJsxSpreadAttribute(property)) {
      const value = renderPart(property.expression, sourceFile, bindings)
      if (value.fidelity === 'unresolved') return undefined
      rendered.push(`everything in ${value.text}`)
      continue
    }
    const name = humanizeIdentifier(property.name.getText(sourceFile))
    if (!property.initializer) {
      rendered.push(`${name} enabled`)
      continue
    }
    const value = ts.isJsxExpression(property.initializer)
      ? property.initializer.expression && renderPart(property.initializer.expression, sourceFile, bindings)
      : renderPart(property.initializer, sourceFile, bindings)
    if (!value || value.fidelity === 'unresolved') return undefined
    rendered.push(`${name} set to ${value.text}`)
  }
  return rendered
}

function renderJsxElement(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
  bindings: ExpressionBindings,
): RenderedPart | undefined {
  const opening = ts.isJsxElement(node) ? node.openingElement : node
  const attributes = renderJsxAttributes(opening.attributes, sourceFile, bindings)
  const children = ts.isJsxElement(node)
    ? renderJsxChildren(node.children, sourceFile, bindings)
    : []
  if (!attributes || !children) return undefined
  const details = [
    attributes.length ? `with ${readableObjectDetails(attributes)}` : undefined,
    children.length ? `containing ${children.map((child) => child.text).join(', ')}` : undefined,
  ].filter((detail): detail is string => Boolean(detail)).join(' and ')
  const tag = humanizeIdentifier(opening.tagName.getText(sourceFile))
  return { text: `a ${tag} UI element${details ? ` ${details}` : ''}`, fidelity: 'derived', compound: false }
}

function readableObjectDetails(details: readonly string[]): string {
  if (details.length < 2) return details.join('')
  return `${details.slice(0, -1).join(', ')}, and ${details.at(-1)}`
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
  if (ts.isBigIntLiteral(node)) {
    return { text: node.text, fidelity: 'exact', compound: false }
  }
  if (ts.isRegularExpressionLiteral(node)) {
    return { text: node.getText(sourceFile), fidelity: 'exact', compound: false }
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { text: 'true', fidelity: 'exact', compound: false }
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { text: 'false', fidelity: 'exact', compound: false }
  if (node.kind === ts.SyntaxKind.NullKeyword) return { text: 'null', fidelity: 'exact', compound: false }
  if (node.kind === ts.SyntaxKind.ThisKeyword) return { text: 'the current object', fidelity: 'derived', compound: false }
  if (node.kind === ts.SyntaxKind.SuperKeyword) return { text: 'the parent object', fidelity: 'derived', compound: false }
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
  if (ts.isTaggedTemplateExpression(node)) {
    return renderTaggedTemplate(node, sourceFile, bindings) ?? unresolved(node, sourceFile)
  }
  if (ts.isArrowFunction(node) && node.parameters.length === 0 && !ts.isBlock(node.body)) {
    const body = renderPart(node.body, sourceFile, bindings)
    if (body.fidelity !== 'unresolved') {
      return { text: `a function returning ${body.text}`, fidelity: 'derived', compound: false }
    }
  }
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    return renderJsxElement(node, sourceFile, bindings) ?? unresolved(node, sourceFile)
  }
  if (ts.isJsxFragment(node)) {
    const children = renderJsxChildren(node.children, sourceFile, bindings)
    return children
      ? {
          text: children.length
            ? `a UI fragment containing ${children.map((child) => child.text).join(', ')}`
            : 'an empty UI fragment',
          fidelity: 'derived',
          compound: false,
        }
      : unresolved(node, sourceFile)
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
  if (ts.isVoidExpression(node)) {
    const expression = renderPart(node.expression, sourceFile, bindings)
    return expression.fidelity === 'unresolved'
      ? unresolved(node, sourceFile)
      : { text: `no value after evaluating ${childText(expression)}`, fidelity: 'derived', compound: false }
  }
  if (ts.isYieldExpression(node)) {
    if (!node.expression) return { text: 'no yielded value', fidelity: 'derived', compound: false }
    const expression = renderPart(node.expression, sourceFile, bindings)
    if (expression.fidelity === 'unresolved') return unresolved(node, sourceFile)
    return {
      text: `${node.asteriskToken ? 'all values from ' : ''}${childText(expression)} yielded`,
      fidelity: 'derived',
      compound: false,
    }
  }
  if (ts.isMetaProperty(node)) {
    return {
      text: node.keywordToken === ts.SyntaxKind.ImportKeyword ? 'module metadata' : 'the constructor target',
      fidelity: 'derived',
      compound: false,
    }
  }
  if (ts.isClassExpression(node)) {
    return {
      text: node.name ? `the ${humanizeIdentifier(node.name.text)} class definition` : 'a class definition',
      fidelity: 'derived',
      compound: false,
    }
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

/** Names a statically-known helper call without claiming to understand what
 * the helper does. This is intentionally separate from `renderExpression`:
 * callers opt in only when "the named call result" is useful context. */
export function renderNamedCallResult(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  options: { allowBareZeroArguments?: boolean } = {},
): RenderedExpression | undefined {
  if (call.questionDotToken) return undefined
  const arguments_ = call.arguments.map((argument) => renderExpression(argument, sourceFile))
  if (arguments_.some((argument) => argument.fidelity === 'unresolved')) return undefined
  const using = arguments_.length
    ? ` using ${arguments_.map((argument) => argument.text).join(' and ')}`
    : ''

  if (ts.isIdentifier(call.expression)) {
    // A bare zero-argument call carries no inputs that explain its result.
    // Keep it as source instead of turning `computeURL()` into vague prose.
    if (!arguments_.length && !options.allowBareZeroArguments) return undefined
    return {
      text: `${humanizeIdentifier(call.expression.text)} result${using}`,
      fidelity: 'derived',
    }
  }

  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.questionDotToken) return undefined
  const owner = renderExpression(call.expression.expression, sourceFile)
  if (owner.fidelity === 'unresolved') return undefined
  return {
    text: `${humanizeIdentifier(call.expression.name.text)} result from ${owner.text}${using}`,
    fidelity: 'derived',
  }
}

export function renderCondition(node: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression {
  return renderExpression(node, sourceFile)
}
