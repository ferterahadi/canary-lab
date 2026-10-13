import ts from 'typescript'

/** Await is meaningful to some syntax consumers; only call-oriented readers
 * opt into crossing it. All other wrappers here preserve the runtime value. */
export function unwrapExpression(expression: ts.Expression, { unwrapAwait }: { unwrapAwait: boolean }): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || (unwrapAwait && ts.isAwaitExpression(expression))
  ) expression = expression.expression
  return expression
}
