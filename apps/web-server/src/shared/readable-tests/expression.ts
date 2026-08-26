import ts from 'typescript'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import type { ReadableFidelity } from '../../../../../shared/readable-tests/types'
import { humanizeIdentifier } from './language'

export interface RenderedExpression {
  text: string
  fidelity: ReadableFidelity
}

interface RenderedPart extends RenderedExpression {
  compound: boolean
}

const BINARY_OPERATORS = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.EqualsEqualsToken, 'equals'],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, 'equals'],
  [ts.SyntaxKind.ExclamationEqualsToken, 'does not equal'],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, 'does not equal'],
  [ts.SyntaxKind.LessThanToken, 'is less than'],
  [ts.SyntaxKind.LessThanEqualsToken, 'is at most'],
  [ts.SyntaxKind.GreaterThanToken, 'is greater than'],
  [ts.SyntaxKind.GreaterThanEqualsToken, 'is at least'],
  [ts.SyntaxKind.AmpersandAmpersandToken, 'and'],
  [ts.SyntaxKind.BarBarToken, 'or'],
  [ts.SyntaxKind.QuestionQuestionToken, 'or, when missing,'],
  [ts.SyntaxKind.PlusToken, 'plus'],
  [ts.SyntaxKind.MinusToken, 'minus'],
  [ts.SyntaxKind.AsteriskToken, 'multiplied by'],
  [ts.SyntaxKind.SlashToken, 'divided by'],
  [ts.SyntaxKind.PercentToken, 'modulo'],
  [ts.SyntaxKind.AsteriskAsteriskToken, 'raised to'],
  [ts.SyntaxKind.InKeyword, 'is in'],
  [ts.SyntaxKind.InstanceOfKeyword, 'is an instance of'],
])

function mergeFidelity(parts: RenderedExpression[], fallback: ReadableFidelity = 'derived'): ReadableFidelity {
  if (parts.some((part) => part.fidelity === 'unresolved')) return 'unresolved'
  if (parts.every((part) => part.fidelity === 'exact')) return fallback
  return 'derived'
}

function quote(value: string): string {
  return `“${value.replace(/“/g, '\\“').replace(/”/g, '\\”')}”`
}

function unresolved(node: ts.Node, sourceFile: ts.SourceFile): RenderedPart {
  return {
    text: formatSourceSnippetForDisplay(node.getText(sourceFile)),
    fidelity: 'unresolved',
    compound: false,
  }
}

function childText(part: RenderedPart): string {
  return part.compound ? `(${part.text})` : part.text
}

function renderPropertyName(name: ts.PropertyName, sourceFile: ts.SourceFile): RenderedExpression {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return { text: humanizeIdentifier(name.text), fidelity: 'derived' }
  }
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return { text: name.text, fidelity: 'exact' }
  }
  return { text: formatSourceSnippetForDisplay(name.getText(sourceFile)), fidelity: 'unresolved' }
}

function renderTemplate(node: ts.TemplateExpression, sourceFile: ts.SourceFile): RenderedPart {
  const parts: RenderedExpression[] = []
  let text = node.head.text
  for (const span of node.templateSpans) {
    const rendered = renderPart(span.expression, sourceFile)
    parts.push(rendered)
    text += `{${rendered.text}}${span.literal.text}`
  }
  return {
    text: quote(text),
    fidelity: mergeFidelity(parts),
    compound: false,
  }
}

function renderArray(node: ts.ArrayLiteralExpression, sourceFile: ts.SourceFile): RenderedPart {
  if (!node.elements.length) return { text: 'an empty list', fidelity: 'derived', compound: false }
  const elements = node.elements.map((element) => renderPart(element, sourceFile))
  if (elements.some((element) => element.fidelity === 'unresolved')) return unresolved(node, sourceFile)
  return {
    text: `a list containing ${elements.map((element) => element.text).join(', ')}`,
    fidelity: 'derived',
    compound: false,
  }
}

function renderObject(node: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): RenderedPart {
  if (!node.properties.length) return { text: 'an empty object', fidelity: 'derived', compound: false }
  const properties: RenderedExpression[] = []
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = renderPropertyName(property.name, sourceFile)
      const value = renderPart(property.initializer, sourceFile)
      properties.push({
        text: `${name.text} set to ${value.text}`,
        fidelity: mergeFidelity([name, value]),
      })
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      properties.push({ text: humanizeIdentifier(property.name.text), fidelity: 'derived' })
      continue
    }
    return unresolved(node, sourceFile)
  }
  if (properties.some((property) => property.fidelity === 'unresolved')) return unresolved(node, sourceFile)
  return {
    text: `an object with ${properties.map((property) => property.text).join(', ')}`,
    fidelity: 'derived',
    compound: false,
  }
}

