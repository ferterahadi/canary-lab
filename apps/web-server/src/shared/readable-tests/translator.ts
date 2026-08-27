import { createHash } from 'node:crypto'
import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import {
  READABLE_TEST_VERSION,
  type ReadableNode,
  type ReadableBranchPath,
  type ReadableLeafNode,
  type ReadableSource,
  type ReadableTest,
} from '../../../../../shared/readable-tests/types'
import { renderActionStatement } from './actions'
import { renderAssertionStatement } from './assertions'
import { renderCondition, renderExpression } from './expression'
import { readableHelperName } from './language'

export interface ReadableHelperInput {
  name: string
  file: string
  bodySource: string
  // Line containing the helper body's opening brace in the definition file.
  startLine?: number
}

export interface ReadableTestInput {
  file: string
  title: string
  bodySource: string
  // Line containing the callback body's opening brace in the original file.
  startLine?: number
  helpers?: ReadableHelperInput[]
}

export interface ReadableTestAstInput {
  file: string
  title: string
  sourceFile: ts.SourceFile
  body: ts.Block
  helpers?: ReadableHelperInput[]
}

interface TranslationContext {
  file: string
  lineOffset: number
  sourceFile: ts.SourceFile
  helpers: Map<string, ReadableHelperInput>
  activeHelpers: Set<string>
  controlStack: Array<'loop' | 'switch'>
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.js')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function sourceFor(node: ts.Node, sourceFile: ts.SourceFile, file: string, lineOffset: number): ReadableSource {
  const start = node.getStart(sourceFile)
  const end = Math.max(start, node.getEnd() - 1)
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start)
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end)

  return {
    file,
    startLine: lineOffset + startPosition.line,
    endLine: lineOffset + endPosition.line,
    snippet: formatSourceSnippetForDisplay(node.getText(sourceFile)),
  }
}

function stableNodeId(source: ReadableSource, path: number[]): string {
  // The id changes with source or translator structure, but never with render time.
  // UI consumers treat it as opaque; exact source positions remain the durable link.
  const fingerprint = [
    READABLE_TEST_VERSION,
    source.file,
    source.startLine,
    source.endLine,
    source.snippet,
    path.join('.'),
  ].join('\u0000')

  return `rt_${createHash('sha256').update(fingerprint).digest('hex').slice(0, 12)}`
}

function containsUnresolved(node: ReadableNode): boolean {
  if (node.fidelity === 'unresolved') return true
  if (node.kind === 'group' || node.kind === 'loop') return node.children.some(containsUnresolved)
  if (node.kind === 'branch') {
    return node.paths.some((path) => path.fidelity === 'unresolved' || path.children.some(containsUnresolved))
  }
  return false
}

