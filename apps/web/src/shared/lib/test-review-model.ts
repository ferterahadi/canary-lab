import type { ReviewSource, TestFileReview } from '@shared/test-review'
import type { ReadableStoryItem } from '@shared/readable-tests/types'
import type { ContextRow } from '@shared/test-source-diff'
export { sourceRows, rowsForTest, testSelections, type ContextRow } from '@shared/test-source-diff'

const contains = (test: { line: number; endLine: number }, line?: number): boolean => line != null && line >= test.line && line <= test.endLine

/** English uses the same translator as test cards. Untranslated source stays
 * visible; navigation stays keyed to source rows even when wording is equal. */
export function englishLines(source: ReviewSource): Map<number, string> {
  const lines = new Map<number, string>()
  const visit = (items: ReadableStoryItem[], depth: number): void => {
    for (const item of items) {
      if (item.source.file && !source.tests.some((test) => contains(test, item.source.startLine))) continue
      lines.set(item.source.startLine, `${'  '.repeat(depth)}${item.text}`)
      if (item.kind === 'flow') visit(item.children, depth + 1)
      else for (let line = item.source.startLine + 1; line <= item.source.endLine; line++) lines.set(line, '')
    }
  }
  for (const test of source.tests) visit(test.readable.story?.steps ?? [], 0)
  return lines
}

function predicateContains(source: string, predicate: { line: number; source: string }, line?: number): boolean {
  if (line == null || line < predicate.line) return false
  const lines = source.split('\n')
  const expected = predicate.source.replace(/\s+/g, ' ').trim()
  let collected = ''
  for (let end = predicate.line; end <= lines.length; end++) {
    collected += ` ${lines[end - 1]}`
    if (collected.replace(/\s+/g, ' ').includes(expected)) return line <= end
  }
  return line === predicate.line
}

export function assessmentsForRows(review: TestFileReview, rows: ContextRow[]) {
  return review.assessment.tests.flatMap((test) => test.changes.filter((change) => rows.some((row) =>
    (change.before && predicateContains(review.before.source, change.before, row.beforeLine)) || (change.after && predicateContains(review.after.source, change.after, row.afterLine)))))
}
