import { buildTestFlowGraph, type GraphOrigin } from '../../../../../shared/test-view/flow-graph'
import { renderExpression } from './expression'
import { flowLabel, readerCaption } from './flow-label'
import { unwrapExpression } from '../unwrap-expression'
import type { ResolveSuiteHelper } from './suite-helpers'
import { authoredStep, authoredStepLabel, callFromStatement } from './call-syntax'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import {
  READABLE_TEST_VERSION,
  type ReaderCall,
  type ReaderDefinition,
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
import { reviewOutline } from './review-outline'
import { storyCandidates } from './story'
import { sourceRepresentationGaps } from './source-representation'

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
  graphOrigin?: GraphOrigin
  caseLine?: number
  resolveHelper?: ResolveSuiteHelper
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
  revisions?: Record<string, string>
  resolveHelper?: ResolveSuiteHelper
  budget?: { remaining: number }
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

function sourceFor(node: ts.Node, sourceFile: ts.SourceFile, file: string, lineOffset: number, precise = false): ReadableSource {
  const start = node.getStart(sourceFile)
  const end = Math.max(start, node.getEnd() - 1)
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start)
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end)

  return {
    file,
    ...(precise ? { startOffset: start, endOffset: node.end, startColumn: startPosition.character + 1,
      endColumn: sourceFile.getLineAndCharacterOfPosition(node.end).character + 1 } : {}),
    startLine: lineOffset + startPosition.line,
    endLine: lineOffset + endPosition.line,
    snippet: formatSourceSnippetForDisplay(node.getText(sourceFile)),
  }
}

function sourceForRange(
  range: { start: number; end: number },
  sourceFile: ts.SourceFile,
  file: string,
  lineOffset: number,
): ReadableSource {
  const end = Math.max(range.start, range.end - 1)
  const startPosition = sourceFile.getLineAndCharacterOfPosition(range.start)
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end)
  return {
    file,
    startLine: lineOffset + startPosition.line,
    endLine: lineOffset + endPosition.line,
    snippet: formatSourceSnippetForDisplay(sourceFile.text.slice(range.start, range.end)),
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
  const source = sourceFor(node, context.sourceFile, context.file, context.lineOffset, !!context.revisions)
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
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset, !!context.revisions)
  let loopKind: ReadableLoopKind
  if (ts.isForStatement(statement)) loopKind = 'for'
  else if (ts.isForInStatement(statement)) loopKind = 'for-in'
  else if (ts.isForOfStatement(statement)) loopKind = statement.awaitModifier ? 'for-await-of' : 'for-of'
  else loopKind = ts.isWhileStatement(statement) ? 'while' : 'do-while'

  function headerPart(expression: ts.Node, position: number): ReadableLeafNode {
    const part = sourceFor(expression, context.sourceFile, context.file, context.lineOffset, true)
    return { id: stableNodeId(part, [...path, position]), kind: 'leaf', role: 'action', text: part.snippet,
      fidelity: 'exact', source: part, flow: { kind: 'action', label: part.snippet, mayThrow: containsThrowingExpression(expression) } }
  }
  return {
    id: stableNodeId(source, path),
    kind: 'loop',
    loopKind,
    ...(context.revisions && ts.isForStatement(statement) && statement.initializer ? { initializer: headerPart(statement.initializer, -2) } : {}),
    ...(context.revisions && ts.isForStatement(statement) && statement.incrementor ? { increment: headerPart(statement.incrementor, -3) } : {}),
    ...(ts.isForStatement(statement) && !statement.condition ? { unconditional: true } : {}),
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
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset, !!context.revisions)
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
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset, !!context.revisions)
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
  const source = sourceFor(node, context.sourceFile, context.file, context.lineOffset, !!context.revisions)
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
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset, !!context.revisions)
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

function waitsForCall(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) return true
  const value = ts.isExpressionStatement(statement) ? statement.expression
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations[0].initializer : undefined
  return !!value && ts.isAwaitExpression(unwrapExpression(value, { unwrapAwait: false }))
}