function containsMeaningfulTranslation(node: ReadableNode): boolean {
  if (node.kind === 'leaf') return node.fidelity !== 'unresolved'
  if (node.kind === 'group') {
    return node.fidelity === 'exact' || node.children.some(containsMeaningfulTranslation)
  }
  if (node.kind === 'loop') {
    return node.fidelity !== 'unresolved' || node.children.some(containsMeaningfulTranslation)
  }
  return node.fidelity !== 'unresolved'
    || node.paths.some((path) => path.fidelity !== 'unresolved' || path.children.some(containsMeaningfulTranslation))
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

function authoredStep(
  statement: ts.Statement,
): { label: string; body: ts.Block } | undefined {
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
  const label = call.arguments[0]
  const callback = call.arguments[1]
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

function namedHelperCall(statement: ts.Statement): string | undefined {
  const call = callFromStatement(statement)
  return call && ts.isIdentifier(call.expression) ? call.expression.text : undefined
}

function parseBody(input: ReadableTestInput): { body: ts.Block; sourceFile: ts.SourceFile; lineOffset: number } {
  const trimmedBody = input.bodySource.trim()
  const bodySource = trimmedBody.startsWith('{') ? input.bodySource : `{ ${input.bodySource} }`
  const wrapped = `async function __canaryReadableBody() ${bodySource}`
  const sourceFile = ts.createSourceFile(
    input.file,
    wrapped,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(input.file),
  )
  return {
    sourceFile,
    // The source string above always declares this function with a block body.
    body: (sourceFile.statements[0] as ts.FunctionDeclaration).body as ts.Block,
    lineOffset: input.startLine ?? 1,
  }
}

function nestedStatements(statement: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(statement) ? statement.statements : [statement]
}

function branchPath(
  text: string,
  node: ts.Node,
  statements: readonly ts.Statement[],
  path: number[],
  context: TranslationContext,
  fidelity: ReadableBranchPath['fidelity'] = 'derived',
): ReadableBranchPath {
  const source = sourceFor(node, context.sourceFile, context.file, context.lineOffset)
  return {
    id: stableNodeId(source, path),
    text,
    fidelity,
    source,
    children: statements.map((statement, index) => translateStatement(statement, [...path, index], context)),
  }
}

function renderForInitializer(
  initializer: ts.ForInitializer | undefined,
  sourceFile: ts.SourceFile,
): { text: string; fidelity: 'derived' | 'unresolved' } {
  if (!initializer) return { text: 'use no initializer', fidelity: 'derived' }
  if (!ts.isVariableDeclarationList(initializer)) {
    const rendered = renderExpression(initializer, sourceFile)
    return { text: rendered.text, fidelity: rendered.fidelity === 'unresolved' ? 'unresolved' : 'derived' }
  }
  const declarations: string[] = []
  let unresolved = false
  for (const declaration of initializer.declarations) {
    if (!ts.isIdentifier(declaration.name)) {
      unresolved = true
      declarations.push(formatSourceSnippetForDisplay(declaration.getText(sourceFile)))
      continue
    }
    const name = readableHelperName(declaration.name.text).toLowerCase()
    if (!declaration.initializer) {
      declarations.push(`use ${name}`)
      continue
    }
    const value = renderExpression(declaration.initializer, sourceFile)
    if (value.fidelity === 'unresolved') unresolved = true
    declarations.push(`${name} starts at ${value.text}`)
  }
  return {
    text: declarations.join(' and '),
    fidelity: unresolved ? 'unresolved' : 'derived',
  }
}

function renderForUpdate(
  incrementor: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): { text: string; fidelity: 'derived' | 'unresolved' } {
  if (!incrementor) return { text: 'use no update', fidelity: 'derived' }
  if (ts.isPostfixUnaryExpression(incrementor) || ts.isPrefixUnaryExpression(incrementor)) {
    if (incrementor.operator === ts.SyntaxKind.PlusPlusToken || incrementor.operator === ts.SyntaxKind.MinusMinusToken) {
      const operand = renderExpression(incrementor.operand, sourceFile)
      if (operand.fidelity === 'unresolved') return { text: incrementor.getText(sourceFile), fidelity: 'unresolved' }
      return {
        text: `${incrementor.operator === ts.SyntaxKind.PlusPlusToken ? 'increase' : 'decrease'} ${operand.text} by 1`,
        fidelity: 'derived',
      }
    }
  }
  if (
    ts.isBinaryExpression(incrementor)
    && (incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken || incrementor.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken)
  ) {
    const left = renderExpression(incrementor.left, sourceFile)
    const right = renderExpression(incrementor.right, sourceFile)
    if (left.fidelity === 'unresolved' || right.fidelity === 'unresolved') {
      return { text: incrementor.getText(sourceFile), fidelity: 'unresolved' }
    }
    return {
      text: `${incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? 'increase' : 'decrease'} ${left.text} by ${right.text}`,
      fidelity: 'derived',
    }
  }
  const rendered = renderExpression(incrementor, sourceFile)
  return { text: rendered.text, fidelity: rendered.fidelity === 'unresolved' ? 'unresolved' : 'derived' }
}

function forOfVariable(
  initializer: ts.ForInitializer,
  sourceFile: ts.SourceFile,
): { text: string; fidelity: 'derived' | 'unresolved' } {
  if (ts.isVariableDeclarationList(initializer) && initializer.declarations.length === 1) {
    const name = initializer.declarations[0].name
    if (ts.isIdentifier(name)) return { text: readableHelperName(name.text).toLowerCase(), fidelity: 'derived' }
  }
  if (!ts.isVariableDeclarationList(initializer)) {
    const rendered = renderExpression(initializer, sourceFile)
    return { text: rendered.text, fidelity: rendered.fidelity === 'unresolved' ? 'unresolved' : 'derived' }
  }
  return { text: formatSourceSnippetForDisplay(initializer.getText(sourceFile)), fidelity: 'unresolved' }
}

function integerLiteral(expression: ts.Expression | undefined): number | undefined {
  if (!expression) return undefined
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text.replace(/_/g, ''))
    return Number.isSafeInteger(value) ? value : undefined
  }
  if (
    ts.isPrefixUnaryExpression(expression)
    && (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken)
  ) {
    const value = integerLiteral(expression.operand)
    if (value === undefined) return undefined
    return expression.operator === ts.SyntaxKind.MinusToken ? -value : value
  }
  return undefined
}

