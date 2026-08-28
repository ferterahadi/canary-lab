import { createHash } from 'node:crypto'
import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import {
  READABLE_TEST_VERSION,
  type ReadableBranchPath,
  type ReadableEnglishBlock,
  type ReadableLeafNode,
  type ReadableLoopKind,
  type ReadableNode,
  type ReadableSemanticRuleConfig,
  type ReadableSource,
  type ReadableStoryItem,
  type ReadableTest,
  type ReadableTestStory,
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
import { renderEnglish } from '../controlled-english/english-renderer'
import { compileSemanticSource, type SemanticContext } from '../controlled-english/semantic-context'
import {
  composeCatchHeader,
  composeFinallyHeader,
  composeIfHeader,
  composeIfPath,
  composeLoopHeader,
  composeStatementEnglish,
  composeSwitchHeader,
  composeSwitchPath,
  composeTryHeader,
} from '../controlled-english/structured-english'
import { storyCandidates } from './story'

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
  semanticRules?: ReadableSemanticRuleConfig
  compilerOptions?: ts.CompilerOptions
}

export interface ReadableTestAstInput {
  file: string
  title: string
  sourceFile: ts.SourceFile
  body: ts.Block
  helpers?: ReadableHelperInput[]
  semanticContext?: SemanticContext
  semanticRules?: ReadableSemanticRuleConfig
  compilerOptions?: ts.CompilerOptions
}

interface TranslationContext {
  file: string
  lineOffset: number
  sourceFile: ts.SourceFile
  semanticContext: SemanticContext
  compilerOptions?: ts.CompilerOptions
  helpers: Map<string, ParsedHelper>
  activeHelpers: Set<string>
}