function renderPart(node: ts.Expression, sourceFile: ts.SourceFile): RenderedPart {
  if (ts.isStringLiteralLike(node)) {
    return { text: quote(node.text), fidelity: 'exact', compound: false }
  }
  if (ts.isNumericLiteral(node)) {
    return { text: node.text, fidelity: 'exact', compound: false }
  }
  if (ts.isRegularExpressionLiteral(node)) {
    return { text: node.getText(sourceFile), fidelity: 'exact', compound: false }
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { text: 'true', fidelity: 'exact', compound: false }
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { text: 'false', fidelity: 'exact', compound: false }
  if (node.kind === ts.SyntaxKind.NullKeyword) return { text: 'null', fidelity: 'exact', compound: false }
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined') return { text: 'undefined', fidelity: 'exact', compound: false }
    return { text: humanizeIdentifier(node.text), fidelity: 'derived', compound: false }
  }
  if (ts.isTemplateExpression(node)) return renderTemplate(node, sourceFile)
  if (ts.isParenthesizedExpression(node)) {
    const rendered = renderPart(node.expression, sourceFile)
    return { ...rendered, compound: true }
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return renderPart(node.expression, sourceFile)
  }
  if (ts.isAwaitExpression(node)) {
    const expression = renderPart(node.expression, sourceFile)
    return expression.fidelity === 'unresolved' ? unresolved(node, sourceFile) : expression
  }
  if (ts.isPropertyAccessExpression(node)) {
    const owner = renderPart(node.expression, sourceFile)
    if (owner.fidelity === 'unresolved') return unresolved(node, sourceFile)
    const property = humanizeIdentifier(node.name.text)
    return {
      text: `${owner.text} ${property}${node.questionDotToken ? ', if available' : ''}`,
      fidelity: 'derived',
      compound: false,
    }
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression && (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))) {
    const owner = renderPart(node.expression, sourceFile)
    if (owner.fidelity === 'unresolved') return unresolved(node, sourceFile)
    return {
      text: `${owner.text} ${node.argumentExpression.text}${node.questionDotToken ? ', if available' : ''}`,
      fidelity: 'derived',
      compound: false,
    }
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = renderPart(node.operand, sourceFile)
    if (operand.fidelity === 'unresolved') return unresolved(node, sourceFile)
    const operator = new Map<ts.PrefixUnaryOperator, string>([
      [ts.SyntaxKind.ExclamationToken, 'not'],
      [ts.SyntaxKind.PlusToken, 'positive'],
      [ts.SyntaxKind.MinusToken, 'negative'],
      [ts.SyntaxKind.TildeToken, 'bitwise not'],
    ]).get(node.operator)
    return operator
      ? { text: `${operator} ${childText(operand)}`, fidelity: 'derived', compound: true }
      : unresolved(node, sourceFile)
  }
  if (ts.isTypeOfExpression(node)) {
    const expression = renderPart(node.expression, sourceFile)
    return expression.fidelity === 'unresolved'
      ? unresolved(node, sourceFile)
      : { text: `the type of ${childText(expression)}`, fidelity: 'derived', compound: true }
  }
  if (ts.isBinaryExpression(node)) {
    const operator = BINARY_OPERATORS.get(node.operatorToken.kind)
    if (!operator) return unresolved(node, sourceFile)
    const left = renderPart(node.left, sourceFile)
    const right = renderPart(node.right, sourceFile)
    if (left.fidelity === 'unresolved' || right.fidelity === 'unresolved') return unresolved(node, sourceFile)
    return {
      text: `${childText(left)} ${operator} ${childText(right)}`,
      fidelity: 'derived',
      compound: true,
    }
  }
  if (ts.isConditionalExpression(node)) {
    const condition = renderPart(node.condition, sourceFile)
    const whenTrue = renderPart(node.whenTrue, sourceFile)
    const whenFalse = renderPart(node.whenFalse, sourceFile)
    if ([condition, whenTrue, whenFalse].some((part) => part.fidelity === 'unresolved')) return unresolved(node, sourceFile)
    return {
      text: `${whenTrue.text} when ${condition.text}; otherwise ${whenFalse.text}`,
      fidelity: 'derived',
      compound: true,
    }
  }
  if (ts.isArrayLiteralExpression(node)) return renderArray(node, sourceFile)
  if (ts.isObjectLiteralExpression(node)) return renderObject(node, sourceFile)
  return unresolved(node, sourceFile)
}

/** Renders syntax only. The source is never evaluated, imported, or executed. */
export function renderExpression(node: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression {
  const { compound: _compound, ...rendered } = renderPart(node, sourceFile)
  return rendered
}

export function renderCondition(node: ts.Expression, sourceFile: ts.SourceFile): RenderedExpression {
  return renderExpression(node, sourceFile)
}
