import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import type { ReadableSourceRange, ReadableSyntaxCategory } from '../../../../../shared/readable-tests/types'
import {
  rootIdentifierForExpression,
  symbolEvidence,
  type SemanticContext,
  type SymbolEvidence,
} from './semantic-context'

interface CanonicalBase {
  syntaxKind: string
  code: string
  /** Parentheses remain explicit without preventing larger compositions. */
  parenthesizedDepth?: number
  sourceRange?: ReadableSourceRange
}

export interface CanonicalIdentifier extends CanonicalBase {
  kind: 'identifier'
  name: string
  syntaxCategory: 'identifier'
}

export interface CanonicalLiteral extends CanonicalBase {
  kind: 'literal'
  syntaxCategory: 'literal'
}

export interface CanonicalMemberAccess extends CanonicalBase {
  kind: 'member-access'
  owner: CanonicalExpression
  member: string
  optional: boolean
  syntaxCategory: 'property'
}

export interface CanonicalElementAccess extends CanonicalBase {
  kind: 'element-access'
  owner: CanonicalExpression
  element: CanonicalExpression
  optional: boolean
  syntaxCategory: 'property'
}

export interface CanonicalCall extends CanonicalBase {
  kind: 'call'
  callee: CanonicalExpression
  arguments: CanonicalExpression[]
  optional: boolean
  calleePath: string[]
  rootName?: string
  symbolEvidence: SymbolEvidence
  syntaxCategory: 'function'
}

export interface CanonicalAwait extends CanonicalBase {
  kind: 'await'
  expression: CanonicalExpression
  syntaxCategory: 'keyword'
}

export interface CanonicalBinary extends CanonicalBase {
  kind: 'binary'
  left: CanonicalExpression
  operator: ts.SyntaxKind
  right: CanonicalExpression
  syntaxCategory: 'operator'
}

export interface CanonicalArrowFunction extends CanonicalBase {
  kind: 'arrow-function'
  parameters: string[]
  expressionBody?: CanonicalExpression
  syntaxCategory: 'function'
}

export interface CanonicalSourceExpression extends CanonicalBase {
  kind: 'source-expression'
  syntaxCategory?: ReadableSyntaxCategory
}

export type CanonicalExpression =
  | CanonicalIdentifier
  | CanonicalLiteral
  | CanonicalMemberAccess
  | CanonicalElementAccess
  | CanonicalCall
  | CanonicalAwait
  | CanonicalBinary
  | CanonicalArrowFunction
  | CanonicalSourceExpression

export interface CanonicalBinding {
  name: string
  code: string
  sourceRange?: ReadableSourceRange
}

export interface CanonicalDeclaration extends CanonicalBase {
  kind: 'declaration'
  declarationKind: 'constant' | 'variable' | 'legacy variable'
  bindings: Array<{
    binding: CanonicalBinding
    type?: CanonicalSourceExpression
    initializer?: CanonicalExpression
  }>
}

export interface CanonicalExpressionStatement extends CanonicalBase {
  kind: 'expression-statement'
  expression: CanonicalExpression
}

export interface CanonicalReturn extends CanonicalBase {
  kind: 'return'
  expression?: CanonicalExpression
}

export interface CanonicalThrow extends CanonicalBase {
  kind: 'throw'
  expression: CanonicalExpression
}

export interface CanonicalSourceStatement extends CanonicalBase {
  kind: 'source-statement'
}

export type CanonicalStatement =
  | CanonicalDeclaration
  | CanonicalExpressionStatement
  | CanonicalReturn
  | CanonicalThrow
  | CanonicalSourceStatement

function sourceRange(node: ts.Node, context: SemanticContext): ReadableSourceRange | undefined {
  if (!context.absoluteSourceRanges) return undefined
  return { start: node.getStart(context.sourceFile), end: node.getEnd() }
}

function base(node: ts.Node, context: SemanticContext): CanonicalBase {
  const range = sourceRange(node, context)
  return {
    syntaxKind: ts.SyntaxKind[node.kind],
    code: formatSourceSnippetForDisplay(node.getText(context.sourceFile)),
    ...(range ? { sourceRange: range } : {}),
  }
}

function staticCalleePath(expression: ts.Expression): string[] {
  if (ts.isIdentifier(expression)) return [expression.text]
  if (ts.isPropertyAccessExpression(expression)) {
    return [...staticCalleePath(expression.expression), expression.name.text]
  }
  if (
    ts.isElementAccessExpression(expression)
    && ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return [...staticCalleePath(expression.expression), expression.argumentExpression.text]
  }
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
    return staticCalleePath(expression.expression)
  }
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isAwaitExpression(expression)
  ) {
    return staticCalleePath(expression.expression)
  }
  return []
}

function sourceExpression(
  node: ts.Expression | ts.TypeNode,
  context: SemanticContext,
  syntaxCategory?: ReadableSyntaxCategory,
): CanonicalSourceExpression {
  return { kind: 'source-expression', ...base(node, context), ...(syntaxCategory ? { syntaxCategory } : {}) }
}

