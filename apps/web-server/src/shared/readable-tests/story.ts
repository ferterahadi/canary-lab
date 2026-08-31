import ts from 'typescript'
import type {
  ReadableStoryFlowKind,
  ReadableStoryItem,
  ReadableStorySpan,
} from '../../../../../shared/readable-tests/types'
import {
  renderActionCall,
  renderActionExpression,
  renderActionStatement,
  requestMethodForCall,
} from './actions'
import { renderAssertionStatement, renderGenericAssertionStatement } from './assertions'
import { expressionPath, quoteReadableText, renderExpression } from './expression'
import {
  assignedNameFromStatement,
  humanizeIdentifier,
  identifierWords,
  readableActionName,
  readableObject,
  sentenceCase,
  setupLikeStatement,
} from './language'

export type StoryRole = 'setup' | 'action' | 'check'

interface StoryCandidateBase {
  node: ts.Node
  role: StoryRole
  text: string
  spans: ReadableStorySpan[]
  fidelity: ReadableStoryItem['fidelity']
  path: number[]
}

export interface StoryStepCandidate extends StoryCandidateBase {
  kind: 'step'
}

export interface StoryFlowCandidate extends StoryCandidateBase {
  kind: 'flow'
  flowKind: ReadableStoryFlowKind
  children: StoryCandidate[]
}

export type StoryCandidate = StoryStepCandidate | StoryFlowCandidate

type StoryDescription = Pick<StoryCandidateBase, 'role' | 'text' | 'fidelity'>

interface WalkOptions {
  includeActions: boolean
  breakTarget?: 'loop' | 'switch'
}

const SETUP_CALL_VERBS = new Set(['build', 'configure', 'create', 'generate', 'make', 'mock', 'prepare', 'seed', 'setup'])
const SEMANTIC_RECEIVER_METHODS = new Set([
  'concat',
  'filter',
  'find',
  'findIndex',
  'flatMap',
  'join',
  'map',
  'pop',
  'push',
  'reduce',
  'replace',
  'replaceAll',
  'reverse',
  'shift',
  'sort',
  'splice',
  'split',
  'toSorted',
  'unshift',
])
const EXACT_IDENTIFIER_OPEN = '\uE000'
const EXACT_IDENTIFIER_CLOSE = '\uE001'

function exactIdentifierText(value: string): string {
  // Iterating a string yields complete Unicode code points, so every entry has
  // a code point at offset zero.
  const encoded = [...value].map((character) => character.codePointAt(0)!.toString(16)).join('_')
  return `${EXACT_IDENTIFIER_OPEN}${encoded}${EXACT_IDENTIFIER_CLOSE}`
}

function restoreExactIdentifiers(text: string): string {
  return text.replace(/\uE000([0-9a-f_]+)\uE001/gi, (_match, encoded: string) => (
    encoded.split('_').map((part) => String.fromCodePoint(Number.parseInt(part, 16))).join('')
  ))
}

function callFromStatement(statement: ts.Statement): ts.CallExpression | undefined {
  const statementExpression = ts.isExpressionStatement(statement)
    ? statement.expression
    : ts.isReturnStatement(statement)
      ? statement.expression
      : ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
        ? statement.declarationList.declarations[0].initializer
        : undefined
  if (!statementExpression) return undefined
  let expression = statementExpression
  while (
    ts.isAwaitExpression(expression)
    || ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression
  }
  return ts.isCallExpression(expression) ? expression : undefined
}

function authoredStep(statement: ts.Statement): { label: string; body: ts.Block } | undefined {
  const call = callFromStatement(statement)
  if (
    !call
    || !ts.isPropertyAccessExpression(call.expression)
    || !ts.isIdentifier(call.expression.expression)
    || call.expression.expression.text !== 'test'
    || call.expression.name.text !== 'step'
  ) {
    return undefined
  }
  const [label, callback] = call.arguments
  if (
    !label
    || !ts.isStringLiteralLike(label)
    || !callback
    || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
    || !ts.isBlock(callback.body)
  ) {
    return undefined
  }
  return { label: label.text, body: callback.body }
}

function calledName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text
  return undefined
}

function assignedIdentifier(statement: ts.Statement): string | undefined {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined
  const name = statement.declarationList.declarations[0].name
  return ts.isIdentifier(name) ? name.text : undefined
}

function bindingNameText(name: ts.BindingName, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isIdentifier(name)) return exactIdentifierText(name.text)
  const extraction = bindingPatternText(name, sourceFile)
  return extraction ? `a nested value with ${extraction}` : undefined
}

function bindingDefaultText(initializer: ts.Expression | undefined, sourceFile: ts.SourceFile): string | undefined {
  if (!initializer) return ''
  const value = storyArgument(initializer, sourceFile)
  return value ? `, defaulting to ${value}` : undefined
}

function objectBindingText(pattern: ts.ObjectBindingPattern, sourceFile: ts.SourceFile): string | undefined {
  const parts = pattern.elements.flatMap((element) => {
    const target = bindingNameText(element.name, sourceFile)
    const defaultText = bindingDefaultText(element.initializer, sourceFile)
    if (!target || defaultText === undefined) return []
    if (element.dotDotDotToken) return [`remaining properties as ${target}${defaultText}`]
    const key = element.propertyName
      ? propertyName(element.propertyName)
      // Valid shorthand bindings always have an identifier name; nested
      // patterns require an explicit property name in TypeScript's grammar.
      : element.name.getText(sourceFile)
    if (!key) return []
    const sameName = ts.isIdentifier(element.name) && element.name.text === key
    return [`${sameName ? exactIdentifierText(key) : `${exactIdentifierText(key)} as ${target}`}${defaultText}`]
  })
  return parts.length === pattern.elements.length && parts.length
    ? `properties ${readableList(parts)}`
    : undefined
}

function arrayBindingText(pattern: ts.ArrayBindingPattern, sourceFile: ts.SourceFile): string | undefined {
  const parts: string[] = []
  for (const [index, element] of pattern.elements.entries()) {
    if (ts.isOmittedExpression(element)) continue
    const target = bindingNameText(element.name, sourceFile)
    const defaultText = bindingDefaultText(element.initializer, sourceFile)
    if (!target || defaultText === undefined) return undefined
    parts.push(element.dotDotDotToken
      ? `remaining items as ${target}${defaultText}`
      : `item ${index + 1} as ${target}${defaultText}`)
  }
  return parts.length ? readableList(parts) : undefined
}

function bindingPatternText(
  pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern,
  sourceFile: ts.SourceFile,
): string | undefined {
  return ts.isObjectBindingPattern(pattern)
    ? objectBindingText(pattern, sourceFile)
    : arrayBindingText(pattern, sourceFile)
}

function readableList(items: readonly string[]): string {
  // Every caller checks for an empty collection before asking for prose.
  if (items.length < 2) return items[0]!
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
}

