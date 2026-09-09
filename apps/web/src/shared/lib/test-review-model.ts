import type { ReviewSource, ReviewTestSource, TestFileReview } from '@shared/test-review'
import type { ReadableStoryItem } from '@shared/readable-tests/types'
import { comparisonPatchRows } from '@/shared/lib/comparison-diff'

export interface ContextRow {
  id: string
  before: string | null
  after: string | null
  beforeLine?: number
  afterLine?: number
  change?: number
}

export function sourceRows(review: TestFileReview): ContextRow[] {
  const pairs = review.patch ? comparisonPatchRows(review.patch).filter((row) => row.kind === 'values')
    : review.after.source.split('\n').map((text) => ({ kind: 'values' as const, before: text, after: text }))
  let beforeLine = 0
  let afterLine = 0
  let change = 0
  let wasChanged = false
  return pairs.map((pair, index) => {
    const changed = pair.before !== pair.after
    if (changed && !wasChanged) change++
    wasChanged = changed
    return { id: `source-${index}`, before: pair.before, after: pair.after,
      beforeLine: pair.before === null ? undefined : ++beforeLine,
      afterLine: pair.after === null ? undefined : ++afterLine,
      ...(changed ? { change } : {}) }
  })
}

export interface TestSelection { key: string; test: ReviewTestSource; side: 'before' | 'after' }
const contains = (test: ReviewTestSource, line?: number): boolean => line != null && line >= test.line && line <= test.endLine

/** Test boundaries come from the source, not names: generated cases and renamed
 * tests can share a name or change it while retaining their code context. */
export function testSelections(review: TestFileReview, rows: ContextRow[]): TestSelection[] {
  return [
    ...review.after.tests.map((test) => ({ key: `after:${test.line}`, test, side: 'after' as const })),
    ...review.before.tests.filter((test) => !rows.some((row) => contains(test, row.beforeLine) && review.after.tests.some((after) => contains(after, row.afterLine))))
      .map((test) => ({ key: `before:${test.line}`, test, side: 'before' as const })),
  ]
}

export function rowsForTest(rows: ContextRow[], selected: TestSelection | undefined, review: TestFileReview): ContextRow[] {
  if (!selected) return rows
  const own = selected.side === 'after' ? 'afterLine' : 'beforeLine'
  const other = selected.side === 'after' ? 'beforeLine' : 'afterLine'
  const opposite = review[selected.side === 'after' ? 'before' : 'after'].tests.filter((test) => rows.some((row) => contains(selected.test, row[own]) && contains(test, row[other])))
  return rows.filter((row) => contains(selected.test, row[own]) || opposite.some((test) => contains(test, row[other])))
}

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
