import type { ReviewSource, TestFileReview, VersionTest, TestChangeKind } from '@shared/test-review'
import type { ReadableStoryItem } from '@shared/readable-tests/types'
import type { ContextRow } from '@shared/test-source-diff'
import { compareText } from './comparison-diff'
export { sourceRows, rowsForTest, testSelections, type ContextRow } from '@shared/test-source-diff'

const contains = (test: { line: number; endLine: number }, line?: number): boolean => line != null && line >= test.line && line <= test.endLine

/** Diff the selected declarations independently. File-level alignment can pair a
 * deleted test with a neighbouring addition or shared setup on the other side. */
export function comparedTestRows(review: TestFileReview, test: VersionTest, kind: TestChangeKind): ContextRow[] {
  const previous = test.previous ?? review.before.tests.find((candidate) => candidate.name === test.name)
  const ranges = { before: kind === 'added' ? undefined : kind === 'removed' ? test : previous,
    after: kind === 'removed' ? undefined : test }
  const snippet = (side: 'before' | 'after'): string => {
    const range = ranges[side]
    return range ? review[side].source.split('\n').slice(range.line - 1, range.endLine).join('\n') + '\n' : ''
  }
  const parts = compareText(snippet('before'), snippet('after'), 'lines')
  const lines = (side: 'before' | 'after') => parts[side].flatMap((part) => part.text.slice(0, -1).split('\n').map((text) => ({ text, changed: part.changed })))
  const left = lines('before'); const right = lines('after')
  const rows: ContextRow[] = []
  let a = 0; let b = 0; let change = 0
  const append = (before: number | undefined, after: number | undefined, changed: boolean) => rows.push({
    id: `test-source-${rows.length}`, before: before == null ? null : left[before].text, after: after == null ? null : right[after].text,
    beforeLine: before == null ? undefined : ranges.before!.line + before,
    afterLine: after == null ? undefined : ranges.after!.line + after,
    ...(changed ? { change } : {}),
  })
  if (review.comparisonAlignment?.length) {
    const until = (endA = a, endB = b) => {
      while (a < endA || b < endB) append(a < endA ? a++ : undefined, b < endB ? b++ : undefined, true)
    }
    const relative = (side: 'before' | 'after', line?: number) => line != null && ranges[side] ? line - ranges[side].line : undefined
    for (const pair of review.comparisonAlignment) {
      const within = (side: 'before' | 'after') => {
        const own = ranges[side]; const anchor = pair[side]
        return own && anchor && contains(own, anchor.line) ? { ...anchor, endLine: Math.min(anchor.endLine, own.endLine) } : undefined
      }
      const before = within('before'); const after = within('after')
      if (!before && !after) continue
      until(relative('before', before?.line), relative('after', after?.line))
      until(relative('before', before ? before.endLine + 1 : undefined), relative('after', after ? after.endLine + 1 : undefined))
    }
    until(left.length, right.length)
  } else {
    while (a < left.length || b < right.length) {
      if (left[a]?.changed || right[b]?.changed) {
        change++
        while (left[a]?.changed || right[b]?.changed) append(left[a]?.changed ? a++ : undefined, right[b]?.changed ? b++ : undefined, true)
      } else append(a < left.length ? a++ : undefined, b < right.length ? b++ : undefined, false)
    }
  }
  if (!review.meaningfulChanges) return rows
  const meaningful = { before: new Set(review.meaningfulChanges.before), after: new Set(review.meaningfulChanges.after) }
  return rows.map((row) => {
    const beforeChanged = row.beforeLine != null && meaningful.before.has(row.beforeLine)
    const afterChanged = row.afterLine != null && meaningful.after.has(row.afterLine)
    return { ...row, change: beforeChanged || afterChanged ? row.change ?? 1 : undefined, beforeChanged, afterChanged }
  })
}

export const storyEndLine = (step: ReadableStoryItem): number => step.kind === 'flow' ? step.headerEndLine ?? step.source.startLine : step.source.endLine

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
      }
      else for (let line = item.source.startLine + 1; line <= item.source.endLine; line++) if (!lines.has(line)) lines.set(line, null)
    }
  }
  if (source.story) visit(source.story.steps, 0)
  else for (const test of source.tests) visit(test.readable.story?.steps ?? [], 0)
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
