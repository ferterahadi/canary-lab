import ts from 'typescript'
import type { ReadableStoryItem, ReadableTestStory } from '../../../../../shared/readable-tests/types'

/** A file review compares fields of a module-level config individually. Folding
 * an entire object into one sentence hides which field was added or removed. */
export function reviewOutline(story: ReadableTestStory, sourceFile: ts.SourceFile): ReadableTestStory | undefined {
  const fields = new Map<number, { name: string; properties: ts.NodeArray<ts.ObjectLiteralElementLike> }>()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue
    const [binding] = statement.declarationList.declarations
    if (binding.initializer && ts.isObjectLiteralExpression(binding.initializer)) {
      const line = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1
      fields.set(line, { name: binding.name.getText(sourceFile), properties: binding.initializer.properties })
    }
  }
  if (!fields.size) return
  return {
    steps: story.steps.map((step): ReadableStoryItem => {
      const object = fields.get(step.source.startLine)
      if (!object || step.role !== 'setup' || !object.properties.length) return step
      const text = 'Define ' + object.name
      const children = object.properties.map((property): ReadableStoryItem => {
        const start = property.getStart(sourceFile)
        const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1
        const endLine = sourceFile.getLineAndCharacterOfPosition(property.end - 1).line + 1
        const name = property.name?.getText(sourceFile)
        const value = ts.isPropertyAssignment(property) ? property.initializer : undefined
        const text = !name
          ? 'Include ' + property.getText(sourceFile)
          : value && ts.isArrayLiteralExpression(value)
            ? 'Set ' + name + ' (' + value.elements.length + (value.elements.length === 1 ? ' item)' : ' items)')
            : value && ts.isObjectLiteralExpression(value)
              ? 'Configure ' + name
              : value
                ? 'Set ' + name + ' to ' + value.getText(sourceFile)
                : 'Include ' + name
        return {
          id: step.id + '-' + start,
          role: 'setup',
          text,
          spans: [{ text }],
          fidelity: 'derived',
          source: { file: step.source.file, startLine, endLine, snippet: property.getText(sourceFile) },
        }
      })
      return {
        ...step,
        kind: 'flow',
        flowKind: 'scope',
        headerEndLine: step.source.startLine,
        text,
        spans: [{ text }],
        children,
      }
    }),
  }
}
