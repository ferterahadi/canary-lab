import ts from 'typescript'

export function readLiteralTestTitle(call: ts.CallExpression): string | null {
  const arg = call.arguments[0]
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null
}

/** Display unresolved templates verbatim; mutation callers must use the literal reader. */
export function readDisplayTestTitle(call: ts.CallExpression, sourceFile: ts.SourceFile): string | null {
  const literal = readLiteralTestTitle(call)
  if (literal !== null) return literal
  const arg = call.arguments[0]
  return arg && ts.isTemplateExpression(arg) ? arg.getText(sourceFile).slice(1, -1) : null
}
