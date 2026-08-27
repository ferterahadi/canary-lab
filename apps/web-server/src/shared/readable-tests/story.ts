import ts from 'typescript'
import type { ReadableStoryItem, ReadableStorySpan } from '../../../../../shared/readable-tests/types'
import { renderActionStatement } from './actions'
import { renderAssertionStatement } from './assertions'
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

export interface StoryCandidate {
  node: ts.Node
  role: StoryRole
  text: string
  spans: ReadableStorySpan[]
  fidelity: ReadableStoryItem['fidelity']
  path: number[]
}

interface WalkOptions {
  includeActions: boolean
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

function genericCallStory(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): Pick<StoryCandidate, 'role' | 'text' | 'fidelity'> | undefined {
  const call = callFromStatement(statement)
  const name = call ? calledName(call) : undefined
  if (!name) return undefined
  const words = identifierWords(name)
  const first = words[0]
  const rest = words.slice(1)
  if (!first) return undefined

  if (first === 'expect' || first === 'assert' || first === 'check' || first === 'verify' || first === 'ensure') {
    return {
      role: 'check',
      text: sentenceCase(`check ${readableObject(rest) || 'the expected outcome'}`),
      fidelity: 'derived',
    }
  }
  if (first === 'with') {
    return {
      role: 'setup',
      text: sentenceCase(`use ${readableObject(rest) || 'the required test context'}`),
      fidelity: 'derived',
    }
  }

  if ((first === 'poll' || first === 'wait') && rest.every((word) => word === 'for' || word === 'until')) {
    const assignedName = assignedNameFromStatement(statement.getText(sourceFile))
    return {
      role: 'action',
      text: `Wait for ${assignedName ? humanizeIdentifier(assignedName) : 'the expected result'}`,
      fidelity: 'derived',
    }
  }

  const sourceText = statement.getText(sourceFile)
  const setup = setupLikeStatement(sourceText)
    || ['build', 'configure', 'create', 'generate', 'make', 'mock', 'prepare', 'seed', 'setup'].includes(first)
  return {
    role: setup ? 'setup' : 'action',
    text: readableActionName(name, sourceText),
    fidelity: 'derived',
  }
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

function variablePhrases(
  statement: ts.Statement,
  text: string,
  aliases: ReadonlyMap<string, string>,
): string[] {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isIdentifierName(node)) names.add(node.text)
    node.forEachChild(visit)
  }
  visit(statement)

  const lowerText = text.toLocaleLowerCase()
  const phrases = new Set<string>()
  for (const name of names) {
    const alias = aliases.get(name)
    for (const phrase of [alias, humanizeIdentifier(name)]) {
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

function callbackBlocks(call: ts.CallExpression | undefined): ts.Block[] {
  if (!call) return []
  return call.arguments.flatMap((argument) => (
    (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) && ts.isBlock(argument.body)
      ? [argument.body]
      : []
  ))
}

/** Build the reader-first story from syntax already parsed for the exhaustive
 * translator. Unknown constructs are intentionally omitted here instead of
 * leaking raw code; the `nodes` tree remains the complete audit surface. */
export function storyCandidates(
  statements: readonly ts.Statement[],
  sourceFile: ts.SourceFile,
): StoryCandidate[] {
  const candidates: StoryCandidate[] = []
  const aliases = new Map<string, string>()

  const walkStatements = (
    nested: readonly ts.Statement[],
    basePath: number[],
    options: WalkOptions,
  ): void => {
    nested.forEach((statement, index) => walkStatement(statement, [...basePath, index], options))
  }

  const add = (
    statement: ts.Statement,
    path: number[],
    candidate: Pick<StoryCandidate, 'role' | 'text' | 'fidelity'>,
    options: WalkOptions,
  ): void => {
    if (candidate.role === 'action' && !options.includeActions) return
    const aliased = candidate.role === 'check' ? applySubjectAlias(candidate.text, aliases) : candidate.text
    const text = candidate.fidelity === 'derived' ? polishStoryText(aliased) : aliased
    candidates.push({
      ...candidate,
      text,
      spans: variableSpans(text, variablePhrases(statement, text, aliases)),
      node: statement,
      path,
    })
  }

  const walkStatement = (statement: ts.Statement, path: number[], options: WalkOptions): void => {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return
    if (ts.isBlock(statement)) {
      walkStatements(statement.statements, path, options)
      return
    }
    if (ts.isIfStatement(statement)) {
      walkStatement(statement.thenStatement, [...path, 0], options)
      if (statement.elseStatement) walkStatement(statement.elseStatement, [...path, 1], options)
      return
    }
    if (ts.isSwitchStatement(statement)) {
      statement.caseBlock.clauses.forEach((clause, index) => {
        walkStatements(clause.statements, [...path, index], options)
      })
      return
    }
    if (ts.isTryStatement(statement)) {
      walkStatements(statement.tryBlock.statements, [...path, 0], options)
      if (statement.catchClause) walkStatements(statement.catchClause.block.statements, [...path, 1], options)
      if (statement.finallyBlock) walkStatements(statement.finallyBlock.statements, [...path, 2], options)
      return
    }
    if (
      ts.isForStatement(statement)
      || ts.isForInStatement(statement)
      || ts.isForOfStatement(statement)
      || ts.isWhileStatement(statement)
      || ts.isDoStatement(statement)
    ) {
      walkStatement(statement.statement, [...path, 0], options)
      return
    }

    const step = authoredStep(statement)
    if (step) {
      add(statement, path, { role: 'action', text: step.label, fidelity: 'exact' }, options)
      // The authored label is the concise action. Keep nested setup and checks,
      // but do not repeat every implementation action underneath it.
      walkStatements(step.body.statements, [...path, 0], { includeActions: false })
      return
    }

    const assertion = renderAssertionStatement(statement, sourceFile)
    if (assertion) {
      if (assertion.fidelity === 'exact' || assertion.fidelity === 'derived') {
        add(statement, path, { ...assertion, fidelity: assertion.fidelity }, options)
      }
      return
    }

    const alias = variableAlias(statement)
    if (alias) aliases.set(alias.name, polishStoryText(alias.text))

    const renderedAction = renderActionStatement(statement, sourceFile)
    if (
      renderedAction
      && (renderedAction.fidelity === 'exact' || renderedAction.fidelity === 'derived')
      && (renderedAction.role === 'setup' || renderedAction.role === 'action')
    ) {
      add(statement, path, {
        text: renderedAction.text,
        role: renderedAction.role,
        fidelity: renderedAction.fidelity,
      }, options)
    }

    // A known rule that could not prove readable wording remains absent from
    // the story. Still inspect callback bodies: their setup and checks can be
    // independently proven even when the wrapper call itself cannot.
    if (!renderedAction) {
      const generic = genericCallStory(statement, sourceFile)
      if (generic) add(statement, path, generic, options)
    }

    callbackBlocks(callFromStatement(statement)).forEach((block, index) => {
      walkStatements(block.statements, [...path, index], options)
    })
  }

  walkStatements(statements, [], { includeActions: true })
  return candidates
}
