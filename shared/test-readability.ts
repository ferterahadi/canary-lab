import ts from 'typescript'
import { format } from 'prettier'

export interface TestReadabilityIssue {
  line: number
  column: number
  rule: 'syntax' | 'one-var' | 'no-sequences' | 'no-nested-ternary' | 'format'
  severity: 'error' | 'warning'
  message: string
  fixable: boolean
}

export interface TestReadabilityResult {
  code: string
  changed: boolean
  issues: TestReadabilityIssue[]
  remaining: TestReadabilityIssue[]
}

interface Edit { start: number; end: number; text: string }

/** One policy for draft acceptance and the source-cleanup command. The existing
 * TypeScript compiler gives us syntax ranges without loading a workspace's lint
 * config or executing its tests. Only declaration separators are rewritten;
 * expressions, including comma operators, always keep their evaluation order. */
export async function inspectTestReadability(
  source: string,
  filename: string,
  options: { rulesOnly?: boolean } = {},
): Promise<TestReadabilityResult> {
  const syntax = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
  }).diagnostics!
  if (syntax.length > 0) {
    const issues: TestReadabilityIssue[] = syntax.map((diagnostic) => {
      const location = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start!)
      return {
        line: location.line + 1,
        column: location.character + 1,
        rule: 'syntax',
        severity: 'error',
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        fixable: false,
      }
    })
    return { code: source, changed: false, issues, remaining: issues }
  }

  const before = analyze(source, filename)
  let code = source
  for (const edit of before.edits.sort((a, b) => b.start - a.start)) {
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end)
  }
  const issues = [...before.issues]
  if (!options.rulesOnly) {
    try {
      const formatted = await format(code, {
        filepath: filename,
        singleQuote: true,
        semi: false,
        printWidth: 100,
        trailingComma: 'all',
        embeddedLanguageFormatting: 'off',
      })
      if (formatted !== code) {
        issues.push({ line: 1, column: 1, rule: 'format', severity: 'error', message: 'Apply the standard test formatting.', fixable: true })
      }
      code = formatted
    } catch (err) {
      const issue: TestReadabilityIssue = {
        line: 1, column: 1, rule: 'format', severity: 'error',
        message: String(err), fixable: false,
      }
      return { code: source, changed: false, issues: [...issues, issue], remaining: [issue] }
    }
  }
  return { code, changed: code !== source, issues, remaining: analyze(code, filename).issues }
}

function analyze(source: string, filename: string): { issues: TestReadabilityIssue[]; edits: Edit[] } {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const issues: TestReadabilityIssue[] = []
  const edits: Edit[] = []
  const report = (node: ts.Node, rule: TestReadabilityIssue['rule'], message: string, fixable = false) => {
    const location = ast.getLineAndCharacterOfPosition(node.getStart(ast))
    issues.push({ line: location.line + 1, column: location.character + 1, rule, message, fixable,
      severity: rule === 'no-nested-ternary' ? 'warning' : 'error' })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.length > 1) {
      const keyword = node.declarationList.getFirstToken(ast)!
      // A declaration in a loop header cannot be split into statements. Nor can
      // a bare `if (...) var a, b` body: inserting statements changes its scope.
      const parent = node.parent
      const statementList = ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isModuleBlock(parent)
        || ts.isCaseClause(parent) || ts.isDefaultClause(parent)
      const fixable = statementList && !node.modifiers?.length
        && [ts.SyntaxKind.ConstKeyword, ts.SyntaxKind.LetKeyword, ts.SyntaxKind.VarKeyword].includes(keyword.kind)
      report(node, 'one-var', 'Declare each variable in a separate statement.', fixable)
      if (fixable) {
        const indentation = source.slice(source.lastIndexOf('\n', node.getStart(ast) - 1) + 1).match(/^\s*/)![0]
        const semicolon = node.getLastToken(ast)!.kind === ts.SyntaxKind.SemicolonToken ? ';' : ''
        const newline = source.includes('\r\n') ? '\r\n' : '\n'
        const list = node.declarationList.getChildren(ast).find((child) => child.kind === ts.SyntaxKind.SyntaxList)!
        for (const token of list.getChildren(ast)) {
          if (token.kind === ts.SyntaxKind.CommaToken) {
            const whitespace = source.slice(token.end).match(/^\s*/)![0]
            edits.push({ start: token.getStart(ast), end: token.end + whitespace.length, text: `${semicolon}${newline}${indentation}${keyword.getText(ast)} ` })
          }
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      let expression: ts.Node = node
      while (ts.isParenthesizedExpression(expression.parent)
        || (ts.isBinaryExpression(expression.parent) && expression.parent.operatorToken.kind === ts.SyntaxKind.CommaToken)) {
        expression = expression.parent
      }
      const parent = expression.parent
      if (!(ts.isForStatement(parent) && (parent.initializer === expression || parent.incrementor === expression))) {
        report(node, 'no-sequences', 'Use explicit statements instead of a comma expression; review evaluation order before changing it.')
      }
    }
    if (ts.isConditionalExpression(node) && [node.whenTrue, node.whenFalse].some((branch) => {
      while (ts.isParenthesizedExpression(branch)) branch = branch.expression
      return ts.isConditionalExpression(branch)
    })) {
      report(node, 'no-nested-ternary', 'Review this nested conditional for a clearer name or explicit branches.')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return { issues, edits }
}

export function describeReadabilityIssue(filename: string, issue: TestReadabilityIssue): string {
  return `${filename}:${issue.line}:${issue.column} ${issue.severity} ${issue.rule}: ${issue.message}`
}
