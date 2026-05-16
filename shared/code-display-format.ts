import ts from 'typescript'

export function formatCodeForDisplay(source: string): string {
  const normalized = source.replace(/\r\n/g, '\n').trim()
  if (!normalized) return ''

  const parsed = ts.createSourceFile('display-snippet.ts', normalized, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const formatted = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  }).printList(ts.ListFormat.MultiLine, parsed.statements, parsed).trim()

  return formatted || normalized
}
