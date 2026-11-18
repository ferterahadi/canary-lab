import { unwrapExpression } from '../unwrap-expression'
import ts from 'typescript'

export function unwrapCallExpression(expression: ts.Expression): ts.Expression {
  return unwrapExpression(expression, { unwrapAwait: true })
}

export function callFromExpression(expression: ts.Expression): ts.CallExpression | undefined {
  const unwrapped = unwrapCallExpression(expression)
  return ts.isCallExpression(unwrapped) ? unwrapped : undefined
}

export function callFromStatement(statement: ts.Statement): ts.CallExpression | undefined {
  const expression = ts.isExpressionStatement(statement)
    ? statement.expression
    : ts.isReturnStatement(statement)
      ? statement.expression
      : ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
        ? statement.declarationList.declarations[0].initializer
        : undefined
  return expression ? callFromExpression(expression) : undefined
}

export function authoredStepLabel(call?: ts.CallExpression): string | undefined {
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
  return label && ts.isStringLiteralLike(label) ? label.text : undefined
}

export function authoredStep(statement: ts.Statement): { label: string; body: ts.Block } | undefined {
  const call = callFromStatement(statement)
  const label = authoredStepLabel(call)
  const callback = call?.arguments[1]
  if (
    label === undefined
    || !callback
    || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
    || !ts.isBlock(callback.body)
  ) {
    return undefined
  }
  return { label, body: callback.body }
}