function counterUpdate(incrementor: ts.Expression | undefined, counter: string): number | undefined {
  if (!incrementor) return undefined
  if (
    (ts.isPostfixUnaryExpression(incrementor) || ts.isPrefixUnaryExpression(incrementor))
    && ts.isIdentifier(incrementor.operand)
    && incrementor.operand.text === counter
  ) {
    if (incrementor.operator === ts.SyntaxKind.PlusPlusToken) return 1
    if (incrementor.operator === ts.SyntaxKind.MinusMinusToken) return -1
  }
  if (
    ts.isBinaryExpression(incrementor)
    && ts.isIdentifier(incrementor.left)
    && incrementor.left.text === counter
    && (incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken || incrementor.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken)
  ) {
    const amount = integerLiteral(incrementor.right)
    if (amount === undefined) return undefined
    return incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? amount : -amount
  }
  return undefined
}

function bodyPreservesCounter(statement: ts.Statement, counter: string): boolean {
  let safe = true
  const assignmentOperators = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
  ])
  const visit = (node: ts.Node): void => {
    if (!safe) return
    if (ts.isBreakStatement(node) || ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      safe = false
      return
    }
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node))
      && ts.isIdentifier(node.operand)
      && node.operand.text === counter
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      safe = false
      return
    }
    if (
      ts.isBinaryExpression(node)
      && assignmentOperators.has(node.operatorToken.kind)
      && ts.isIdentifier(node.left)
      && node.left.text === counter
    ) {
      safe = false
      return
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
      safe = false
      return
    }
    node.forEachChild(visit)
  }
  visit(statement)
  return safe
}

function staticallyProvableCount(statement: ts.ForStatement): number | undefined {
  if (!statement.initializer || !ts.isVariableDeclarationList(statement.initializer)) return undefined
  if (statement.initializer.declarations.length !== 1) return undefined
  const declaration = statement.initializer.declarations[0]
  if (!ts.isIdentifier(declaration.name)) return undefined
  const counter = declaration.name.text
  const start = integerLiteral(declaration.initializer)
  if (start === undefined || !statement.condition || !ts.isBinaryExpression(statement.condition)) return undefined
  if (!ts.isIdentifier(statement.condition.left) || statement.condition.left.text !== counter) return undefined
  const bound = integerLiteral(statement.condition.right)
  const step = counterUpdate(statement.incrementor, counter)
  if (bound === undefined || step === undefined || step === 0 || !bodyPreservesCounter(statement.statement, counter)) return undefined

  let count: number | undefined
  if (step > 0 && statement.condition.operatorToken.kind === ts.SyntaxKind.LessThanToken) {
    count = start >= bound ? 0 : Math.ceil((bound - start) / step)
  } else if (step > 0 && statement.condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken) {
    count = start > bound ? 0 : Math.floor((bound - start) / step) + 1
  } else if (step < 0 && statement.condition.operatorToken.kind === ts.SyntaxKind.GreaterThanToken) {
    count = start <= bound ? 0 : Math.ceil((start - bound) / -step)
  } else if (step < 0 && statement.condition.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken) {
    count = start < bound ? 0 : Math.floor((start - bound) / -step) + 1
  }
  return count !== undefined && Number.isSafeInteger(count) ? count : undefined
}