function storyObjectArgument(
  object: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): string | undefined {
  const properties: string[] = []
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      const computedName = ts.isComputedPropertyName(property.name)
        ? storyArgument(property.name.expression, sourceFile)
        : undefined
      const name = computedName
        ? `property named by ${computedName}`
        : propertyName(property.name)
      const value = storyArgument(property.initializer, sourceFile)
      if (!name || !value) return undefined
      properties.push(`${computedName || !ts.isIdentifier(property.name) ? name : humanizeIdentifier(name)} set to ${value}`)
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      properties.push(exactIdentifierText(property.name.text))
      continue
    }
    if (ts.isSpreadAssignment(property)) {
      const spread = storyArgument(property.expression, sourceFile)
      if (!spread) return undefined
      properties.push(`everything in ${spread}`)
      continue
    }
    return undefined
  }
  // An empty object is resolved by `renderExpression` before this fallback;
  // reaching here guarantees at least one property needed recursive handling.
  return `an object with ${readableList(properties)}`
}

/** Story mode names top-level inputs without recursively expanding every helper.
 * References keep their exact names; safe values keep their value; a nested
 * builder is named as its result rather than expanded into source. */
function storyArgument(
  argument: ts.Expression,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return undefined
  if (ts.isIdentifier(argument)) {
    return /^(?:callback|handler|fn)$/i.test(argument.text) ? undefined : exactIdentifierText(argument.text)
  }
  const path = expressionPath(argument)
  if (path) return exactIdentifierText(path)
  let expression = argument
  while (
    ts.isAwaitExpression(expression)
    || ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) expression = expression.expression
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = storyArgument(expression.expression, sourceFile)
    return owner ? `${owner} ${humanizeIdentifier(expression.name.text)}` : undefined
  }
  if (ts.isElementAccessExpression(expression)) {
    const owner = storyArgument(expression.expression, sourceFile)
    const key = storyArgument(expression.argumentExpression, sourceFile)
    return owner && key ? `${owner} at ${key}` : undefined
  }
  if (ts.isCallExpression(expression)) {
    const rendered = renderExpression(expression, sourceFile)
    if (rendered.fidelity !== 'unresolved') return rendered.text
    const name = calledName(expression)
    if (name) {
      const [first, ...rest] = identifierWords(name)
      if (first === 'now') {
        const noun = readableObject(rest)
        return noun ? `the current-time ${noun}` : 'the current time'
      }
      const arguments_ = expression.arguments.map((value) => storyArgument(value, sourceFile))
      const using = arguments_.length && arguments_.every((value): value is string => Boolean(value))
        ? ` using ${readableList(arguments_)}`
        : ''
      const receiver = ts.isPropertyAccessExpression(expression.expression)
        ? storyArgument(expression.expression.expression, sourceFile)
        : undefined
      return `${humanizeIdentifier(name)} result${receiver ? ` from ${receiver}` : ''}${using}`
    }
  }
  const rendered = renderExpression(argument, sourceFile)
  if (rendered.fidelity === 'unresolved' && ts.isTemplateExpression(expression)) {
    let text = expression.head.text
    for (const span of expression.templateSpans) {
      const value = storyArgument(span.expression, sourceFile)
      if (!value) return undefined
      text += `{${value}}${span.literal.text}`
    }
    return quoteReadableText(text)
  }
  if (rendered.fidelity === 'unresolved' && ts.isArrayLiteralExpression(expression)) {
    const elements = expression.elements.map((element) => {
      if (ts.isSpreadElement(element)) {
        const spread = storyArgument(element.expression, sourceFile)
        return spread ? `all items of ${spread}` : undefined
      }
      return storyArgument(element, sourceFile)
    })
    return elements.every((element): element is string => Boolean(element))
      ? `a list containing ${elements.join(', ')}`
      : undefined
  }
  if (rendered.fidelity === 'unresolved' && ts.isObjectLiteralExpression(expression)) {
    return storyObjectArgument(expression, sourceFile)
  }
  return rendered.fidelity === 'unresolved' ? undefined : rendered.text
}

function destructuringDescription(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): StoryDescription | undefined {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined
  const declaration = statement.declarationList.declarations[0]
  if (ts.isIdentifier(declaration.name) || !declaration.initializer) return undefined
  const extraction = bindingPatternText(declaration.name, sourceFile)
  if (!extraction) return undefined
  const call = callFromStatement(statement)
  const renderedCall = call && renderActionCall(call, sourceFile)
  const base = renderedCall
    && (renderedCall.fidelity === 'exact' || renderedCall.fidelity === 'derived')
    && (renderedCall.role === 'setup' || renderedCall.role === 'action')
    ? {
        role: renderedCall.role,
        text: renderedCall.text,
        fidelity: renderedCall.fidelity,
      } satisfies StoryDescription
    : call
      ? genericCallDescription(call, sourceFile, statement.getText(sourceFile), undefined)
      : undefined
  if (base && (base.role === 'setup' || base.role === 'action')) {
    return { ...base, text: `${base.text}, extracting ${extraction}` }
  }
  const source = storyArgument(declaration.initializer, sourceFile)
  return source
    ? { role: 'setup', text: `Extract ${extraction} from ${source}`, fidelity: 'derived' }
    : undefined
}

function callArguments(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): string[] {
  return call.arguments.flatMap((argument) => {
    const rendered = storyArgument(argument, sourceFile)
    return rendered ? [rendered] : []
  })
}

/** A template remains useful setup evidence even when one interpolation is a
 * project helper whose implementation is outside the current source. Preserve
 * every safe literal/value and name the helper result instead of dropping the
 * whole declaration or leaking raw code. */
function variableTemplateDescription(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): StoryDescription | undefined {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined
  const declaration = statement.declarationList.declarations[0]
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return undefined
  let initializer = declaration.initializer
  while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression
  if (!ts.isTemplateExpression(initializer)) return undefined

  const parts: string[] = []
  if (initializer.head.text) parts.push(quoteReadableText(initializer.head.text))
  for (const span of initializer.templateSpans) {
    const value = storyArgument(span.expression, sourceFile)
    if (!value) return undefined
    parts.push(value)
    if (span.literal.text) parts.push(quoteReadableText(span.literal.text))
  }
  return {
    role: 'setup',
    text: `Set ${exactIdentifierText(declaration.name.text)} to text made from ${readableList(parts)}`,
    fidelity: 'derived',
  }
}

function variableValueDescription(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): StoryDescription | undefined {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined
  const declaration = statement.declarationList.declarations[0]
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return undefined
  const value = storyArgument(declaration.initializer, sourceFile)
  return value
    ? {
        role: 'setup',
        text: `Set ${exactIdentifierText(declaration.name.text)} to ${value}`,
        fidelity: 'derived',
      }
    : undefined
}

function collectionLookupDescription(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  assigned: string,
): StoryDescription | undefined {
  const lookup = renderExpression(call, sourceFile)
  if (lookup.fidelity === 'unresolved') return undefined
  return {
    role: 'action',
    text: `Find ${lookup.text}, saving the result as ${exactIdentifierText(assigned)}`,
    fidelity: 'derived',
  }
}

