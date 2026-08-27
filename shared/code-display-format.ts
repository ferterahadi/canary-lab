import ts from 'typescript'

export interface FormattedDisplayLine {
  /** Primary source row for navigation. */
  sourceLine: number
  /** Every source row represented by this display row. Usually one; more than
   *  one is possible when the printer compacts a multiline expression. */
  sourceLines: number[]
}

export interface FormattedCodeDisplay {
  code: string
  /** One entry per row in `code`, in the same order. */
  lineMap: FormattedDisplayLine[]
}

export function formatCodeForDisplay(source: string): string {
  return printCodeForDisplay(source).code
}

/** Format a TypeScript/JavaScript snippet without touching its source file and
 * retain enough origin information for editor links and run/diff highlights.
 * `sourceStartLine` is the absolute row represented by the snippet's first
 * input line; callers that only need relative rows can leave it at 1. */
export function formatCodeForDisplayWithLineMap(
  source: string,
  sourceStartLine = 1,
): FormattedCodeDisplay {
  const printed = printCodeForDisplay(source)
  if (!printed.code) return { code: '', lineMap: [] }
  return {
    code: printed.code,
    lineMap: mapDisplayLines(
      printed.source,
      printed.code,
      sourceStartLine + printed.leadingLineCount,
    ),
  }
}

function printCodeForDisplay(source: string): {
  code: string
  source: string
  leadingLineCount: number
} {
  const normalized = source.replace(/\r\n/g, '\n')
  const firstContent = normalized.search(/\S/)
  if (firstContent === -1) return { code: '', source: '', leadingLineCount: 0 }
  const trimmed = normalized.trim()
  const leadingLineCount = normalized.slice(0, firstContent).split('\n').length - 1

  const parsed = ts.createSourceFile('display-snippet.ts', trimmed, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const code = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  }).printList(ts.ListFormat.MultiLine, parsed.statements, parsed).trim()
    || trimmed

  return { code, source: trimmed, leadingLineCount }
}

interface ScannedToken {
  kind: ts.SyntaxKind
  text: string
  startLine: number
  endLine: number
}

function mapDisplayLines(source: string, code: string, sourceStartLine: number): FormattedDisplayLine[] {
  const sourceTokens = scanTokens(source)
  const displayTokens = scanTokens(code)
  const tokenMatches = alignTokens(sourceTokens, displayTokens)
  const sourceRows = source.split('\n')
  const displayRows = code.split('\n')
  const sourceLinesByDisplayLine = Array.from(
    { length: displayRows.length },
    () => new Set<number>(),
  )

  for (const [displayTokenIndex, sourceTokenIndex] of tokenMatches) {
    const display = displayTokens[displayTokenIndex]
    const original = sourceTokens[sourceTokenIndex]
    const displaySpan = display.endLine - display.startLine
    const sourceSpan = original.endLine - original.startLine
    for (let offset = 0; offset <= displaySpan; offset++) {
      const displayLine = display.startLine + offset
      const sourceLine = original.startLine + Math.min(offset, sourceSpan)
      sourceLinesByDisplayLine[displayLine - 1]?.add(sourceStartLine + sourceLine - 1)
    }
  }

  const emptyStatementSourceLines = sourceRows.flatMap((row, index) => (
    /^;+$/.test(row.trim()) ? [sourceStartLine + index] : []
  ))
  let emptyStatementIndex = 0
  return sourceLinesByDisplayLine.map((mappedSourceLines, displayIndex) => {
    const sourceLines = [...mappedSourceLines].sort((a, b) => a - b)
    if (sourceLines.length === 0) {
      const emptyStatementLine = /^;+$/.test(displayRows[displayIndex].trim())
        ? emptyStatementSourceLines[emptyStatementIndex++]
        : undefined
      sourceLines.push(
        emptyStatementLine
          ?? sourceStartLine + Math.min(displayIndex, sourceRows.length - 1),
      )
    }
    return { sourceLine: sourceLines[0], sourceLines }
  })
}

function scanTokens(source: string): ScannedToken[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  )
  const lineStarts = lineStartOffsets(source)
  const tokens: ScannedToken[] = []
  let braceDepth = 0
  const templateBraceDepths: number[] = []
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.TemplateHead) {
      templateBraceDepths.push(braceDepth)
    } else if (kind === ts.SyntaxKind.OpenBraceToken) {
      braceDepth += 1
    } else if (kind === ts.SyntaxKind.CloseBraceToken) {
      if (templateBraceDepths.at(-1) === braceDepth) {
        kind = scanner.reScanTemplateToken(false)
        if (kind === ts.SyntaxKind.TemplateTail) templateBraceDepths.pop()
      } else {
        braceDepth = Math.max(0, braceDepth - 1)
      }
    }
    if (
      kind === ts.SyntaxKind.WhitespaceTrivia ||
      kind === ts.SyntaxKind.NewLineTrivia ||
      kind === ts.SyntaxKind.SemicolonToken
    ) continue
    const start = scanner.getTokenPos()
    const end = scanner.getTextPos()
    tokens.push({
      kind,
      text: scanner.getTokenText(),
      startLine: lineAtOffset(lineStarts, start),
      endLine: lineAtOffset(lineStarts, Math.max(start, end - 1)),
    })
  }
  return tokens
}

