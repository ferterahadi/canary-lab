import type { ReviewSource } from '../test-review'
import type { ReadableStoryItem } from './types'

const contains = (test: { line: number; endLine: number }, line: number): boolean => line >= test.line && line <= test.endLine

export const storyEndLine = (step: ReadableStoryItem): number => step.kind === 'flow' && step.footerStartLine == null ? step.headerEndLine ?? step.source.startLine : step.source.endLine

/** Continuation lines navigate to their English statement; flow bodies retain
 * their own rows rather than inheriting the enclosing function's full range. */
export function englishSourceRange(lines: ReturnType<typeof englishLines>, line: number): { line: number; endLine: number } {
  const endAt = (start: number): number => Math.max(start, ...(lines.get(start) ?? []).map(({ step }) => storyEndLine(step)))
  if (lines.get(line) === null) {
    for (let start = line - 1; start > 0; start--) if (endAt(start) >= line) return { line: start, endLine: endAt(start) }
  }
  return { line, endLine: endAt(line) }
}

/** English uses the same translator as test cards. Untranslated source stays
 * visible; navigation stays keyed to source rows even when wording is equal. */
export function englishLines(source: ReviewSource): Map<number, Array<{ step: ReadableStoryItem; depth: number }> | null> {
  const lines = new Map<number, Array<{ step: ReadableStoryItem; depth: number }> | null>()
  const visit = (items: ReadableStoryItem[], depth: number): void => {
    for (const item of items) {
      if (!source.story && item.source.file && !source.tests.some((test) => contains(test, item.source.startLine))) continue
      if (item.kind === 'flow' && item.flowKind === 'then') {
        visit(item.children, depth)
        continue
      }
      lines.set(item.source.startLine, [...(lines.get(item.source.startLine) ?? []), { step: item, depth }])
      if (item.kind === 'flow') {
        visit(item.children, depth + 1)
        for (let line = item.source.startLine + 1; line <= (item.headerEndLine ?? item.source.startLine); line++) if (!lines.has(line)) lines.set(line, null)
        if (item.footerStartLine != null) for (let line = item.footerStartLine; line <= item.source.endLine; line++) if (!lines.has(line)) lines.set(line, null)
      }
      else for (let line = item.source.startLine + 1; line <= item.source.endLine; line++) if (!lines.has(line)) lines.set(line, null)
    }
  }
  if (source.story) visit(source.story.steps, 0)
  else for (const test of source.tests) visit(test.readable.story?.steps ?? [], 0)
  // Closing delimiters carry no separate action. Only collapse them inside a
  // translated flow; arbitrary missing source must remain visible as a gap.
  if (source.story) {
    const sourceLines = source.source.split('\n')
    const structural = (items: ReadableStoryItem[]): void => {
      for (const item of items) if (item.kind === 'flow') {
        for (let line = item.source.startLine + 1; line <= item.source.endLine; line++) {
          if (!lines.has(line) && /^\s*[}\]);,]+\s*$/.test(sourceLines[line - 1] ?? '')) lines.set(line, null)
        }
        structural(item.children)
      }
    }
    structural(source.story.steps)
  }
  return lines
}