function deferredCall(statement: ts.Statement, source: ReadableSource, path: number[], context: TranslationContext, reason: string) {
  const leaf = controlledLeaf(statement, source, path, context)
  leaf.flow = { ...flowLabel(statement, leaf), boundary: 'callback', reason }
  return leaf
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
    if (context.revisions && !waitsForCall(statement))
      return deferredCall(statement, source, path, context, 'Step completion is not awaited')
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

  const expression = callFromStatement(statement)?.expression
  const name = expression && ts.isIdentifier(expression) ? expression : undefined
  const authored = name && context.resolveHelper?.(name, context.semanticContext)
  const parsed = name && !context.resolveHelper ? context.helpers.get(name.text) : undefined
  const body = authored?.body ?? parsed?.body
  const semanticContext = authored?.semanticContext ?? parsed?.semanticContext
  const file = authored?.semanticContext.sourceFile === context.sourceFile ? context.file : authored?.file ?? parsed?.input.file
  if (body && semanticContext && file) {
    const fn = body.parent
    if (context.revisions && ts.isFunctionLike(fn)) {
      if ('asteriskToken' in fn && fn.asteriskToken)
        return deferredCall(statement, source, path, context, 'Generator body runs when its iterator advances')
      if (ts.canHaveModifiers(fn) && ts.getModifiers(fn)?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) && !waitsForCall(statement))
        return deferredCall(statement, source, path, context, 'Async helper completion is not awaited')
    }
    const key = authored ? `${file}:${body.pos}` : name!.text
    if (parsed && context.activeHelpers.has(key)) return controlledLeaf(statement, source, path, context)
    if (authored && (context.activeHelpers.has(key) || context.budget?.remaining === 0 || context.activeHelpers.size >= 16)) {
      return { id: stableNodeId(source, path), kind: 'leaf', role: 'helper', text: source.snippet, fidelity: 'unresolved', source }
    }
    if (context.budget) context.budget.remaining--
    const text = renderEnglish(statementEnglish(statement))
    const english = composeStatementEnglish(statement, context.semanticContext) as ReadableEnglishBlock
    const helperContext: TranslationContext = {
      ...context, file, semanticContext, sourceFile: semanticContext.sourceFile,
      lineOffset: parsed?.lineOffset ?? 1, activeHelpers: new Set([...context.activeHelpers, key]),
    }
    if (context.revisions) context.revisions[file] ??= sourceRevision(helperContext.sourceFile)
    const definition = sourceFor(body, helperContext.sourceFile, file, helperContext.lineOffset, !!context.revisions)
    let children: ReadableNode[]
    let story: ReadableTestStory
    if (ts.isBlock(body)) {
      story = translateStory(body.statements, helperContext, true) ?? { steps: [] }
      children = body.statements.map((child, index) => translateStatement(child, [...path, index], helperContext))
    } else {
      const source = definition
      const expression = renderExpression(body, helperContext.sourceFile)
      const text = 'Return ' + expression.text
      story = { steps: [{ id: stableNodeId(source, [-1, 0]), role: 'output', text, spans: [{ text }],
        fidelity: 'derived', source, ...(expression.fidelity === 'unsupported' || expression.fidelity === 'unresolved'
          ? { presentation: 'syntax-fallback' as const } : {}) }] }
      children = [{ id: stableNodeId(source, [...path, 0]), kind: 'leaf', role: 'action', source, text: source.snippet, fidelity: 'exact' }]
    }
    return {
      id: stableNodeId(source, path),
      kind: 'group',
      origin: 'helper',
      implementation: { source: definition, story },
      text,
      english,
      fidelity: 'derived',
      source,
      children,
    }
  }

  return controlledLeaf(statement, source, path, context)
}

function containsThrowingExpression(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) return false
  if (ts.isCallExpression(node) || ts.isAwaitExpression(node) || ts.isNewExpression(node)
    || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return true
  return ts.forEachChild(node, child => containsThrowingExpression(child) || undefined) ?? false
}