function genericCallDescription(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  sourceText: string,
  assigned: string | undefined,
): StoryDescription | undefined {
  const name = calledName(call)
  if (!name) return undefined
  const words = identifierWords(name)
  const first = words[0]
  const rest = words.slice(1)
  if (!first) return undefined
  const arguments_ = callArguments(call, sourceFile)
  const using = arguments_.length ? ` using ${readableList(arguments_)}` : ''
  const receiver = ts.isPropertyAccessExpression(call.expression)
    && !(ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'test')
    ? storyArgument(call.expression.expression, sourceFile)
    : undefined
  const on = receiver ? ` on ${receiver}` : ''
  const optional = Boolean(
    call.questionDotToken
    || (ts.isPropertyAccessExpression(call.expression) && call.expression.questionDotToken),
  )
  const whenAvailable = optional ? ' when available' : ''

  if (optional && ts.isIdentifier(call.expression)) {
    return {
      role: 'action',
      text: `Call ${exactIdentifierText(call.expression.text)}${using}${whenAvailable}${assigned ? `, saving the result as ${exactIdentifierText(assigned)}` : ''}`,
      fidelity: 'derived',
    }
  }

  if (ts.isPropertyAccessExpression(call.expression)) {
    const method = call.expression.name.text
    // These standard operations have receiver/callback semantics that a bare
    // verb would hide. Their dedicated renderers either preserve that meaning
    // or omit the step when an argument cannot be described safely.
    if (method === 'find' || (SEMANTIC_RECEIVER_METHODS.has(method) && renderExpression(call, sourceFile).fidelity === 'unresolved')) {
      return undefined
    }
  }

  if (first === 'expect' || first === 'assert' || first === 'check' || first === 'verify' || first === 'ensure') {
    return {
      role: 'check',
      text: sentenceCase(`check ${readableObject(rest) || 'the expected outcome'}${on}${using}${whenAvailable}`),
      fidelity: 'derived',
    }
  }
  if (first === 'with') {
    return {
      role: 'setup',
      text: sentenceCase(`use ${readableObject(rest) || 'the required test context'}${on}${using}${whenAvailable}`),
      fidelity: 'derived',
    }
  }

  if ((first === 'poll' || first === 'wait') && rest.every((word) => word === 'for' || word === 'until')) {
    const assignedName = assigned ?? assignedNameFromStatement(sourceText)
    return {
      role: 'action',
      text: `Wait for ${assignedName ? exactIdentifierText(assignedName) : 'the expected result'}${on}${using}${whenAvailable}`,
      fidelity: 'derived',
    }
  }

  const setup = setupLikeStatement(sourceText)
    || SETUP_CALL_VERBS.has(first)
  if (setup && assigned && SETUP_CALL_VERBS.has(first)) {
    const creationInputs = callArguments(call, sourceFile)
    const creationUsing = creationInputs.length ? ` using ${readableList(creationInputs)}` : ''
    return {
      role: 'setup',
      text: `Create variable ${exactIdentifierText(assigned)}${on}${creationUsing}${whenAvailable}`,
      fidelity: 'derived',
    }
  }
  const saveResult = assigned && !setup ? `, saving the result as ${exactIdentifierText(assigned)}` : ''
  return {
    role: setup ? 'setup' : 'action',
    text: `${readableActionName(name, sourceText)}${on}${using}${whenAvailable}${saveResult}`,
    fidelity: 'derived',
  }
}

function requestCallDescription(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  assigned: string | undefined,
): StoryDescription | undefined {
  const method = requestMethodForCall(call)
  const [targetNode, ...optionNodes] = call.arguments
  if (!method || !targetNode) return undefined
  const target = storyArgument(targetNode, sourceFile)
  const options = optionNodes.flatMap((option) => {
    const rendered = storyArgument(option, sourceFile)
    return rendered ? [rendered] : []
  })
  if (!target || options.length !== optionNodes.length) return undefined
  const withOptions = options.length ? ` with ${readableList(options)}` : ''
  const saveResult = assigned ? `, saving the result as ${exactIdentifierText(assigned)}` : ''
  return {
    role: 'action',
    text: `Send a ${method.toUpperCase()} request to ${target}${withOptions}${saveResult}`,
    fidelity: 'derived',
  }
}

function genericCallStory(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): StoryDescription | undefined {
  const call = callFromStatement(statement)
  if (!call) return undefined
  return genericCallDescription(
    call,
    sourceFile,
    statement.getText(sourceFile),
    assignedIdentifier(statement),
  )
}

function variableAlias(statement: ts.Statement): { name: string; text: string } | undefined {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined
  const declaration = statement.declarationList.declarations[0]
  if (!ts.isIdentifier(declaration.name)) return undefined
  const call = callFromStatement(statement)
  const name = call ? calledName(call) : undefined
  if (!name) return undefined
  const [first, ...rest] = identifierWords(name)
  if (!['fetch', 'find', 'get', 'load', 'query', 'read'].includes(first)) return undefined
  const text = readableObject(rest)
  return text ? { name: declaration.name.text, text } : undefined
}

function polishStoryText(text: string): string {
  return text
    .replace(/\bwhats ?app\b/gi, 'WhatsApp')
    .replace(/\bsql\b/gi, 'SQL')
    .replace(/\bsms\b/gi, 'SMS')
    .replace(/\bjson\b/gi, 'JSON')
    .replace(/\bhttp\b/gi, 'HTTP')
    .replace(/\bapi\b/gi, 'API')
    .replace(/\burl\b/gi, 'URL')
    .replace(/\buri\b/gi, 'URI')
    .replace(/\bui\b/gi, 'UI')
}

