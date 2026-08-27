import { createHash } from 'node:crypto'
import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import {
  READABLE_TEST_VERSION,
  type ReadableBranchPath,
  type ReadableLeafNode,
  type ReadableLoopKind,
  type ReadableNode,
  type ReadableSource,
  type ReadableTest,
} from '../../../../../shared/readable-tests/types'
import {
  UnsupportedSyntaxKindError,
  catchHeaderEnglish,
  finallyHeaderEnglish,
  ifPathHeaderEnglish,
  statementEnglish,
  statementHeaderEnglish,
  switchPathHeaderEnglish,
} from '../controlled-english/ast-to-ir'
import { parseSource } from '../controlled-english/compiler-context'
import { renderEnglish } from '../controlled-english/english-renderer'

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

function containsIncomplete(node: ReadableNode): boolean {
  if (node.fidelity === 'unsupported' || node.fidelity === 'unresolved') return true
  if (node.kind === 'group' || node.kind === 'loop') return node.children.some(containsIncomplete)
  if (node.kind === 'branch') {
    return node.paths.some(
      (path) => path.fidelity === 'unsupported'
        || path.fidelity === 'unresolved'
        || path.children.some(containsIncomplete),
    )
  }
  return false
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
  const { sourceFile } = parseSource(input.file, wrapped)
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
): ReadableBranchPath {
  const source = sourceFor(node, context.sourceFile, context.file, context.lineOffset)
  return {
    id: stableNodeId(source, path),
    text,
    fidelity: 'derived',
    source,
    children: statements.map((statement, index) => translateStatement(statement, [...path, index], context)),
  }
}

function translateLoopStatement(
  statement: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement | ts.WhileStatement | ts.DoStatement,
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset)
  let loopKind: ReadableLoopKind
  if (ts.isForStatement(statement)) loopKind = 'for'
  else if (ts.isForInStatement(statement)) loopKind = 'for-in'
  else if (ts.isForOfStatement(statement)) loopKind = statement.awaitModifier ? 'for-await-of' : 'for-of'
  else loopKind = ts.isWhileStatement(statement) ? 'while' : 'do-while'

  return {
    id: stableNodeId(source, path),
    kind: 'loop',
    loopKind,
    text: renderEnglish(statementHeaderEnglish(statement)),
    fidelity: 'derived',
    source,
    children: nestedStatements(statement.statement).map(
      (child, index) => translateStatement(child, [...path, index], context),
    ),
  }
}

function translateIfStatement(
  statement: ts.IfStatement,
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset)
  const paths: ReadableBranchPath[] = [
    branchPath(
      renderEnglish(ifPathHeaderEnglish(statement, 'then')),
      statement.thenStatement,
      nestedStatements(statement.thenStatement),
      [...path, 0],
      context,
    ),
  ]
  if (statement.elseStatement) {
    paths.push(branchPath(
      renderEnglish(ifPathHeaderEnglish(statement, 'otherwise')),
      statement.elseStatement,
      nestedStatements(statement.elseStatement),
      [...path, 1],
      context,
    ))
  }
  return {
    id: stableNodeId(source, path),
    kind: 'branch',
    text: renderEnglish(statementHeaderEnglish(statement)),
    fidelity: 'derived',
    source,
    paths,
  }
}

function translateSwitchStatement(
  statement: ts.SwitchStatement,
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset)
  const paths = statement.caseBlock.clauses.map((caseClause, index) => branchPath(
    renderEnglish(switchPathHeaderEnglish(statement, index)),
    caseClause,
    caseClause.statements,
    [...path, index],
    context,
  ))
  return {
    id: stableNodeId(source, path),
    kind: 'branch',
    text: renderEnglish(statementHeaderEnglish(statement)),
    fidelity: 'derived',
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
  const children = statement.tryBlock.statements.map(
    (child, index) => translateStatement(child, [...path, index], context),
  )
  let nextIndex = children.length
  if (statement.catchClause) {
    children.push(translatedGroup(
      renderEnglish(catchHeaderEnglish(statement)),
      statement.catchClause,
      statement.catchClause.block.statements,
      [...path, nextIndex],
      context,
    ))
    nextIndex += 1
  }
  if (statement.finallyBlock) {
    children.push(translatedGroup(
      renderEnglish(finallyHeaderEnglish(statement)),
      statement.finallyBlock,
      statement.finallyBlock.statements,
      [...path, nextIndex],
      context,
    ))
  }
  return {
    id: stableNodeId(source, path),
    kind: 'group',
    text: renderEnglish(statementHeaderEnglish(statement)),
    fidelity: 'derived',
    source,
    children,
  }
}