export function canonicalExpression(node: ts.Expression, context: SemanticContext): CanonicalExpression {
  if (ts.isIdentifier(node)) {
    return { kind: 'identifier', ...base(node, context), name: node.text, syntaxCategory: 'identifier' }
  }
  if (
    ts.isStringLiteralLike(node)
    || ts.isNumericLiteral(node)
    || ts.isBigIntLiteral(node)
    || ts.isRegularExpressionLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword
    || node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return { kind: 'literal', ...base(node, context), syntaxCategory: 'literal' }
  }
  if (ts.isPropertyAccessExpression(node)) {
    return {
      kind: 'member-access',
      ...base(node, context),
      owner: canonicalExpression(node.expression, context),
      member: node.name.text,
      optional: Boolean(node.questionDotToken),
      syntaxCategory: 'property',
    }
  }
  if (ts.isElementAccessExpression(node)) {
    return {
      kind: 'element-access',
      ...base(node, context),
      owner: canonicalExpression(node.expression, context),
      element: canonicalExpression(node.argumentExpression, context),
      optional: Boolean(node.questionDotToken),
      syntaxCategory: 'property',
    }
  }
  if (ts.isCallExpression(node)) {
    const root = rootIdentifierForExpression(node.expression)
    return {
      kind: 'call',
      ...base(node, context),
      callee: canonicalExpression(node.expression, context),
      arguments: node.arguments.map((argument) => canonicalExpression(argument, context)),
      optional: Boolean(node.questionDotToken),
      calleePath: staticCalleePath(node.expression),
      ...(root ? { rootName: root.text } : {}),
      symbolEvidence: root
        ? symbolEvidence(root, context)
        : { modules: [], importedNames: [], declaredInSource: false },
      syntaxCategory: 'function',
    }
  }
  if (ts.isAwaitExpression(node)) {
    return {
      kind: 'await',
      ...base(node, context),
      expression: canonicalExpression(node.expression, context),
      syntaxCategory: 'keyword',
    }
  }
  if (ts.isBinaryExpression(node)) {
    return {
      kind: 'binary',
      ...base(node, context),
      left: canonicalExpression(node.left, context),
      operator: node.operatorToken.kind,
      right: canonicalExpression(node.right, context),
      syntaxCategory: 'operator',
    }
  }
  if (ts.isArrowFunction(node)) {
    return {
      kind: 'arrow-function',
      ...base(node, context),
      parameters: node.parameters.map((parameter) => parameter.name.getText(context.sourceFile)),
      ...(ts.isBlock(node.body) ? {} : { expressionBody: canonicalExpression(node.body, context) }),
      syntaxCategory: 'function',
    }
  }
  if (ts.isParenthesizedExpression(node)) {
    const expression = canonicalExpression(node.expression, context)
    return {
      ...expression,
      ...base(node, context),
      parenthesizedDepth: (expression.parenthesizedDepth ?? 0) + 1,
    }
  }
  return sourceExpression(node, context)
}

function declarationKind(list: ts.VariableDeclarationList): CanonicalDeclaration['declarationKind'] {
  if (list.flags & ts.NodeFlags.Const) return 'constant'
  if (list.flags & ts.NodeFlags.Let) return 'variable'
  return 'legacy variable'
}

export function canonicalStatement(node: ts.Statement, context: SemanticContext): CanonicalStatement {
  if (ts.isVariableStatement(node)) {
    return {
      kind: 'declaration',
      ...base(node, context),
      declarationKind: declarationKind(node.declarationList),
      bindings: node.declarationList.declarations.map((declaration) => {
        const bindingRange = sourceRange(declaration.name, context)
        return {
          binding: {
            name: declaration.name.getText(context.sourceFile),
            code: formatSourceSnippetForDisplay(declaration.name.getText(context.sourceFile)),
            ...(bindingRange ? { sourceRange: bindingRange } : {}),
          },
          ...(declaration.type ? { type: sourceExpression(declaration.type, context, 'type') } : {}),
          ...(declaration.initializer
            ? { initializer: canonicalExpression(declaration.initializer, context) }
            : {}),
        }
      }),
    }
  }
  if (ts.isExpressionStatement(node)) {
    return {
      kind: 'expression-statement',
      ...base(node, context),
      expression: canonicalExpression(node.expression, context),
    }
  }
  if (ts.isReturnStatement(node)) {
    return {
      kind: 'return',
      ...base(node, context),
      ...(node.expression ? { expression: canonicalExpression(node.expression, context) } : {}),
    }
  }
  if (ts.isThrowStatement(node)) {
    return {
      kind: 'throw',
      ...base(node, context),
      expression: canonicalExpression(node.expression, context),
    }
  }
  return { kind: 'source-statement', ...base(node, context) }
}

export function canonicalCodeExpression(
  node: ts.Expression,
  context: SemanticContext,
): CanonicalExpression {
  return canonicalExpression(node, context)
}