function attachGraphFacts(statement: ts.Statement, node: ReadableNode) {
  const flow = node.flow!
  const call = callFromStatement(statement)
  const declaration = ts.isFunctionDeclaration(statement) || (ts.isVariableStatement(statement)
    && statement.declarationList.declarations.every(binding => binding.initializer
      && (ts.isArrowFunction(binding.initializer) || ts.isFunctionExpression(binding.initializer))))
  const callback = call?.arguments.some(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
  if (declaration) flow.boundary = 'declaration'
  else if (callback) flow.boundary = 'callback'
  if (callback && node.kind === 'leaf' && authoredStepLabel(call) === undefined)
    flow.reason = 'Callback execution depends on the callee'
  if (call && ts.isIdentifier(call.expression) && node.kind === 'leaf')
    flow.reason ??= 'Helper definition unavailable or expansion limit reached'
  if (ts.isLabeledStatement(statement) || ts.isWithStatement(statement)) flow.kind = 'opaque'
  if (call && node.kind === 'leaf' && flow.kind === 'action' && !authoredStepLabel(call)
    && !node.english?.semanticCategories?.length) flow.reason ??= 'Callee implementation unavailable'
  if (flow.kind === 'opaque') flow.reason = 'Control transfer requires source inspection'
  // A compound statement's children own their exceptions. Its condition can
  // throw before either branch is entered.
  const expression = ts.isIfStatement(statement) || ts.isSwitchStatement(statement)
    || ts.isWhileStatement(statement) || ts.isDoStatement(statement) || ts.isForOfStatement(statement)
    || ts.isForInStatement(statement) ? statement.expression : ts.isForStatement(statement) ? statement.condition : undefined
  if ((expression && containsThrowingExpression(expression)) || node.kind === 'group' && node.origin === 'helper'
    || node.kind === 'leaf' && !declaration && flow.kind !== 'throw' && containsThrowingExpression(statement)) flow.mayThrow = true
}

function translateStatement(
  statement: ts.Statement,
  path: number[],
  context: TranslationContext,
): ReadableNode {
  const source = sourceFor(statement, context.sourceFile, context.file, context.lineOffset, !!context.revisions)
  try {
    const node = translateSupportedStatement(statement, path, context, source)
    if (context.resolveHelper) {
      node.flow ??= flowLabel(statement, node)
      if (context.revisions) {
        const caption = readerCaption(statement, node.flow)
        if (caption) node.flow.caption = caption
        attachGraphFacts(statement, node)
      }
    }
    return node
  } catch (error) {
    if (error instanceof UnsupportedSyntaxKindError) return unsupportedLeaf(source, path, error)
    throw error
  }
}

function translateStory(
  statements: readonly ts.Statement[],
  context: TranslationContext,
  complete = false,
): ReadableTestStory | undefined {
  type Candidate = ReturnType<typeof storyCandidates>[number]

  function translateCandidates(candidates: Candidate[]): ReadableStoryItem[] {
    return candidates.flatMap((candidate) => {
      const item = translateCandidate(candidate)
      if (candidate.kind !== 'flow' || candidate.flowKind !== 'condition') return [item]
      const alternative = candidate.children.find(
        (child) => child.kind === 'flow' && child.flowKind === 'otherwise',
      )
      return alternative ? [item, translateCandidate(alternative)] : [item]
    })
  }

  function translateCandidate(candidate: Candidate): ReadableStoryItem {
    const source = candidate.sourceRange
      ? sourceForRange(candidate.sourceRange, context.sourceFile, context.file, context.lineOffset)
      : sourceFor(candidate.node, context.sourceFile, context.file, context.lineOffset, !!context.revisions)
    const node = candidate.node
    const headerBody = ts.isIfStatement(node) ? node.thenStatement
      : ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isWithStatement(node) ? node.statement
      : ts.isSwitchStatement(node) ? node.caseBlock
      : ts.isCatchClause(node) ? node.block
      : ts.isTryStatement(node) ? node.tryBlock : undefined
    const headerEndPosition = candidate.kind === 'flow' ? candidate.headerEndPosition ?? headerBody?.getStart(context.sourceFile) : undefined
    const base = {
      id: stableNodeId(source, [-1, ...candidate.path]),
      role: candidate.role,
      text: candidate.kind === 'flow' && candidate.flowKind === 'otherwise' ? 'Else' : candidate.text,
      spans: candidate.kind === 'flow' && candidate.flowKind === 'otherwise' ? [{ text: 'Else', kind: 'keyword' as const }] : candidate.spans,
      fidelity: candidate.fidelity,
      ...(sourceRepresentationGaps(candidate.node).length ? { presentation: 'syntax-fallback' as const } : {}),
      source,
    }
    return candidate.kind === 'flow'
      ? {
          ...base,
          kind: 'flow',
          flowKind: candidate.flowKind,
          ...(headerEndPosition !== undefined ? {
              headerEndLine: context.lineOffset + context.sourceFile.getLineAndCharacterOfPosition(headerEndPosition).line,
            } : {}),
          ...(ts.isDoStatement(node) ? {
            footerStartLine: context.lineOffset + context.sourceFile.getLineAndCharacterOfPosition(node.statement.getEnd()).line,
          } : {}),
          children: translateCandidates(candidate.kind === 'flow' && candidate.flowKind === 'condition'
            ? candidate.children.flatMap((child) => child.kind === 'flow' && child.flowKind === 'then'
              ? child.children
              : child.kind === 'flow' && child.flowKind === 'otherwise' ? [] : [child])
            : candidate.children),
        }
      : base
  }
  const story: ReadableTestStory = {
    steps: translateCandidates(storyCandidates(statements, context.sourceFile, complete ? context.semanticContext : undefined)),
  }
  return story.steps.length ? story : undefined
}

/** File review includes declarations and registration, not just test callbacks. */
export function translateReadableSource(file: string, source: string, semanticRules?: ReadableSemanticRuleConfig): ReadableTestStory {
  return reviewStories(file, source, semanticRules).story
}

export function reviewStories(file: string, source: string, semanticRules?: ReadableSemanticRuleConfig,
  revision?: { side: 'before' | 'after'; resolveHelper: ResolveSuiteHelper; moduleFile: string }) {
  const semanticContext = compileSemanticSource(revision?.moduleFile ?? file, source, { semanticRules })
  const context: TranslationContext = {
    file, lineOffset: 1, sourceFile: semanticContext.sourceFile, semanticContext,
    helpers: new Map(), activeHelpers: new Set(),
  }
  const story = translateStory(context.sourceFile.statements, context, true) ?? { steps: [] }
  if (source.startsWith('#!')) {
    const interpreter = source.split('\n', 1)[0].slice(2).trim()
    const text = `Use interpreter ${interpreter}`
    story.steps.unshift({ id: 'interpreter', role: 'setup', text, spans: [{ text }], fidelity: 'exact',
      source: { file, startLine: 1, endLine: 1, snippet: source.split('\n', 1)[0] } })
  }
  const outline = reviewOutline(story, context.sourceFile)
  if (!revision || !source.trim()) return { story, outline }
  const sf = context.sourceFile
  const revisions = { [file]: sourceRevision(sf) }
  const graphContext = { ...context, revisions, resolveHelper: revision.resolveHelper, budget: { remaining: 128 } }
  const nodes = sf.statements.map((statement, index): ReadableNode => {
    const node = translateStatement(statement, [index], graphContext)
    const object = outline?.steps.find(step => step.source.startLine === node.source.startLine &&
      step.kind === 'flow' && step.flowKind === 'scope' && step.text.startsWith('Define '))
    if (object?.kind !== 'flow') return node
    return { kind: 'group', id: node.id, fidelity: node.fidelity, text: object.text, source: node.source,
      flow: { kind: 'action', label: object.text }, children: object.children.map(field => ({
        kind: 'leaf', role: 'action', id: field.id, text: field.text, fidelity: field.fidelity, source: field.source,
        flow: { kind: 'action', label: field.text },
      })) }
  })
  const title = file.split(/[\\/]/).at(-1)!
  const fileFlow = translatedTest(title, nodes, outline ?? story, undefined)
  const end = sf.getLineAndCharacterOfPosition(source.length)
  fileFlow.graph = buildTestFlowGraph(nodes, { origin: { kind: revision.side }, revisions, case: { file, title, line: 1 } },
    { file, startLine: 1, startColumn: 1, startOffset: 0, endLine: end.line + 1, endColumn: end.character + 1,
      endOffset: source.length, snippet: source })
  fileFlow.navigation = readerNavigation(sf, graphContext, fileFlow)
  return { story, outline, fileFlow }
}

function translatedTest(
  title: string,
  nodes: ReadableNode[],
  story: ReadableTestStory | undefined,
  summary: ReadableTestStory | undefined,
): ReadableTest {
  return {
    version: READABLE_TEST_VERSION,
    title,
    completeness: nodes.some(containsIncomplete) || story?.steps.some(containsStoryFallback) ? 'partial' : 'complete',
    ...(story ? { story } : {}),
    ...(summary ? { summary } : {}),
    nodes,
  }
}

function containsStoryFallback(item: ReadableStoryItem): boolean {
  return item.presentation === 'syntax-fallback' || item.kind === 'flow' && item.children.some(containsStoryFallback)
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
  return translatedTest(input.title, nodes, translateStory(body.statements, context, true), translateStory(body.statements, context))
}

/** One extraction owns one helper compilation. Each test still receives fresh
 * recursion state; nothing is cached across edits or semantic-rule changes.
 *
 * `semanticContext` and `helpers` are optional on `ReadableTestAstInput` for
 * the single-test entry point below, and required here: batching only pays off
 * when the caller has already compiled the file and collected its helpers once
 * for the whole extraction. Falling back to a per-factory compile would be the
 * work this function exists to avoid, so the type rules it out rather than
 * leaving an arm no caller can reach. */
export function createReadableTestAstTranslator(
  input: Omit<ReadableTestAstInput, 'title' | 'body'> & Required<Pick<ReadableTestAstInput, 'helpers' | 'semanticContext'>>,
): (title: string, body: ts.Block, caseLine?: number) => ReadableTest {
  const helpers = parseHelpers(input.helpers, input.semanticContext.config, input.compilerOptions)
  return (title, body, caseLine) => translateReadableTestFromAst({ ...input, title, body, caseLine }, helpers)
}

/** Uses an already-parsed test callback so AST extraction and readable
 * translation share the same source tree and exact positions. */
export function translateReadableTestFromAst(input: ReadableTestAstInput, preparedHelpers?: Map<string, ParsedHelper>): ReadableTest {
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
    revisions: input.graphOrigin ? { [input.file]: sourceRevision(sourceFile) } : undefined,
    resolveHelper: input.resolveHelper,
    budget: input.resolveHelper ? { remaining: 128 } : undefined,
    helpers: preparedHelpers ?? parseHelpers(input.helpers ?? [], semanticContext.config, input.compilerOptions),
    activeHelpers: new Set(),
  }
  const nodes = body.statements.map((statement, index) => translateStatement(statement, [index], context))
  const result = translatedTest(input.title, nodes, translateStory(body.statements, context, true), translateStory(body.statements, context))
  if (input.graphOrigin && context.revisions) {
    const definition = sourceFor(body, sourceFile, input.file, 1, true)
    result.graph = buildTestFlowGraph(nodes, { origin: input.graphOrigin, revisions: context.revisions,
      case: { file: input.file, title: input.title, line: input.caseLine ?? definition.startLine } }, definition)
  }
  if (input.graphOrigin && input.resolveHelper) result.navigation = readerNavigation(body, context, result)
  return result
}