function unsupportedLeaf(
  source: ReadableSource,
  path: number[],
  error: UnsupportedSyntaxKindError,
): ReadableLeafNode {
  return {
    id: stableNodeId(source, path),
    kind: 'leaf',
    role: 'syntax',
    text: error.message,
    fidelity: 'unsupported',
    source,
  }
}

function controlledLeaf(statement: ts.Statement, source: ReadableSource, path: number[]): ReadableLeafNode {
  return {
    id: stableNodeId(source, path),
    kind: 'leaf',
    role: 'syntax',
    text: renderEnglish(statementEnglish(statement)),
    fidelity: 'derived',
    source,
  }
}

function translateSupportedStatement(
  statement: ts.Statement,
  path: number[],
  context: TranslationContext,
  source: ReadableSource,
): ReadableNode {
  if (ts.isIfStatement(statement)) return translateIfStatement(statement, path, context)
  if (ts.isSwitchStatement(statement)) return translateSwitchStatement(statement, path, context)
  if (ts.isTryStatement(statement)) return translateTryStatement(statement, path, context)
  if (ts.isBlock(statement)) {
    return translatedGroup(
      renderEnglish(statementHeaderEnglish(statement)),
      statement,
      statement.statements,
      path,
      context,
    )
  }
  if (
    ts.isForStatement(statement)
    || ts.isForInStatement(statement)
    || ts.isForOfStatement(statement)
    || ts.isWhileStatement(statement)
    || ts.isDoStatement(statement)
  ) {
    return translateLoopStatement(statement, path, context)
  }

  const step = authoredStep(statement)
  if (step) {
    return {
      id: stableNodeId(source, path),
      kind: 'group',
      text: step.label,
      fidelity: 'exact',
      source,
      children: step.body.statements.map(
        (child, index) => translateStatement(child, [...path, index], context),
      ),
    }
  }

  const helperName = namedHelperCall(statement)
  if (helperName) {
    const text = renderEnglish(statementEnglish(statement))
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
      }
      return {
        id: stableNodeId(source, path),
        kind: 'group',
        origin: 'helper',
        text,
        fidelity: 'derived',
        source,
        children: parsed.body.statements.map(
          (child, index) => translateStatement(child, [...path, index], helperContext),
        ),
      }
    }
  }

  return controlledLeaf(statement, source, path)
}

function translateStatement(
  statement: ts.Statement,
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset)
  try {
    return translateSupportedStatement(statement, path, context, source)
  } catch (error) {
    if (error instanceof UnsupportedSyntaxKindError) return unsupportedLeaf(source, path, error)
    throw error
  }
}

function translatedTest(title: string, nodes: ReadableNode[]): ReadableTest {
  return {
    version: READABLE_TEST_VERSION,
    title,
    completeness: nodes.some(containsIncomplete) ? 'partial' : 'complete',
    nodes,
  }
}

export function translateReadableTest(input: ReadableTestInput): ReadableTest {
  const { body, sourceFile, lineOffset } = parseBody(input)
  const context: TranslationContext = {
    file: input.file,
    lineOffset,
    sourceFile,
    helpers: new Map((input.helpers ?? []).map((helper) => [helper.name, helper])),
    activeHelpers: new Set(),
  }
  const nodes = body.statements.map((statement, index) => translateStatement(statement, [index], context))
  return translatedTest(input.title, nodes)
}

/** Uses an already-parsed test callback so AST extraction and readable
 * translation share the same source tree and exact positions. */
export function translateReadableTestFromAst(input: ReadableTestAstInput): ReadableTest {
  const context: TranslationContext = {
    file: input.file,
    // The supplied source file already carries absolute positions. Convert its
    // zero-based line indexes directly to one-based source lines.
    lineOffset: 1,
    sourceFile: input.sourceFile,
    helpers: new Map((input.helpers ?? []).map((helper) => [helper.name, helper])),
    activeHelpers: new Set(),
  }
  const nodes = input.body.statements.map((statement, index) => translateStatement(statement, [index], context))
  return translatedTest(input.title, nodes)
}