function translateLoopStatement(
  statement: ts.ForStatement | ts.ForOfStatement | ts.WhileStatement | ts.DoStatement,
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset)
  let text: string
  let loopKind: 'for' | 'for-of' | 'for-await-of' | 'while' | 'do-while'
  let fidelity: 'derived' | 'unresolved' = 'derived'

  if (ts.isForStatement(statement)) {
    loopKind = 'for'
    const initializer = renderForInitializer(statement.initializer, context.sourceFile)
    const condition = statement.condition
      ? renderCondition(statement.condition, context.sourceFile)
      : { text: 'no source condition', fidelity: 'derived' as const }
    const update = renderForUpdate(statement.incrementor, context.sourceFile)
    if (initializer.fidelity === 'unresolved' || condition.fidelity === 'unresolved' || update.fidelity === 'unresolved') fidelity = 'unresolved'
    text = `For ${initializer.text}; while ${condition.text}; ${update.text}`
  } else if (ts.isForOfStatement(statement)) {
    loopKind = statement.awaitModifier ? 'for-await-of' : 'for-of'
    const variable = forOfVariable(statement.initializer, context.sourceFile)
    const collection = renderExpression(statement.expression, context.sourceFile)
    if (variable.fidelity === 'unresolved' || collection.fidelity === 'unresolved') fidelity = 'unresolved'
    text = statement.awaitModifier
      ? `For each ${variable.text} received from ${collection.text}`
      : `For each ${variable.text} in ${collection.text}`
  } else {
    const condition = renderCondition(statement.expression, context.sourceFile)
    if (condition.fidelity === 'unresolved') fidelity = 'unresolved'
    if (ts.isWhileStatement(statement)) {
      loopKind = 'while'
      text = `While ${condition.text} is true`
    } else {
      loopKind = 'do-while'
      text = `Run once, then repeat while ${condition.text} is true`
    }
  }

  const bodyContext: TranslationContext = {
    ...context,
    controlStack: [...context.controlStack, 'loop'],
  }
  const count = ts.isForStatement(statement) ? staticallyProvableCount(statement) : undefined
  if (count !== undefined) {
    text = `Repeat ${count} ${count === 1 ? 'time' : 'times'}`
    fidelity = 'derived'
  }
  return {
    id: stableNodeId(source, path),
    kind: 'loop',
    loopKind,
    text,
    fidelity,
    source,
    children: nestedStatements(statement.statement).map((child, index) => translateStatement(child, [...path, index], bodyContext)),
    ...(count !== undefined ? { count } : {}),
  }
}

function translateLoopControl(
  statement: ts.BreakStatement | ts.ContinueStatement,
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset)
  if (statement.label) {
    return unresolvedLeaf(source, path)
  }
  const nearestBreakTarget = context.controlStack.at(-1)
  const hasLoopTarget = context.controlStack.includes('loop')
  if ((ts.isBreakStatement(statement) && nearestBreakTarget) || (ts.isContinueStatement(statement) && hasLoopTarget)) {
    return {
      id: stableNodeId(source, path),
      kind: 'leaf',
      role: 'action',
      text: ts.isContinueStatement(statement)
        ? 'Skip to the next item'
        : nearestBreakTarget === 'loop'
          ? 'Stop repeating'
          : 'Leave this decision',
      fidelity: 'derived',
      source,
    }
  }
  return unresolvedLeaf(source, path)
}