interface ParsedHelper {
  input: ReadableHelperInput
  body: ts.Block
  sourceFile: ts.SourceFile
  semanticContext: SemanticContext
  lineOffset: number
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

function parseBody(input: ReadableTestInput): {
  body: ts.Block
  sourceFile: ts.SourceFile
  semanticContext: SemanticContext
  lineOffset: number
} {
  const trimmedBody = input.bodySource.trim()
  const bodySource = trimmedBody.startsWith('{') ? input.bodySource : `{ ${input.bodySource} }`
  const wrapped = `async function __canaryReadableBody() ${bodySource}`
  const semanticContext = compileSemanticSource(input.file, wrapped, {
    semanticRules: input.semanticRules,
    compilerOptions: input.compilerOptions,
    absoluteSourceRanges: false,
  })
  const { sourceFile } = semanticContext
  return {
    sourceFile,
    semanticContext,
    // The source string above always declares this function with a block body.
    body: (sourceFile.statements[0] as ts.FunctionDeclaration).body as ts.Block,
    lineOffset: input.startLine ?? 1,
  }
}

/** Compile all helpers from one authored file together. Besides preserving
 *  cross-helper Symbols, this avoids rebuilding a TypeScript Program for every
 *  expanded call in a large test. */
function parseHelpers(
  helpers: readonly ReadableHelperInput[],
  semanticRules: ReadableSemanticRuleConfig | undefined,
  compilerOptions: ts.CompilerOptions | undefined,
): Map<string, ParsedHelper> {
  const groups = new Map<string, Array<{ helper: ReadableHelperInput; index: number }>>()
  helpers.forEach((helper, index) => {
    const group = groups.get(helper.file) ?? []
    group.push({ helper, index })
    groups.set(helper.file, group)
  })

  const parsedByIndex: ParsedHelper[] = []
  for (const [file, group] of groups) {
    const wrapped = group.map(({ helper, index }) => {
      const trimmedBody = helper.bodySource.trim()
      const bodySource = trimmedBody.startsWith('{') ? helper.bodySource : `{ ${helper.bodySource} }`
      return `async function __canaryReadableHelper_${index}() ${bodySource}`
    }).join('\n')
    const semanticContext = compileSemanticSource(file, wrapped, {
      semanticRules,
      compilerOptions,
      absoluteSourceRanges: false,
    })
    const { sourceFile } = semanticContext

    group.forEach(({ helper, index }, groupIndex) => {
      // The source string above always declares these functions with block bodies.
      const body = (sourceFile.statements[groupIndex] as ts.FunctionDeclaration).body as ts.Block
      const syntheticOpeningLine = sourceFile.getLineAndCharacterOfPosition(body.getStart(sourceFile)).line
      parsedByIndex[index] = {
        input: helper,
        body,
        sourceFile,
        semanticContext,
        lineOffset: (helper.startLine ?? 1) - syntheticOpeningLine,
      }
    })
  }

  const parsed = new Map<string, ParsedHelper>()
  helpers.forEach((helper, index) => {
    parsed.set(helper.name, parsedByIndex[index])
  })
  return parsed
}

function nestedStatements(statement: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(statement) ? statement.statements : [statement]
}

function branchPath(
  text: string,
  english: ReadableEnglishBlock,
  role: NonNullable<ReadableBranchPath['role']>,
  node: ts.Node,
  statements: readonly ts.Statement[],
  path: number[],
  context: TranslationContext,
): ReadableBranchPath {
  const source = sourceFor(node, context.sourceFile, context.file, context.lineOffset)
  return {
    id: stableNodeId(source, path),
    text,
    english,
    role,
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
    english: composeLoopHeader(statement, context.semanticContext),
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
      composeIfPath('then', statement.thenStatement, context.semanticContext),
      'then',
      statement.thenStatement,
      nestedStatements(statement.thenStatement),
      [...path, 0],
      context,
    ),
  ]
  if (statement.elseStatement) {
    paths.push(branchPath(
      renderEnglish(ifPathHeaderEnglish(statement, 'otherwise')),
      composeIfPath('otherwise', statement.elseStatement, context.semanticContext),
      'otherwise',
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
    english: composeIfHeader(statement, context.semanticContext),
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
    composeSwitchPath(caseClause, context.semanticContext),
    ts.isDefaultClause(caseClause) ? 'default' : 'case',
    caseClause,
    caseClause.statements,
    [...path, index],
    context,
  ))
  return {
    id: stableNodeId(source, path),
    kind: 'branch',
    text: renderEnglish(statementHeaderEnglish(statement)),
    english: composeSwitchHeader(statement, context.semanticContext),
    fidelity: 'derived',
    source,
    paths,
  }
}

function translatedGroup(
  text: string,
  english: ReadableEnglishBlock | undefined,
  controlRole: 'catch' | 'finally' | undefined,
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
    ...(english ? { english } : {}),
    ...(controlRole ? { controlRole } : {}),
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
      composeCatchHeader(statement.catchClause, context.semanticContext),
      'catch',
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
      composeFinallyHeader(statement.finallyBlock, context.semanticContext),
      'finally',
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
    english: composeTryHeader(statement, context.semanticContext),
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

function controlledLeaf(
  statement: ts.Statement,
  source: ReadableSource,
  path: number[],
  context: TranslationContext,
): ReadableLeafNode {
  const english = composeStatementEnglish(statement, context.semanticContext)
  return {
    id: stableNodeId(source, path),
    kind: 'leaf',
    role: 'syntax',
    text: renderEnglish(statementEnglish(statement)),
    ...(english ? { english } : {}),
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
      undefined,
      undefined,
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
  const helper = helperName ? context.helpers.get(helperName) : undefined
  if (helperName && helper && !context.activeHelpers.has(helperName)) {
    const text = renderEnglish(statementEnglish(statement))
    // `namedHelperCall` only accepts statement shapes covered by the structured
    // composer (expression, return, or single declaration).
    const english = composeStatementEnglish(statement, context.semanticContext) as ReadableEnglishBlock
    const activeHelpers = new Set(context.activeHelpers)
    activeHelpers.add(helperName)
    const helperContext: TranslationContext = {
      file: helper.input.file,
      lineOffset: helper.lineOffset,
      sourceFile: helper.sourceFile,
      semanticContext: helper.semanticContext,
      compilerOptions: context.compilerOptions,
      helpers: context.helpers,
      activeHelpers,
    }
    return {
      id: stableNodeId(source, path),
      kind: 'group',
      origin: 'helper',
      text,
      english,
      fidelity: 'derived',
      source,
      children: helper.body.statements.map(
        (child, index) => translateStatement(child, [...path, index], helperContext),
      ),
    }
  }

  return controlledLeaf(statement, source, path, context)
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

function translateStory(
  statements: readonly ts.Statement[],
  context: TranslationContext,
): ReadableTestStory | undefined {
  const translateCandidate = (
    candidate: ReturnType<typeof storyCandidates>[number],
  ): ReadableStoryItem => {
    const source = sourceFor(candidate.node, context.sourceFile, context.file, context.lineOffset)
    const base = {
      id: stableNodeId(source, [-1, ...candidate.path]),
      role: candidate.role,
      text: candidate.text,
      spans: candidate.spans,
      fidelity: candidate.fidelity,
      source,
    }
    return candidate.kind === 'flow'
      ? {
          ...base,
          kind: 'flow',
          flowKind: candidate.flowKind,
          children: candidate.children.map(translateCandidate),
        }
      : base
  }
  const story: ReadableTestStory = {
    steps: storyCandidates(statements, context.sourceFile).map(translateCandidate),
  }
  return story.steps.length ? story : undefined
}

function translatedTest(
  title: string,
  nodes: ReadableNode[],
  story: ReadableTestStory | undefined,
): ReadableTest {
  return {
    version: READABLE_TEST_VERSION,
    title,
    completeness: nodes.some(containsIncomplete) ? 'partial' : 'complete',
    ...(story ? { story } : {}),
    nodes,
  }
}

export function translateReadableTest(input: ReadableTestInput): ReadableTest {
  const { body, sourceFile, semanticContext, lineOffset } = parseBody(input)
  const context: TranslationContext = {
    file: input.file,
    lineOffset,
    sourceFile,
    semanticContext,
    compilerOptions: input.compilerOptions,
    helpers: parseHelpers(input.helpers ?? [], semanticContext.config, input.compilerOptions),
    activeHelpers: new Set(),
  }
  const nodes = body.statements.map((statement, index) => translateStatement(statement, [index], context))
  return translatedTest(input.title, nodes, translateStory(body.statements, context))
}

/** Uses an already-parsed test callback so AST extraction and readable
 * translation share the same source tree and exact positions. */
export function translateReadableTestFromAst(input: ReadableTestAstInput): ReadableTest {
  const semanticContext = input.semanticContext ?? compileSemanticSource(
    input.file,
    input.sourceFile.getFullText(),
    {
      semanticRules: input.semanticRules,
      compilerOptions: input.compilerOptions,
      absoluteSourceRanges: true,
    },
  )
  const bodyHasSourceRange = typeof input.body.pos === 'number' && typeof input.body.end === 'number'
  const sourceFile = input.semanticContext || !bodyHasSourceRange
    ? input.sourceFile
    : semanticContext.sourceFile
  const body = input.semanticContext || !bodyHasSourceRange
    ? input.body
    : findMatchingBlock(sourceFile, input.body)
  const context: TranslationContext = {
    file: input.file,
    // The supplied source file already carries absolute positions. Convert its
    // zero-based line indexes directly to one-based source lines.
    lineOffset: 1,
    sourceFile,
    semanticContext,
    compilerOptions: input.compilerOptions,
    helpers: parseHelpers(input.helpers ?? [], semanticContext.config, input.compilerOptions),
    activeHelpers: new Set(),
  }
  const nodes = body.statements.map((statement, index) => translateStatement(statement, [index], context))
  return translatedTest(input.title, nodes, translateStory(body.statements, context))
}

function findMatchingBlock(sourceFile: ts.SourceFile, target: ts.Block): ts.Block {
  let match: ts.Block | undefined
  const visit = (node: ts.Node): void => {
    if (match) return
    if (ts.isBlock(node) && node.pos === target.pos && node.end === target.end) {
      match = node
      return
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  // Both source files are parsed from the same text, so the target block's
  // positional twin necessarily exists in the checker-owned tree.
  return match as ts.Block
}
