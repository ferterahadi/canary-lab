import ts from 'typescript'
import { createHash } from 'node:crypto'
import { compileSemanticSource } from '../apps/web-server/src/shared/controlled-english/semantic-context'
import { storyCandidates, type StoryCandidate } from '../apps/web-server/src/shared/readable-tests/story'
import { sourceEnglishReceipt, sourceRepresentationGaps } from '../apps/web-server/src/shared/readable-tests/source-representation'
import { testRegistration } from '../apps/web-server/src/shared/readable-tests/source-language'
import { canonicalKindName } from '../apps/web-server/src/shared/controlled-english/syntax-kinds'
import { translateReadableSource, translateReadableTestFromAst } from '../apps/web-server/src/shared/readable-tests/translator'
import type { ReadableStoryItem } from '../shared/readable-tests/types'
import { englishLines } from '../shared/readable-tests/source-lines'

export interface EnglishAuditIssue {
  file: string
  surface: string
  line: number
  column: number
  syntaxKind: string
  reason: 'missing' | 'syntax-fallback' | 'parse-error' | 'translation-error'
  message: string
}

export interface EnglishSourceAudit {
  file: string
  sourceHash: string
  tests: number
  required: number
  represented: number
  issues: EnglishAuditIssue[]
}

function inventory(roots: readonly ts.Node[]): ts.Node[] {
  const result: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStatement(node) && !ts.isBlock(node) && !ts.isEmptyStatement(node)
      || ts.isCaseClause(node) || ts.isDefaultClause(node) || ts.isCatchClause(node)
      || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
      || ts.isClassElement(node) && node.parent && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent) || ts.isObjectLiteralExpression(node.parent))
      || node.parent && ts.isArrowFunction(node.parent) && node.parent.body === node && !ts.isBlock(node)) result.push(node)
    node.forEachChild(visit)
  }
  roots.forEach(visit)
  return result
}

function flattened(items: StoryCandidate[]): StoryCandidate[] {
  return items.flatMap((item) => [item, ...(item.kind === 'flow' ? flattened(item.children) : [])])
}

function normalized(text: string): string {
  return text.replace(/`/g, '').replace(/\s+/g, ' ').trim()
}

/** The denominator comes from the parser, independently of the renderer.
 * A scope header never owns its body. Inline callback statements count only
 * when their individual renderer receipt is present in the displayed text. */
export function inspectEnglishCandidates(file: string, surface: string, source: ts.SourceFile, roots: readonly ts.Node[], candidates: StoryCandidate[], displayed?: ReadableStoryItem[]): {
  required: number; represented: number; issues: EnglishAuditIssue[]
} {
  const expected = inventory(roots)
  const visible = (items: ReadableStoryItem[]): ReadableStoryItem[] => items.flatMap((item) => [item, ...(item.kind === 'flow' ? visible(item.children) : [])])
  const output = displayed && visible(displayed)
  const rows = flattened(candidates).filter((candidate) => candidate.role !== 'note' && (!output || output.some((item) => {
    const start = source.getLineAndCharacterOfPosition(candidate.sourceRange?.start ?? candidate.node.getStart(source)).line + 1
    const text = candidate.kind === 'flow' && candidate.flowKind === 'otherwise' ? 'Else' : candidate.text
    return item.source.startLine === start && normalized(item.text) === normalized(text)
  })))
  const issues: EnglishAuditIssue[] = []
  const issue = (node: ts.Node, reason: EnglishAuditIssue['reason'], message: string): EnglishAuditIssue => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    return { file, surface, line: position.line + 1, column: position.character + 1, syntaxKind: canonicalKindName(node.kind), reason, message }
  }
  let represented = 0
  for (const node of expected) {
    const direct = rows.some((row) => row.node === node && !(row.kind === 'flow' && (row.flowKind === 'then' || row.flowKind === 'otherwise') && ts.isStatement(node)))
    const receipt = sourceEnglishReceipt(node)
    const inline = receipt && rows.some((row) => row.node.pos <= node.pos && row.node.end >= node.end
      && normalized(row.text).includes(normalized(receipt)))
    if (!direct && !inline) issues.push(issue(node, 'missing', 'No displayed English explanation owns this source construct.'))
    else represented++
  }
  const seen = new Set<ts.Node>()
  for (const row of rows) for (const gap of sourceRepresentationGaps(row.node)) {
    if (seen.has(gap.node)) continue
    seen.add(gap.node)
    issues.push(issue(gap.node, 'syntax-fallback', 'Only the exhaustive syntax wording represents this construct.'))
  }
  if (surface === 'file' && displayed) {
    const lines = englishLines({ source: source.text, story: { steps: displayed }, tests: [] })
    source.text.split('\n').forEach((text, index) => {
      const line = index + 1
      if (text.trim() && !lines.has(line) && !issues.some((item) => item.line === line)) issues.push({
        file, surface, line, column: text.search(/\S/) + 1, syntaxKind: 'SourceLine', reason: 'missing',
        message: 'The English comparison would display this source line as unavailable.',
      })
    })
  }
  return { required: expected.length, represented, issues }
}

export function auditEnglishSource(file: string, text: string): EnglishSourceAudit {
  const result: EnglishSourceAudit = { file, sourceHash: createHash('sha256').update(text).digest('hex'), tests: 0, required: 0, represented: 0, issues: [] }
  const context = compileSemanticSource(file, text)
  const source = context.sourceFile
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics.length) {
    result.issues = diagnostics.map((diagnostic) => {
      const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
      return { file, surface: 'file', line: position.line + 1, column: position.character + 1, syntaxKind: 'ParseError', reason: 'parse-error', message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') }
    })
    return result
  }
  const inspect = (surface: string, roots: readonly ts.Statement[], body?: ts.Block): void => {
    try {
      const displayed = body ? translateReadableTestFromAst({ file, title: surface, body, sourceFile: source, semanticContext: context }).story?.steps ?? []
        : translateReadableSource(file, text).steps
      const audit = inspectEnglishCandidates(file, surface, source, roots, storyCandidates(roots, source, context), displayed)
      result.required += audit.required
      result.represented += audit.represented
      result.issues.push(...audit.issues)
    } catch (error) {
      result.issues.push({ file, surface, line: 1, column: 1, syntaxKind: 'TranslationError', reason: 'translation-error', message: error instanceof Error ? error.message : String(error) })
    }
  }
  inspect('file', source.statements)
  const visit = (node: ts.Node): void => {
    if (ts.isStatement(node)) {
      const registration = testRegistration(node, context)
      if (registration?.role === 'test') {
        result.tests++
        if (ts.isBlock(registration.callback.body)) inspect(`test at line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`, registration.callback.body.statements, registration.callback.body)
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return result
}
