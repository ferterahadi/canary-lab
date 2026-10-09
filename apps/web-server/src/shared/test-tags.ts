import ts from 'typescript'

export function findTestDetails(call: ts.CallExpression): ts.ObjectLiteralExpression | undefined {
  return call.arguments.find(ts.isObjectLiteralExpression)
}

// Extraction and edits both use the first authored tag/tags property. Computed
// keys and dynamic values are not evaluated while inspecting a test's source.
export function findTestTagProperty(detail: ts.ObjectLiteralExpression): ts.PropertyAssignment | undefined {
  return detail.properties.find(
    (prop): prop is ts.PropertyAssignment =>
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
      (prop.name.text === 'tag' || prop.name.text === 'tags'),
  )
}

export function readTagPropertyStrings(value: ts.Expression): string[] {
  if (ts.isStringLiteralLike(value)) return [value.text]
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.filter(ts.isStringLiteralLike).map((element) => element.text)
  }
  return []
}