function applySubjectAlias(text: string, aliases: ReadonlyMap<string, string>): string {
  for (const [name, alias] of aliases) {
    const subject = humanizeIdentifier(name)
    const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^((?:Soft-)?Check that )${escaped}(?=\\b| )`, 'i')
    if (pattern.test(text)) return text.replace(pattern, `$1${alias}`)
  }
  return text
}

function isIdentifierName(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isCallExpression(parent) && parent.expression === node) return true
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true
  return ts.isVariableDeclaration(parent) && parent.name === node
    ? false
    : (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node
}

function exactVariableNames(node: ts.Node): string[] {
  const names = new Set<string>()
  const visit = (child: ts.Node): void => {
    // Keep an exact dotted path as one visual token when the English renderer
    // deliberately preserves it (`res.data.data`). Individual identifiers are
    // still collected below for the humanized sentences used elsewhere.
    if (ts.isPropertyAccessExpression(child)) {
      const path = expressionPath(child)
      if (path) names.add(path)
    }
    if (ts.isIdentifier(child) && !isIdentifierName(child)) names.add(child.text)
    child.forEachChild(visit)
  }
  visit(node)
  return [...names]
}

function variablePhrases(
  node: ts.Node,
  text: string,
  aliases: ReadonlyMap<string, string>,
): string[] {
  const lowerText = text.toLocaleLowerCase()
  const phrases = new Set<string>()
  for (const name of exactVariableNames(node)) {
    const alias = aliases.get(name)
    // A dotted path is useful only in its exact, source-shaped form. Its
    // individual identifiers are visited separately and keep the established
    // humanized highlighting in sentences that do not preserve the path.
    const variants = name.includes('.') ? [name] : [name, alias, humanizeIdentifier(name)]
    for (const phrase of variants) {
      if (phrase && lowerText.includes(phrase.toLocaleLowerCase())) phrases.add(phrase)
    }
  }
  return [...phrases].sort((a, b) => b.length - a.length || a.localeCompare(b))
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9]/.test(value)
}

type StorySpanKind = NonNullable<ReadableStorySpan['kind']>

const STORY_LITERAL_PATTERN = /“[^”]*”|\b(?:true|false|null|undefined|NaN)\b/gi
const STORY_NUMBER_PATTERN = /\b\d+(?:[.,]\d+)?(?:\s+(?:milliseconds?|seconds?|minutes?|hours?))?\b/gi
const STORY_OPERATOR_PATTERN = /\b(?:does not contain an item equal to|contains an item equal to|does not exactly equal|is not an instance of|is an instance of|does not contain text|does not have length|does not have count|does not have value|does not have text|is not greater than|is not less than|does not contain|does not include|does not match|does not equal|exactly equals|is greater than|is less than|is at least|is at most|contains text|has length|has count|has value|has text|starts with|ends with|contains|includes|matches|equals|is not|is)\b/gi
const STORY_KEYWORD_PATTERN = /\b(?:after each pass|for up to|for each|if available|when available|when missing|with message|asynchronously|sequentially|otherwise|retrying|saving|until|using|whether|while|when|then|once|if)\b/gi
const STORY_LEADING_VERB_PATTERN = /^[A-Za-z]+(?:-[A-Za-z]+)?/

function markSpan(
  kinds: Array<StorySpanKind | undefined>,
  start: number,
  end: number,
  kind: StorySpanKind,
): void {
  for (let index = start; index < end; index += 1) kinds[index] = kind
}

function markPattern(
  text: string,
  kinds: Array<StorySpanKind | undefined>,
  pattern: RegExp,
  kind: StorySpanKind,
): void {
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    markSpan(kinds, match.index, match.index + match[0].length, kind)
  }
}

function storySpans(
  text: string,
  phrases: readonly string[],
  highlightLeadingVerb: boolean,
): ReadableStorySpan[] {
  const lowerText = text.toLocaleLowerCase()
  const kinds = new Array<StorySpanKind | undefined>(text.length)

  const leadingVerb = highlightLeadingVerb ? STORY_LEADING_VERB_PATTERN.exec(text) : null
  if (leadingVerb) markSpan(kinds, leadingVerb.index, leadingVerb[0].length, 'verb')
  markPattern(text, kinds, STORY_KEYWORD_PATTERN, 'keyword')
  markPattern(text, kinds, STORY_OPERATOR_PATTERN, 'operator')
  markPattern(text, kinds, STORY_LITERAL_PATTERN, 'literal')
  markPattern(text, kinds, STORY_NUMBER_PATTERN, 'number')

  for (const phrase of phrases) {
    const lowerPhrase = phrase.toLocaleLowerCase()
    let from = 0
    while (from < text.length) {
      const start = lowerText.indexOf(lowerPhrase, from)
      if (start < 0) break
      const end = start + phrase.length
      const bounded = !isWordCharacter(text[start - 1]) && !isWordCharacter(text[end])
      if (bounded) markSpan(kinds, start, end, 'variable')
      from = Math.max(end, start + 1)
    }
  }

  const spans: ReadableStorySpan[] = []
  for (let start = 0; start < text.length;) {
    const kind = kinds[start]
    let end = start + 1
    while (end < text.length && kinds[end] === kind) end += 1
    spans.push({ text: text.slice(start, end), ...(kind ? { kind } : {}) })
    start = end
  }
  return spans
}

type StoryCallback = ts.ArrowFunction | ts.FunctionExpression

interface CallbackArgument {
  argumentIndex: number
  callback: StoryCallback
}

function callbackArgumentsFor(call: ts.CallExpression): CallbackArgument[] {
  return call.arguments.flatMap((argument, argumentIndex) => (
    ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
      ? [{ argumentIndex, callback: argument }]
      : []
  ))
}

function callbackExpression(callback: StoryCallback): ts.Expression | undefined {
  if (!ts.isBlock(callback.body)) return callback.body
  if (callback.body.statements.length !== 1) return undefined
  const [statement] = callback.body.statements
  return ts.isReturnStatement(statement) ? statement.expression : undefined
}

function callbackParameter(callback: StoryCallback): string | undefined {
  const [parameter, ...extra] = callback.parameters
  return parameter && !extra.length && ts.isIdentifier(parameter.name)
    ? parameter.name.text
    : undefined
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) return property.initializer
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name
  }
  return undefined
}

function callOptions(call: ts.CallExpression): ts.ObjectLiteralExpression | undefined {
  return call.arguments.find(ts.isObjectLiteralExpression)
}

function durationText(expression: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isNumericLiteral(expression)) {
    const milliseconds = Number(expression.text)
    if (milliseconds >= 1000 && milliseconds % 1000 === 0) {
      const seconds = milliseconds / 1000
      return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
    }
    return `${expression.text} milliseconds`
  }
  const rendered = renderExpression(expression, sourceFile)
  return rendered.fidelity === 'unresolved' ? undefined : rendered.text
}

function lowerInitial(text: string): string {
  return `${text[0].toLocaleLowerCase()}${text.slice(1)}`
}

function conditionStoryText(expression: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  const rendered = renderExpression(expression, sourceFile)
  if (rendered.fidelity === 'unresolved') return undefined
  return ts.isIdentifier(expression)
    || ts.isPropertyAccessExpression(expression)
    || ts.isElementAccessExpression(expression)
    ? `${rendered.text} is true`
    : rendered.text
}

function isLoopStatement(statement: ts.Statement): statement is (
  ts.ForStatement | ts.ForInStatement | ts.ForOfStatement | ts.WhileStatement | ts.DoStatement
) {
  return ts.isForStatement(statement)
    || ts.isForInStatement(statement)
    || ts.isForOfStatement(statement)
    || ts.isWhileStatement(statement)
    || ts.isDoStatement(statement)
}

function loopStoryText(
  statement: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement | ts.WhileStatement | ts.DoStatement,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
    const binding = statement.initializer.getText(sourceFile).replace(/^(?:const|let|var)\s+/, '')
    const source = storyArgument(statement.expression, sourceFile)
      ?? 'the available values'
    if (ts.isForInStatement(statement)) {
      return `Sequentially, for each property ${exactIdentifierText(binding)} in ${source}`
    }
    const qualifier = statement.awaitModifier ? 'asynchronously ' : ''
    return `Sequentially, ${qualifier}for each ${exactIdentifierText(binding)} in ${source}`
  }
  if (ts.isWhileStatement(statement)) {
    const condition = conditionStoryText(statement.expression, sourceFile) ?? 'the condition is true'
    return `While ${condition}; this may run zero times`
  }
  if (ts.isDoStatement(statement)) {
    const condition = conditionStoryText(statement.expression, sourceFile) ?? 'the condition is true'
    return `Run once, then repeat while ${condition}`
  }
  const parts = ['Repeat']
  if (statement.initializer) {
    if (ts.isVariableDeclarationList(statement.initializer)) {
      const starts = statement.initializer.declarations.flatMap((declaration) => {
        if (!ts.isIdentifier(declaration.name)) return []
        const initial = declaration.initializer && renderExpression(declaration.initializer, sourceFile)
        return [initial && initial.fidelity !== 'unresolved'
          ? `${exactIdentifierText(declaration.name.text)} starts at ${initial.text}`
          : `start ${exactIdentifierText(declaration.name.text)}`]
      })
      parts.push(starts.length ? `with ${readableList(starts)}` : 'with the loop starting values')
    } else {
      const initial = renderExpression(statement.initializer, sourceFile)
      parts.push(initial.fidelity === 'unresolved'
        ? 'with the loop starting assignment'
        : `starting with ${initial.text}`)
    }
  }
  const condition = statement.condition && conditionStoryText(statement.condition, sourceFile)
  parts.push(condition ? `while ${condition}` : 'until a step stops the loop')
  if (statement.incrementor) {
    const increment = renderExpression(statement.incrementor, sourceFile)
    parts.push(increment.fidelity === 'unresolved'
      ? 'updating the loop value after each pass'
      : `${lowerInitial(increment.text)} after each pass`)
  }
  return parts.join(', ')
}

function callbackScopeText(
  description: StoryDescription,
  callback: StoryCallback,
): StoryDescription {
  const parameter = callbackParameter(callback)
  const text = description.text.replace(/^Use\b/, 'Using')
  const parameterText = parameter && !description.text.includes(exactIdentifierText(parameter))
    ? ` as ${exactIdentifierText(parameter)}`
    : ''
  return {
    ...description,
    text: `${text}${parameterText}`,
  }
}

function mappingDescription(
  statement: ts.Statement,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): StoryDescription | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined
  if (call.expression.name.text !== 'map' && call.expression.name.text !== 'flatMap') return undefined
  const assigned = assignedIdentifier(statement)
  const callback = callbackArgumentsFor(call)[0]?.callback
  const parameter = callback && callbackParameter(callback)
  if (!assigned || !parameter) return undefined
  const rendered = renderExpression(call, sourceFile)
  if (rendered.fidelity !== 'unresolved') {
    return {
      role: 'setup',
      text: `Create ${exactIdentifierText(assigned)} as ${rendered.text}`,
      fidelity: 'derived',
    }
  }
  const receiver = call.expression.expression
  const arrayValues = ts.isArrayLiteralExpression(receiver)
    ? receiver.elements.flatMap((element) => {
        if (ts.isSpreadElement(element)) return []
        const rendered = renderExpression(element, sourceFile)
        return rendered.fidelity === 'unresolved' ? [] : [rendered.text]
      })
    : undefined
  const source = ts.isArrayLiteralExpression(receiver)
    && arrayValues
    && arrayValues.length === receiver.elements.length
    && arrayValues.length > 0
    ? `the values ${readableList(arrayValues)}`
    : storyArgument(receiver, sourceFile)
  if (!source) return undefined
  return {
    role: 'setup',
    text: `Create ${exactIdentifierText(assigned)} by transforming each ${exactIdentifierText(parameter)} in ${source}`,
    fidelity: 'derived',
  }
}

function loopCallbackDescription(
  call: ts.CallExpression,
  callback: StoryCallback,
  sourceFile: ts.SourceFile,
): StoryDescription | undefined {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'forEach') return undefined
  const parameter = callbackParameter(callback)
  const source = storyArgument(call.expression.expression, sourceFile)
  if (!parameter || !source) return undefined
  const asynchronous = callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  return {
    role: 'action',
    text: `For each ${exactIdentifierText(parameter)} in ${source}${asynchronous ? '; asynchronous work may overlap' : ''}`,
    fidelity: 'derived',
  }
}

function collectionMutationDescription(
  statement: ts.Statement,
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): StoryDescription | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined
  const method = call.expression.name.text
  if (!['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort'].includes(method)) return undefined
  const receiver = storyArgument(call.expression.expression, sourceFile)
  if (!receiver) return undefined
  const assigned = assignedIdentifier(statement)
  if (method === 'sort') {
    const rendered = renderExpression(call, sourceFile)
    const renderedReceiver = renderExpression(call.expression.expression, sourceFile)
    if (rendered.fidelity === 'unresolved' || renderedReceiver.fidelity === 'unresolved') return undefined
    const prefix = `${renderedReceiver.text} sorted`
    // renderCollectionTransform owns this exact prefix for every resolved sort.
    const detail = rendered.text.slice(prefix.length)
    return {
      role: 'action',
      text: `Sort ${receiver}${detail}${assigned ? `, saving the result as ${exactIdentifierText(assigned)}` : ''}`,
      fidelity: 'derived',
    }
  }
  const arguments_ = callArguments(call, sourceFile)
  if (arguments_.length !== call.arguments.length) return undefined
  const saveLength = assigned ? `, saving the new length as ${exactIdentifierText(assigned)}` : ''
  const saveItem = assigned ? `, saving the removed item as ${exactIdentifierText(assigned)}` : ''
  const saveItems = assigned ? `, saving the removed items as ${exactIdentifierText(assigned)}` : ''

  if (method === 'push' && arguments_.length) {
    return { role: 'action', text: `Append ${readableList(arguments_)} to ${receiver}${saveLength}`, fidelity: 'derived' }
  }
  if (method === 'unshift' && arguments_.length) {
    return { role: 'action', text: `Prepend ${readableList(arguments_)} to ${receiver}${saveLength}`, fidelity: 'derived' }
  }
  if (method === 'pop' && !arguments_.length) {
    return { role: 'action', text: `Remove the last item from ${receiver}${saveItem}`, fidelity: 'derived' }
  }
  if (method === 'shift' && !arguments_.length) {
    return { role: 'action', text: `Remove the first item from ${receiver}${saveItem}`, fidelity: 'derived' }
  }
  if (method === 'reverse' && !arguments_.length) {
    return {
      role: 'action',
      text: `Reverse ${receiver}${assigned ? `, saving the result as ${exactIdentifierText(assigned)}` : ''}`,
      fidelity: 'derived',
    }
  }
  if (method === 'splice' && arguments_.length) {
    const [start, deleteCount, ...insertions] = arguments_
    const details = [
      `Modify ${receiver} starting at index ${start}`,
      deleteCount ? `removing ${deleteCount} items` : undefined,
      insertions.length ? `inserting ${readableList(insertions)}` : undefined,
    ].filter((part): part is string => Boolean(part)).join(', ')
    return { role: 'action', text: `${details}${saveItems}`, fidelity: 'derived' }
  }
  return undefined
}

/** Build the reader-first story from syntax already parsed for the exhaustive
 * translator. Unknown constructs are intentionally omitted here instead of
 * leaking raw code; the `nodes` tree remains the complete audit surface. */
export function storyCandidates(
  statements: readonly ts.Statement[],
  sourceFile: ts.SourceFile,
): StoryCandidate[] {
  const aliases = new Map<string, string>()

  const decorate = (
    node: ts.Node,
    path: number[],
    candidate: StoryDescription,
  ): StoryCandidateBase => {
    const aliased = candidate.role === 'check' ? applySubjectAlias(candidate.text, aliases) : candidate.text
    const text = restoreExactIdentifiers(candidate.fidelity === 'derived' ? polishStoryText(aliased) : aliased)
    return {
      ...candidate,
      text,
      spans: storySpans(text, variablePhrases(node, text, aliases), candidate.fidelity === 'derived'),
      node,
      path,
    }
  }

  const stepCandidate = (
    node: ts.Node,
    path: number[],
    candidate: StoryDescription,
    options: WalkOptions,
  ): StoryStepCandidate | undefined => {
    if (candidate.role === 'action' && !options.includeActions) return undefined
    return { kind: 'step', ...decorate(node, path, candidate) }
  }

  const populatedFlowCandidate = (
    node: ts.Node,
    path: number[],
    flowKind: ReadableStoryFlowKind,
    candidate: StoryDescription,
    children: StoryCandidate[],
  ): StoryFlowCandidate => ({
    kind: 'flow',
    flowKind,
    ...decorate(node, path, candidate),
    children,
  })

  const flowCandidate = (
    node: ts.Node,
    path: number[],
    flowKind: ReadableStoryFlowKind,
    candidate: StoryDescription,
    children: StoryCandidate[],
  ): StoryFlowCandidate | undefined => children.length
    ? populatedFlowCandidate(node, path, flowKind, candidate, children)
    : undefined

  function walkStatements(
    nested: readonly ts.Statement[],
    basePath: number[],
    options: WalkOptions,
  ): StoryCandidate[] {
    return nested.flatMap((statement, index) => walkStatement(statement, [...basePath, index], options))
  }

  function callbackCandidates(
    callback: StoryCallback,
    path: number[],
    options: WalkOptions,
  ): StoryCandidate[] {
    if (ts.isBlock(callback.body)) return walkStatements(callback.body.statements, path, options)
    let expression = callback.body
    while (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression
    if (!ts.isCallExpression(expression)) return []
    const description = genericCallDescription(expression, sourceFile, expression.getText(sourceFile), undefined)
    const candidate = description ? stepCandidate(expression, path, description, options) : undefined
    return candidate ? [candidate] : []
  }

  function expressionCandidates(
    sourceExpression: ts.Expression,
    path: number[],
    options: WalkOptions,
    assigned?: string,
  ): StoryCandidate[] {
    let expression = sourceExpression
    while (
      ts.isAwaitExpression(expression)
      || ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression)
    ) expression = expression.expression

    const rendered = renderActionExpression(expression, sourceFile)
    const directDescription = rendered
      && (rendered.fidelity === 'exact' || rendered.fidelity === 'derived')
      && (rendered.role === 'setup' || rendered.role === 'action')
      ? {
          text: `${rendered.text}${assigned && rendered.role === 'action' ? `, saving the result as ${exactIdentifierText(assigned)}` : ''}`,
          role: rendered.role,
          fidelity: rendered.fidelity,
        } satisfies StoryDescription
      : undefined
    if (!ts.isCallExpression(expression)) {
      const candidate = directDescription && stepCandidate(expression, path, directDescription, options)
      if (candidate) return [candidate]
      const value = assigned && storyArgument(expression, sourceFile)
      const valueCandidate = value && stepCandidate(expression, path, {
        role: 'action',
        text: `Use ${value} as ${exactIdentifierText(assigned)}`,
        fidelity: 'derived',
      }, options)
      return valueCandidate ? [valueCandidate] : []
    }

    // Known actions were already handled by renderActionExpression above.
    // Re-running the same action dispatcher here creates an unreachable second
    // branch; only the generic helper fallback remains at this point.
    const description = directDescription
      ?? genericCallDescription(expression, sourceFile, expression.getText(sourceFile), assigned)
    const callbacks = callbackArgumentsFor(expression)
    const children = callbacks.flatMap(({ argumentIndex, callback }) => (
      callbackCandidates(callback, [...path, argumentIndex], options)
    ))
    if (description && children.length) {
      const loopDescription = loopCallbackDescription(expression, callbacks[0].callback, sourceFile)
      return [populatedFlowCandidate(
        expression,
        path,
        loopDescription ? 'loop' : 'scope',
        loopDescription ?? callbackScopeText(description, callbacks[0].callback),
        children,
      )]
    }
    if (!description) return children
    const candidate = stepCandidate(expression, path, description, options)
    return candidate ? [candidate] : []
  }

  function callIsAwaited(call: ts.CallExpression, statement: ts.Statement): boolean {
    let node: ts.Node | undefined = call.parent
    while (node && node !== statement) {
      if (ts.isAwaitExpression(node)) return true
      node = node.parent
    }
    return false
  }

  function promiseCombinatorCandidate(
    statement: ts.Statement,
    path: number[],
    call: ts.CallExpression,
    options: WalkOptions,
  ): StoryCandidate | undefined {
    const combinator = expressionPath(call.expression)
    if (!combinator || !['Promise.all', 'Promise.allSettled', 'Promise.race', 'Promise.any'].includes(combinator)) {
      return undefined
    }
    const [input, ...extra] = call.arguments
    if (!input || extra.length) return undefined
    const assigned = assignedIdentifier(statement)
    const awaited = callIsAwaited(call, statement)
    const array = ts.isArrayLiteralExpression(input) ? input : undefined
    const count = array && !array.elements.some(ts.isSpreadElement) ? array.elements.length : undefined
    const operations = count === undefined ? 'these operations' : `${count} ${count === 1 ? 'operation' : 'operations'}`
    const source = !array && storyArgument(input, sourceFile)
    if (!array && !source) return undefined
    const subject = source ? `the operations in ${source}` : operations
    const text = combinator === 'Promise.all'
      ? `${awaited ? 'Run' : 'Start'} ${subject} together and ${awaited ? 'wait for every one to finish' : 'combine their completion'} `
      : combinator === 'Promise.allSettled'
        ? `${awaited ? 'Run' : 'Start'} ${subject} together and ${awaited ? 'wait for every outcome' : 'collect every outcome'} `
        : combinator === 'Promise.race'
          ? `${awaited ? 'Run' : 'Start'} ${subject} together and use the first one to settle `
          : `${awaited ? 'Run' : 'Start'} ${subject} together and use the first successful result `
    const description: StoryDescription = {
      role: 'action',
      text: `${text.trimEnd()}${assigned ? `, saving the ${awaited ? 'result' : 'combined promise'} as ${exactIdentifierText(assigned)}` : ''}`,
      fidelity: 'derived',
    }
    const children = array?.elements.flatMap((element, index) => {
      if (ts.isSpreadElement(element)) {
        const spread = storyArgument(element.expression, sourceFile)
        const candidate = spread && stepCandidate(element, [...path, 0, index], {
          role: 'action',
          text: `Include every operation in ${spread}`,
          fidelity: 'derived',
        }, options)
        return candidate ? [candidate] : []
      }
      const candidates = expressionCandidates(element, [...path, 0, index], options)
      if (candidates.length) return candidates
      const operation = storyArgument(element, sourceFile)
      const candidate = operation && stepCandidate(element, [...path, 0, index], {
        role: 'action',
        text: `Use ${operation}`,
        fidelity: 'derived',
      }, options)
      return candidate ? [candidate] : []
    }) ?? []
    return children.length
      ? populatedFlowCandidate(statement, path, 'scope', description, children)
      : stepCandidate(statement, path, description, options)
  }

  function shortCircuitCandidate(
    statement: ts.Statement,
    path: number[],
    options: WalkOptions,
  ): StoryFlowCandidate | undefined {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return undefined
    const { left, operatorToken, right } = statement.expression
    if (
      operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
      && operatorToken.kind !== ts.SyntaxKind.BarBarToken
      && operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    ) return undefined
    const children = expressionCandidates(right, [...path, 0], options)
    if (!children.length) return undefined
    const rendered = renderExpression(left, sourceFile)
    const plain = rendered.fidelity === 'unresolved' ? 'the left condition' : rendered.text
    const text = operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? `If ${conditionStoryText(left, sourceFile) ?? 'the left condition is true'}`
      : operatorToken.kind === ts.SyntaxKind.BarBarToken
        ? `If ${ts.isIdentifier(left) || ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left) ? `${plain} is false` : `it is false that ${plain}`}`
        : `If ${plain} is null or undefined`
    return populatedFlowCandidate(statement, path, 'condition', {
      role: 'action',
      text,
      fidelity: 'derived',
    }, children)
  }

  function sequenceExpressionCandidate(
    statement: ts.Statement,
    path: number[],
    options: WalkOptions,
  ): StoryFlowCandidate | undefined {
    if (!ts.isExpressionStatement(statement)) return undefined
    const expressions: ts.Expression[] = []
    const collect = (expression: ts.Expression): void => {
      if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        collect(expression.left)
        collect(expression.right)
        return
      }
      expressions.push(expression)
    }
    collect(statement.expression)
    if (expressions.length < 2) return undefined
    const children = expressions.flatMap((expression, index) => (
      expressionCandidates(expression, [...path, index], options)
    ))
    return flowCandidate(statement, path, 'scope', {
      role: 'action',
      text: 'Run these steps in sequence',
      fidelity: 'derived',
    }, children)
  }

  function conditionalExpressionCandidate(
    statement: ts.Statement,
    path: number[],
    options: WalkOptions,
  ): StoryFlowCandidate | undefined {
    let expression = ts.isExpressionStatement(statement)
      ? statement.expression
      : ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
        ? statement.declarationList.declarations[0].initializer
        : undefined
    if (!expression) return undefined
    while (
      ts.isAwaitExpression(expression)
      || ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression)
    ) expression = expression.expression
    if (!ts.isConditionalExpression(expression)) return undefined

    const assigned = assignedIdentifier(statement)
    const whenTrue = flowCandidate(expression.whenTrue, [...path, 0], 'then', {
      role: 'action',
      text: 'When the condition is true',
      fidelity: 'derived',
    }, expressionCandidates(expression.whenTrue, [...path, 0], options, assigned))
    const whenFalse = flowCandidate(expression.whenFalse, [...path, 1], 'otherwise', {
      role: 'action',
      text: 'When the condition is false',
      fidelity: 'derived',
    }, expressionCandidates(expression.whenFalse, [...path, 1], options, assigned))
    const children = [whenTrue, whenFalse].filter((candidate): candidate is StoryFlowCandidate => Boolean(candidate))
    const condition = conditionStoryText(expression.condition, sourceFile) ?? 'the condition is true'
    return flowCandidate(statement, path, 'condition', {
      role: 'action',
      text: `If ${condition}`,
      fidelity: 'derived',
    }, children)
  }

  function retryFlow(
    statement: ts.Statement,
    path: number[],
    call: ts.CallExpression,
    options: WalkOptions,
  ): StoryFlowCandidate | undefined {
    const name = calledName(call)
    const words = name ? identifierWords(name) : []
    if (!words.length || !['poll', 'wait'].includes(words[0]) || !words.includes('until')) return undefined
    const callbacks = callbackArgumentsFor(call)
    const operation = callbacks[0]
    if (!operation) return undefined
    const children = callbackCandidates(operation.callback, [...path, operation.argumentIndex], options)
    if (!children.length) return undefined

    const optionsObject = callOptions(call)
    const timeout = optionsObject && objectProperty(optionsObject, 'timeoutMs')
    const interval = optionsObject && objectProperty(optionsObject, 'pollMs')
    const predicateNode = optionsObject && objectProperty(optionsObject, 'predicate')
    const predicate = predicateNode && (ts.isArrowFunction(predicateNode) || ts.isFunctionExpression(predicateNode))
      ? predicateNode
      : undefined
    const predicateExpression = predicate && callbackExpression(predicate)
    const renderedPredicate = predicateExpression && renderExpression(predicateExpression, sourceFile)
    const predicateParameter = predicate && callbackParameter(predicate)
    let condition = renderedPredicate && renderedPredicate.fidelity !== 'unresolved'
      ? renderedPredicate.text
      : 'the expected result is ready'
    if (predicateParameter) {
      const parameter = humanizeIdentifier(predicateParameter)
      condition = condition.replace(new RegExp(`^${parameter}(?=\\b| )`, 'i'), 'the result')
    }
    condition = condition.replace(
      /^the result (.+?), if available (.+)$/,
      'the result $1 $2 when available',
    )

    const assigned = assignedIdentifier(statement)
    const timeoutText = timeout && durationText(timeout, sourceFile)
    const intervalText = interval && durationText(interval, sourceFile)
    const text = [
      timeoutText ? `For up to ${timeoutText}, until ${condition}` : `Until ${condition}`,
      intervalText ? `retrying every ${intervalText}` : undefined,
      assigned ? `saving the matching result as ${exactIdentifierText(assigned)}` : undefined,
    ].filter((part): part is string => Boolean(part)).join(', ')
    return flowCandidate(statement, path, 'retry', {
      role: 'action',
      text,
      fidelity: 'derived',
    }, children)
  }

  function walkStatement(statement: ts.Statement, path: number[], options: WalkOptions): StoryCandidate[] {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return []
    if (ts.isBlock(statement)) {
      return walkStatements(statement.statements, path, options)
    }
    if (ts.isLabeledStatement(statement)) {
      return walkStatement(statement.statement, [...path, 0], options)
    }
    if (ts.isWithStatement(statement)) {
      const scope = renderExpression(statement.expression, sourceFile)
      const children = walkStatement(statement.statement, [...path, 0], options)
      const flow = flowCandidate(statement, path, 'scope', {
        role: 'action',
        text: scope.fidelity === 'unresolved'
          ? 'Run these steps with the authored object as the active scope'
          : `Run these steps with ${scope.text} as the active scope`,
        fidelity: 'derived',
      }, children)
      return flow ? [flow] : []
    }
    if (ts.isIfStatement(statement)) {
      const paths = [
        flowCandidate(statement.thenStatement, [...path, 0], 'then', {
          role: 'action',
          text: 'When the condition is true',
          fidelity: 'derived',
        }, walkStatement(statement.thenStatement, [...path, 0], options)),
        statement.elseStatement
          ? flowCandidate(statement.elseStatement, [...path, 1], 'otherwise', {
              role: 'action',
              text: 'When the condition is false',
              fidelity: 'derived',
            }, walkStatement(statement.elseStatement, [...path, 1], options))
          : undefined,
      ].filter((candidate): candidate is StoryFlowCandidate => Boolean(candidate))
      const condition = conditionStoryText(statement.expression, sourceFile) ?? 'the condition is true'
      const flow = flowCandidate(statement, path, 'condition', {
        role: 'action',
        text: `If ${condition}`,
        fidelity: 'derived',
      }, paths)
      return flow ? [flow] : []
    }
    if (ts.isSwitchStatement(statement)) {
      const cases = statement.caseBlock.clauses.flatMap((clause, index) => {
        const children = walkStatements(clause.statements, [...path, index], { ...options, breakTarget: 'switch' })
        const value = ts.isDefaultClause(clause)
          ? undefined
          : renderExpression(clause.expression, sourceFile)
        const text = !value || value.fidelity === 'unresolved'
          ? 'When no earlier value matches'
          : `When ${value.text} matches`
        const flow = flowCandidate(clause, [...path, index], ts.isDefaultClause(clause) ? 'otherwise' : 'case', {
          role: 'action',
          text,
          fidelity: 'derived',
        }, children)
        return flow ? [flow] : []
      })
      const subject = renderExpression(statement.expression, sourceFile)
      const flow = flowCandidate(statement, path, 'switch', {
        role: 'action',
        text: subject.fidelity === 'unresolved'
          ? 'Choose the first matching path'
          : `Choose a path based on ${subject.text}`,
        fidelity: 'derived',
      }, cases)
      return flow ? [flow] : []
    }
    if (ts.isTryStatement(statement)) {
      const children = walkStatements(statement.tryBlock.statements, [...path, 0], options)
      if (statement.catchClause) {
        const errorName = statement.catchClause.variableDeclaration?.name
        const error = errorName && ts.isIdentifier(errorName) ? exactIdentifierText(errorName.text) : undefined
        const caught = flowCandidate(statement.catchClause, [...path, 1], 'catch', {
          role: 'action',
          text: `If the attempt fails${error ? `, save the error as ${error}` : ''}`,
          fidelity: 'derived',
        }, walkStatements(statement.catchClause.block.statements, [...path, 1], options))
        if (caught) children.push(caught)
      }
      if (statement.finallyBlock) {
        const finalized = flowCandidate(statement.finallyBlock, [...path, 2], 'finally', {
          role: 'action',
          text: 'Whether the attempt succeeds or fails',
          fidelity: 'derived',
        }, walkStatements(statement.finallyBlock.statements, [...path, 2], options))
        if (finalized) children.push(finalized)
      }
      const flow = flowCandidate(statement, path, 'try', {
        role: 'action',
        text: 'Attempt these steps',
        fidelity: 'derived',
      }, children)
      return flow ? [flow] : []
    }
    if (isLoopStatement(statement)) {
      const children = walkStatement(statement.statement, [...path, 0], { ...options, breakTarget: 'loop' })
      const flow = flowCandidate(statement, path, 'loop', {
        role: 'action',
        text: loopStoryText(statement, sourceFile),
        fidelity: 'derived',
      }, children)
      return flow ? [flow] : []
    }

    const step = authoredStep(statement)
    if (step) {
      // The authored label is the concise action. Keep nested setup and checks,
      // but do not repeat every implementation action underneath it.
      const children = walkStatements(step.body.statements, [...path, 0], { includeActions: false })
      const description: StoryDescription = { role: 'action', text: step.label, fidelity: 'exact' }
      const flow = flowCandidate(statement, path, 'scope', description, children)
      const candidate = flow ?? stepCandidate(statement, path, description, options)
      return candidate ? [candidate] : []
    }

    const assertion = renderAssertionStatement(statement, sourceFile)
    if (assertion) {
      if (assertion.fidelity === 'exact' || assertion.fidelity === 'derived') {
        return [{
          kind: 'step',
          ...decorate(statement, path, { ...assertion, fidelity: assertion.fidelity }),
        }]
      }
      const genericAssertion = renderGenericAssertionStatement(statement, sourceFile)
      if (genericAssertion && (genericAssertion.fidelity === 'exact' || genericAssertion.fidelity === 'derived')) {
        return [{
          kind: 'step',
          ...decorate(statement, path, {
            text: genericAssertion.text,
            role: genericAssertion.role,
            fidelity: genericAssertion.fidelity,
          }),
        }]
      }
      return []
    }

    if (ts.isBreakStatement(statement)) {
      const candidate = stepCandidate(statement, path, {
        role: 'action',
        text: statement.label
          ? `Leave ${exactIdentifierText(statement.label.text)}`
          : options.breakTarget === 'switch'
            ? 'Leave this switch'
            : 'Stop this loop',
        fidelity: 'derived',
      }, options)
      return candidate ? [candidate] : []
    }
    if (ts.isContinueStatement(statement)) {
      const candidate = stepCandidate(statement, path, {
        role: 'action',
        text: statement.label
          ? `Continue with the next iteration of ${exactIdentifierText(statement.label.text)}`
          : 'Skip to the next iteration',
        fidelity: 'derived',
      }, options)
      return candidate ? [candidate] : []
    }

    const alias = variableAlias(statement)
    if (alias) aliases.set(alias.name, polishStoryText(alias.text))

    const call = callFromStatement(statement)
    if (call) {
      const promise = promiseCombinatorCandidate(statement, path, call, options)
      if (promise) return [promise]
      const retry = retryFlow(statement, path, call, options)
      if (retry) return [retry]
    }

    const conditional = conditionalExpressionCandidate(statement, path, options)
    if (conditional) return [conditional]

    const sequence = sequenceExpressionCandidate(statement, path, options)
    if (sequence) return [sequence]

    const shortCircuit = shortCircuitCandidate(statement, path, options)
    if (shortCircuit) return [shortCircuit]

    const renderedAction = renderActionStatement(statement, sourceFile)
    const assigned = assignedIdentifier(statement)
    const renderedDescription = renderedAction
      && (renderedAction.fidelity === 'exact' || renderedAction.fidelity === 'derived')
      && (renderedAction.role === 'setup' || renderedAction.role === 'action')
      ? {
          text: `${renderedAction.text}${assigned && renderedAction.role === 'action' ? `, saving the result as ${exactIdentifierText(assigned)}` : ''}`,
          role: renderedAction.role,
          fidelity: renderedAction.fidelity,
        } satisfies StoryDescription
      : undefined
    const lookupDescription = call
      && assigned
      && ts.isPropertyAccessExpression(call.expression)
      && call.expression.name.text === 'find'
      ? collectionLookupDescription(call, sourceFile, assigned)
      : undefined
    const genericDescription = !renderedAction ? genericCallStory(statement, sourceFile) : undefined
    const requestDescription = call && requestCallDescription(call, sourceFile, assigned)
    const mapping = call && mappingDescription(statement, call, sourceFile)
    const mutation = call && collectionMutationDescription(statement, call, sourceFile)
    const destructuring = destructuringDescription(statement, sourceFile)
    const templateDescription = variableTemplateDescription(statement, sourceFile)
    const valueDescription = variableValueDescription(statement, sourceFile)
    const description = mapping
      ?? templateDescription
      ?? lookupDescription
      ?? destructuring
      ?? mutation
      ?? renderedDescription
      ?? requestDescription
      ?? genericDescription
      ?? valueDescription

    if (call) {
      const callbacks = callbackArgumentsFor(call)
      const callbackChildren = callbacks.flatMap(({ argumentIndex, callback }) => (
        callbackCandidates(callback, [...path, argumentIndex], options)
      ))
      if (description && callbackChildren.length) {
        const loopDescription = loopCallbackDescription(call, callbacks[0].callback, sourceFile)
        return [populatedFlowCandidate(
          statement,
          path,
          loopDescription ? 'loop' : 'scope',
          loopDescription ?? callbackScopeText(description, callbacks[0].callback),
          callbackChildren,
        )]
      }
      // A wrapper whose own meaning is unknown may still contain proven checks.
      if (!description && callbackChildren.length) return callbackChildren
    }

    const candidate = description ? stepCandidate(statement, path, description, options) : undefined
    return candidate ? [candidate] : []
  }

  return walkStatements(statements, [], { includeActions: true })
}