/** Resolve links on the same syntax tree and inside the same suite boundary as
 * the execution graph. A call inside an argument is inspectable without becoming
 * an independently observed step. Each definition is retained once per case. */
function readerNavigation(body: ts.Block | ts.SourceFile, root: TranslationContext, test: ReadableTest) {
  const definitions = new Map<string, ReaderDefinition>()
  const retained = new Set(test.graph?.sections.slice(1).map(section =>
    JSON.stringify([section.definition.file, section.definition.startOffset])))
  const resolve = root.resolveHelper!
  function collect(block: ts.ConciseBody | ts.SourceFile, context: TranslationContext, displayStart = block.getStart(context.sourceFile)): ReaderCall[] {
    const calls: ReaderCall[] = []
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression
        const helper = resolve(name, context.semanticContext)
        if (helper) {
          const sf = helper.semanticContext.sourceFile
          const file = sf === context.sourceFile ? context.file : helper.file
          const pos = helper.body.getStart(sf)
          const id = 'def-' + createHash('sha256').update(JSON.stringify([file, pos])).digest('hex').slice(0, 18)
          if (!definitions.has(id) && definitions.size < 128) {
            const fn = helper.body.parent
            const declaration = ts.isVariableDeclaration(fn.parent) ? fn.parent : fn
            const source = sourceFor(declaration, sf, file, 1, true)
            source.snippet = declaration.getText(sf)
            const def: ReaderDefinition = { id, name: name.text, source, bodyOffset: pos, calls: [] }
            definitions.set(id, def)
            const child = { ...context, file, sourceFile: sf, semanticContext: helper.semanticContext, lineOffset: 1 }
            if (!retained.has(JSON.stringify([file, pos]))) {
              // References inside expressions describe navigation only. Do not
              // spend the execution compiler's recursion budget on these views.
              const display = { ...child, resolveHelper: () => undefined }
              if (ts.isBlock(helper.body)) {
                def.nodes = helper.body.statements.map((s, i) => translateStatement(s, [i], display))
                def.story = translateStory(helper.body.statements, display, true)
              } else {
                const value = sourceFor(helper.body, sf, file, 1, true)
                def.nodes = [{ kind: 'leaf', role: 'action', id: stableNodeId(value, [0]), source: value,
                  fidelity: 'exact', text: 'Return ' + value.snippet }]
              }
            }
            def.calls = collect(helper.body, child, declaration.getStart(sf))
          }
          if (definitions.has(id)) {
            const at = context.sourceFile.getLineAndCharacterOfPosition(name.getStart(context.sourceFile))
            const start = Math.max(displayStart, context.sourceFile.getPositionOfLineAndCharacter(at.line, 0))
            const prefix = context.sourceFile.text.slice(start, name.getStart(context.sourceFile)).trimStart()
            let outer: ts.Node = node
            while (ts.isParenthesizedExpression(outer.parent) || ts.isAwaitExpression(outer.parent) ||
              ts.isAsExpression(outer.parent) || ts.isNonNullExpression(outer.parent)) outer = outer.parent
            const parent = outer.parent
            const direct = ts.isExpressionStatement(parent) || ts.isReturnStatement(parent) ||
              (ts.isVariableDeclaration(parent) && parent.initializer === outer) ||
              (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === outer)
            calls.push({ name: name.text, ...(direct && {direct}), line: at.line + 1, column: at.character + 1, contentColumn: prefix.length, target: id })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(block)
    return calls
  }
  const calls = collect(body, root)
  return { calls, definitions: [...definitions.values()] }
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

// SourceFile instances are immutable and shared by the cases in one extraction.
const revisionCache = new WeakMap<ts.SourceFile, string>()
function sourceRevision(source: ts.SourceFile): string {
  const cached = revisionCache.get(source)
  if (cached) return cached
  const revision = createHash('sha256').update(source.text).digest('hex')
  revisionCache.set(source, revision)
  return revision
}
