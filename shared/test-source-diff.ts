import { comparisonPatchRows } from './comparison-patch'

export interface SourceTest { name: string; line: number; endLine: number }
export interface SourceComparison { before: { source: string; tests: SourceTest[] }; after: { source: string; tests: SourceTest[] }; patch: string }

export interface ContextRow {
  id: string
  before: string | null
  after: string | null
  beforeLine?: number
  afterLine?: number
  change?: number
}

export function sourceRows(review: SourceComparison): ContextRow[] {
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

export interface TestSelection { key: string; test: SourceTest; side: 'before' | 'after' }
const contains = (test: SourceTest, line?: number): boolean => line != null && line >= test.line && line <= test.endLine

/** Test boundaries come from the source, not names: generated cases and renamed
 * tests can share a name or change it while retaining their code context. */
export function testSelections(review: SourceComparison, rows: ContextRow[]): TestSelection[] {
  return [
    ...review.after.tests.map((test) => ({ key: `after:${test.line}`, test, side: 'after' as const })),
    ...review.before.tests.filter((test) => !rows.some((row) => contains(test, row.beforeLine) && review.after.tests.some((after) => contains(after, row.afterLine))))
      .map((test) => ({ key: `before:${test.line}`, test, side: 'before' as const })),
  ]
}

export function rowsForTest(rows: ContextRow[], selected: TestSelection | undefined, review: SourceComparison): ContextRow[] {
  if (!selected) return rows
  const own = selected.side === 'after' ? 'afterLine' : 'beforeLine'
  const other = selected.side === 'after' ? 'beforeLine' : 'afterLine'
  const opposite = review[selected.side === 'after' ? 'before' : 'after'].tests.filter((test) => rows.some((row) => contains(selected.test, row[own]) && contains(test, row[other])))
  return rows.filter((row) => contains(selected.test, row[own]) || opposite.some((test) => contains(test, row[other])))
}

