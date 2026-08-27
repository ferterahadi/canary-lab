import ts from 'typescript'
import type {
  ReadableStoryFlowKind,
  ReadableStoryItem,
  ReadableStorySpan,
} from '../../../../../shared/readable-tests/types'
import { renderActionStatement } from './actions'
import { renderAssertionStatement } from './assertions'
import { expressionPath, renderExpression } from './expression'
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
}

const SETUP_CALL_VERBS = new Set(['build', 'configure', 'create', 'generate', 'make', 'mock', 'prepare', 'seed', 'setup'])
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
  while (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression
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

function readableList(items: readonly string[]): string {
  // Every caller checks for an empty collection before asking for prose.
  if (items.length < 2) return items[0]!
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
}

/** Story mode names top-level inputs without recursively expanding every helper.
 * `send(request, txId)` therefore keeps `request` and `txId`; a nested builder
 * is named as its result, while its internals stay in the setup step that made it. */
function storyArgument(
  argument: ts.Expression,
  sourceFile: ts.SourceFile,
  referencesOnly: boolean,
): string | undefined {
  if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return undefined
  if (ts.isIdentifier(argument)) {
    return /^(?:callback|handler|fn)$/i.test(argument.text) ? undefined : exactIdentifierText(argument.text)
  }
  const path = expressionPath(argument)
  if (path) return exactIdentifierText(path)
  let expression = argument
  while (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression
  if (ts.isCallExpression(expression)) {
    const name = calledName(expression)
    if (name) return `${humanizeIdentifier(name)} result`
  }
  if (referencesOnly) return undefined
  const rendered = renderExpression(argument, sourceFile)
  return rendered.fidelity === 'unresolved' ? undefined : rendered.text
}

function callArguments(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  preferReferences: boolean,
): string[] {
  const render = (referencesOnly: boolean): string[] => call.arguments.flatMap((argument) => {
    const rendered = storyArgument(argument, sourceFile, referencesOnly)
    return rendered ? [rendered] : []
  })
  const references = render(true)
  return preferReferences && references.length ? references : render(false)
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
  const arguments_ = callArguments(call, sourceFile, true)
  const using = arguments_.length ? ` using ${readableList(arguments_)}` : ''

  if (first === 'expect' || first === 'assert' || first === 'check' || first === 'verify' || first === 'ensure') {
    return {
      role: 'check',
      text: sentenceCase(`check ${readableObject(rest) || 'the expected outcome'}${using}`),
      fidelity: 'derived',
    }
  }
  if (first === 'with') {
    return {
      role: 'setup',
      text: sentenceCase(`use ${readableObject(rest) || 'the required test context'}${using}`),
      fidelity: 'derived',
    }
  }

  if ((first === 'poll' || first === 'wait') && rest.every((word) => word === 'for' || word === 'until')) {
    const assignedName = assigned ?? assignedNameFromStatement(sourceText)
    return {
      role: 'action',
      text: `Wait for ${assignedName ? exactIdentifierText(assignedName) : 'the expected result'}${using}`,
      fidelity: 'derived',
    }
  }

  const setup = setupLikeStatement(sourceText)
    || SETUP_CALL_VERBS.has(first)
  if (setup && assigned && SETUP_CALL_VERBS.has(first)) {
    const creationInputs = callArguments(call, sourceFile, false)
    const creationUsing = creationInputs.length ? ` using ${readableList(creationInputs)}` : ''
    return {
      role: 'setup',
      text: `Create variable ${exactIdentifierText(assigned)}${creationUsing}`,
      fidelity: 'derived',
    }
  }
  const saveResult = assigned && !setup ? `, saving the result as ${exactIdentifierText(assigned)}` : ''
  return {
    role: setup ? 'setup' : 'action',
    text: `${readableActionName(name, sourceText)}${using}${saveResult}`,
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
    .replace(/\bwhats app\b/gi, 'WhatsApp')
    .replace(/\bsql\b/gi, 'SQL')
    .replace(/\bsms\b/gi, 'SMS')
    .replace(/\bjson\b/gi, 'JSON')
    .replace(/\bhttp\b/gi, 'HTTP')
    .replace(/\bapi\b/gi, 'API')
    .replace(/\burl\b/gi, 'URL')
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
    for (const phrase of [name, alias, humanizeIdentifier(name)]) {
      if (phrase && lowerText.includes(phrase.toLocaleLowerCase())) phrases.add(phrase)
    }
  }
  return [...phrases].sort((a, b) => b.length - a.length || a.localeCompare(b))
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9]/.test(value)
}

function variableSpans(text: string, phrases: readonly string[]): ReadableStorySpan[] {
  const lowerText = text.toLocaleLowerCase()
  const occupied = new Array<boolean>(text.length).fill(false)
  const ranges: Array<{ start: number; end: number }> = []

  for (const phrase of phrases) {
    const lowerPhrase = phrase.toLocaleLowerCase()
    let from = 0
    while (from < text.length) {
      const start = lowerText.indexOf(lowerPhrase, from)
      if (start < 0) break
      const end = start + phrase.length
      const bounded = !isWordCharacter(text[start - 1]) && !isWordCharacter(text[end])
      const free = occupied.slice(start, end).every((value) => !value)
      if (bounded && free) {
        ranges.push({ start, end })
        for (let index = start; index < end; index += 1) occupied[index] = true
      }
      from = Math.max(end, start + 1)
    }
  }

  if (!ranges.length) return [{ text }]
  ranges.sort((a, b) => a.start - b.start)
  const spans: ReadableStorySpan[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) spans.push({ text: text.slice(cursor, range.start) })
    spans.push({ text: text.slice(range.start, range.end), kind: 'variable' })
    cursor = range.end
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor) })
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
    const source = storyArgument(statement.expression, sourceFile, false)
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
    : storyArgument(receiver, sourceFile, false)
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
  const source = storyArgument(call.expression.expression, sourceFile, false)
  if (!parameter || !source) return undefined
  const asynchronous = callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  return {
    role: 'action',
    text: `For each ${exactIdentifierText(parameter)} in ${source}${asynchronous ? '; asynchronous work may overlap' : ''}`,
    fidelity: 'derived',
  }
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
      spans: variableSpans(text, variablePhrases(node, text, aliases)),
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
        const children = walkStatements(clause.statements, [...path, index], options)
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
      const children = walkStatement(statement.statement, [...path, 0], options)
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
      return []
    }

    if (ts.isBreakStatement(statement)) {
      const candidate = stepCandidate(statement, path, {
        role: 'action',
        text: 'Stop this loop',
        fidelity: 'derived',
      }, options)
      return candidate ? [candidate] : []
    }
    if (ts.isContinueStatement(statement)) {
      const candidate = stepCandidate(statement, path, {
        role: 'action',
        text: 'Skip to the next iteration',
        fidelity: 'derived',
      }, options)
      return candidate ? [candidate] : []
    }

    const alias = variableAlias(statement)
    if (alias) aliases.set(alias.name, polishStoryText(alias.text))

    const call = callFromStatement(statement)
    if (call) {
      const retry = retryFlow(statement, path, call, options)
      if (retry) return [retry]
    }

    const renderedAction = renderActionStatement(statement, sourceFile)
    const renderedDescription = renderedAction
      && (renderedAction.fidelity === 'exact' || renderedAction.fidelity === 'derived')
      && (renderedAction.role === 'setup' || renderedAction.role === 'action')
      ? {
          text: renderedAction.text,
          role: renderedAction.role,
          fidelity: renderedAction.fidelity,
        } satisfies StoryDescription
      : undefined
    const genericDescription = !renderedAction ? genericCallStory(statement, sourceFile) : undefined
    const mapping = call && mappingDescription(statement, call, sourceFile)
    const description = mapping ?? renderedDescription ?? genericDescription

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