function lineStartOffsets(source: string): number[] {
  const offsets = [0]
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') offsets.push(index + 1)
  }
  return offsets
}

function lineAtOffset(lineStarts: number[], offset: number): number {
  let low = 0
  let high = lineStarts.length
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (lineStarts[middle] <= offset) low = middle
    else high = middle
  }
  return low + 1
}

/** Align in source order so a token removed or inserted by the printer only
 * affects its local edit. Independent occurrence matching is unsafe here: one
 * removed trailing comma would make every later printed comma point at the
 * preceding source occurrence. */
function alignTokens(
  sourceTokens: ScannedToken[],
  displayTokens: ScannedToken[],
): Array<[displayTokenIndex: number, sourceTokenIndex: number]> {
  const sourceIndexesByToken = indexesByToken(sourceTokens)
  const displayIndexesByToken = indexesByToken(displayTokens)
  const matches: Array<[number, number]> = []
  let sourceIndex = 0
  let displayIndex = 0
  while (sourceIndex < sourceTokens.length && displayIndex < displayTokens.length) {
    const sourceToken = sourceTokens[sourceIndex]
    const displayToken = displayTokens[displayIndex]
    const sourceKey = tokenKey(sourceToken)
    const displayKey = tokenKey(displayToken)
    if (sourceKey === displayKey) {
      matches.push([displayIndex, sourceIndex])
      sourceIndex += 1
      displayIndex += 1
      continue
    }

    const nextSourceIndex = nextTokenIndex(sourceIndexesByToken.get(displayKey), sourceIndex)
    const nextDisplayIndex = nextTokenIndex(displayIndexesByToken.get(sourceKey), displayIndex)
    const sourceDistance = nextSourceIndex === undefined ? Infinity : nextSourceIndex - sourceIndex
    const displayDistance = nextDisplayIndex === undefined ? Infinity : nextDisplayIndex - displayIndex

    if (
      nextSourceIndex !== undefined
      && (
        sourceDistance < displayDistance
        || (sourceDistance === displayDistance && isPunctuation(sourceToken) && !isPunctuation(displayToken))
      )
    ) {
      sourceIndex = nextSourceIndex
    } else if (
      nextDisplayIndex !== undefined
      && (
        displayDistance < sourceDistance
        || (displayDistance === sourceDistance && isPunctuation(displayToken) && !isPunctuation(sourceToken))
      )
    ) {
      displayIndex = nextDisplayIndex
    } else {
      // The recovery printer can replace a malformed token. Neither side is a
      // trustworthy anchor, so consume the local pair and resume in order.
      sourceIndex += 1
      displayIndex += 1
    }
  }
  return matches
}

function tokenKey(token: ScannedToken): string {
  const text = token.kind === ts.SyntaxKind.NumericLiteral || token.kind === ts.SyntaxKind.BigIntLiteral
    ? token.text.replaceAll('_', '')
    : token.text
  return `${token.kind}\0${text}`
}

function indexesByToken(tokens: ScannedToken[]): Map<string, number[]> {
  const indexesByToken = new Map<string, number[]>()
  tokens.forEach((token, index) => {
    const key = tokenKey(token)
    const indexes = indexesByToken.get(key) ?? []
    indexes.push(index)
    indexesByToken.set(key, indexes)
  })
  return indexesByToken
}

function nextTokenIndex(indexes: number[] | undefined, currentIndex: number): number | undefined {
  if (!indexes) return undefined
  let low = 0
  let high = indexes.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (indexes[middle] <= currentIndex) low = middle + 1
    else high = middle
  }
  return indexes[low]
}

function isPunctuation(token: ScannedToken): boolean {
  return token.kind >= ts.SyntaxKind.FirstPunctuation && token.kind <= ts.SyntaxKind.LastPunctuation
}

// Line-preserving formatter for already-well-formed source slices (e.g. an AST
// node's body text). Unlike formatCodeForDisplay it never reflows code or drops
// blank lines, so line N of the output always maps onto line N of the input.
// The live test view depends on this: it highlights the latest trustworthy
// Playwright step call site and resolves "open in editor" by adding a body-line
// offset to the snippet's start line, both of which assume a 1:1 line
// correspondence. Re-printing the AST (as formatCodeForDisplay does) collapses
// blank lines and shifts every subsequent line, so it must not be used where
// line mapping matters.
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
