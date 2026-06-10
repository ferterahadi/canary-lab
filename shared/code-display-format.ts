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

// Line-preserving formatter for already-well-formed source slices (e.g. an AST
// node's body text). Unlike formatCodeForDisplay it never reflows code or drops
// blank lines, so line N of the output always maps onto line N of the input.
// The live test view depends on this: it highlights the currently-running line
// and resolves "open in editor" by adding a body-line offset to the snippet's
// start line, both of which assume a 1:1 line correspondence. Re-printing the
// AST (as formatCodeForDisplay does) collapses blank lines and shifts every
// subsequent line, so it must not be used where line mapping matters.
export function formatSourceSnippetForDisplay(source: string): string {
  const normalized = source.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length <= 1) return normalized

  // Dedent by the common indentation of every non-blank line except the first
  // — the opening brace sits at the call's column and would otherwise pin the
  // shared indent to zero. Stripping only leading whitespace (never more than a
  // line actually has) keeps the line count, and therefore the mapping, intact.
  let minIndent = Infinity
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    minIndent = Math.min(minIndent, line.length - line.trimStart().length)
  }
  if (!Number.isFinite(minIndent) || minIndent <= 0) return normalized

  return lines
    .map((line, i) => {
      if (i === 0) return line
      const indent = line.length - line.trimStart().length
      return line.slice(Math.min(indent, minIndent))
    })
    .join('\n')
}