function unresolvedLeaf(source: ReadableSource, path: number[]): ReadableLeafNode {
  return {
    id: stableNodeId(source, path),
    kind: 'leaf',
    role: 'unknown',
    text: 'Review this source step',
    fidelity: 'unresolved',
    source,
  }
}

function translateIfStatement(
  statement: ts.IfStatement,
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset)
  const condition = renderCondition(statement.expression, context.sourceFile)
  const paths: ReadableBranchPath[] = [
    branchPath('Then', statement.thenStatement, nestedStatements(statement.thenStatement), [...path, 0], context),
  ]
  if (statement.elseStatement) {
    paths.push(branchPath('Otherwise', statement.elseStatement, nestedStatements(statement.elseStatement), [...path, 1], context))
  }
  return {
    id: stableNodeId(source, path),
    kind: 'branch',
    text: `If ${condition.text}`,
    fidelity: condition.fidelity === 'unresolved' ? 'unresolved' : 'derived',
    source,
    paths,
  }
}

function switchClauseFallsThrough(clause: ts.CaseOrDefaultClause, isLast: boolean): boolean {
  if (isLast || !clause.statements.length) return !isLast
  const last = clause.statements[clause.statements.length - 1]
  return !(ts.isBreakStatement(last) || ts.isReturnStatement(last) || ts.isThrowStatement(last))
}

function translateSwitchStatement(
  statement: ts.SwitchStatement,
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset)
  const subject = renderExpression(statement.expression, context.sourceFile)
  const switchContext: TranslationContext = {
    ...context,
    controlStack: [...context.controlStack, 'switch'],
  }
  const paths = statement.caseBlock.clauses.map((clause, index) => {
    const isLast = index === statement.caseBlock.clauses.length - 1
    const fallsThrough = switchClauseFallsThrough(clause, isLast)
    if (ts.isDefaultClause(clause)) {
      return branchPath(
        fallsThrough ? 'Otherwise, then continue to the next case' : 'Otherwise',
        clause,
        clause.statements,
        [...path, index],
        switchContext,
      )
    }
    const value = renderExpression(clause.expression, context.sourceFile)
    return branchPath(
      `When ${value.text}${fallsThrough ? ', then continue to the next case' : ''}`,
      clause,
      clause.statements,
      [...path, index],
      switchContext,
      value.fidelity === 'unresolved' ? 'unresolved' : 'derived',
    )
  })
  return {
    id: stableNodeId(source, path),
    kind: 'branch',
    text: `Choose based on ${subject.text}`,
    fidelity: subject.fidelity === 'unresolved' ? 'unresolved' : 'derived',
    source,
    paths,
  }
}

function translatedGroup(
  text: string,
  node: ts.Node,
  statements: readonly ts.Statement[],
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const source = sourceFor(node, context.sourceFile, context.file, context.lineOffset)
  return {
    id: stableNodeId(source, path),
    kind: 'group',
    text,
    fidelity: 'derived',
    source,
    children: statements.map((statement, index) => translateStatement(statement, [...path, index], context)),
  }
}

function translateTryStatement(
  statement: ts.TryStatement,
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset)
  const children = statement.tryBlock.statements.map((child, index) => translateStatement(child, [...path, index], context))
  let nextIndex = children.length
  if (statement.catchClause) {
    children.push(translatedGroup(
      'If an error occurs',
      statement.catchClause.block,
      statement.catchClause.block.statements,
      [...path, nextIndex],
      context,
    ))
    nextIndex += 1
  }
  if (statement.finallyBlock) {
    children.push(translatedGroup(
      'Always afterward',
      statement.finallyBlock,
      statement.finallyBlock.statements,
      [...path, nextIndex],
      context,
    ))
  }
  return {
    id: stableNodeId(source, path),
    kind: 'group',
    text: 'Try these steps',
    fidelity: 'derived',
    source,
    children,
  }
}

function translateStatement(
  statement: ts.Statement,
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const { sourceFile } = context
  const source = sourceFor(statement, sourceFile, context.file, context.lineOffset)
  if (ts.isIfStatement(statement)) return translateIfStatement(statement, path, context)
  if (ts.isSwitchStatement(statement)) return translateSwitchStatement(statement, path, context)
  if (ts.isTryStatement(statement)) return translateTryStatement(statement, path, context)
  if (ts.isBlock(statement)) return translatedGroup('Grouped steps', statement, statement.statements, path, context)
  if (ts.isForStatement(statement) || ts.isForOfStatement(statement) || ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
    return translateLoopStatement(statement, path, context)
  }
  if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) return translateLoopControl(statement, path, context)
  const step = authoredStep(statement)
  if (step) {
    return {
      id: stableNodeId(source, path),
      kind: 'group',
      text: step.label,
      fidelity: 'exact',
      source,
      children: step.body.statements.map((child, index) => translateStatement(child, [...path, index], context)),
    }
  }

  const leaf = renderAssertionStatement(statement, sourceFile) ?? renderActionStatement(statement, sourceFile)
  if (leaf) {
    return {
      id: stableNodeId(source, path),
      kind: 'leaf',
      role: leaf.role,
      text: leaf.text,
      fidelity: leaf.fidelity,
      source,
    }
  }

  const helperName = namedHelperCall(statement)
  if (helperName) {
    const helper = context.helpers.get(helperName)
    if (helper && !context.activeHelpers.has(helperName)) {
      const helperInput: ReadableTestInput = {
        file: helper.file,
        title: helper.name,
        bodySource: helper.bodySource,
        startLine: helper.startLine,
      }
      const parsed = parseBody(helperInput)
      const activeHelpers = new Set(context.activeHelpers)
      activeHelpers.add(helperName)
      const helperContext: TranslationContext = {
        file: helperInput.file,
        lineOffset: parsed.lineOffset,
        sourceFile: parsed.sourceFile,
        helpers: context.helpers,
        activeHelpers,
        controlStack: [],
      }
      const children = parsed.body.statements.map((child, index) => translateStatement(child, [...path, index], helperContext))
      if (children.some(containsMeaningfulTranslation)) {
        return {
          id: stableNodeId(source, path),
          kind: 'group',
          origin: 'helper',
          text: readableHelperName(helperName),
          fidelity: 'derived',
          source,
          children,
        }
      }
    }
    return {
      id: stableNodeId(source, path),
      kind: 'leaf',
      role: 'helper',
      text: readableHelperName(helperName),
      fidelity: 'derived',
      source,
    }
  }

  return unresolvedLeaf(source, path)
}

export function translateReadableTest(input: ReadableTestInput): ReadableTest {
  const { body, sourceFile, lineOffset } = parseBody(input)
  const context: TranslationContext = {
    file: input.file,
    lineOffset,
    sourceFile,
    helpers: new Map((input.helpers ?? []).map((helper) => [helper.name, helper])),
    activeHelpers: new Set(),
    controlStack: [],
  }
  const nodes: ReadableNode[] = body.statements.map((statement, index) => translateStatement(statement, [index], context))

  return {
    version: READABLE_TEST_VERSION,
    title: input.title,
    completeness: nodes.some(containsUnresolved) ? 'partial' : 'complete',
    nodes,
  }
}

/** Uses an already-parsed test callback so AST extraction and readable
 *  translation share the same source tree and exact positions. */
export function translateReadableTestFromAst(input: ReadableTestAstInput): ReadableTest {
  const context: TranslationContext = {
    file: input.file,
    // The supplied source file already carries absolute positions. Convert its
    // zero-based line indexes directly to one-based source lines.
    lineOffset: 1,
    sourceFile: input.sourceFile,
    helpers: new Map((input.helpers ?? []).map((helper) => [helper.name, helper])),
    activeHelpers: new Set(),
    controlStack: [],
  }
  const nodes = input.body.statements.map((statement, index) => translateStatement(statement, [index], context))
  return {
    version: READABLE_TEST_VERSION,
    title: input.title,
    completeness: nodes.some(containsUnresolved) ? 'partial' : 'complete',
    nodes,
  }
}
