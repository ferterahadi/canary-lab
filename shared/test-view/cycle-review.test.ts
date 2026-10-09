import { describe, expect, it } from 'vitest'
import { cycleFileAlignedInput, cycleReviewFromPatch } from './cycle-review'
import { alignedTestViewRows } from './render-model'
import {
  ADDED_FILE, BINARY_FILES, DELETED_FILE, HEADERLESS_FRAGMENT, LINE_ENDINGS, NO_NEWLINE_AT_END, RENAMES, TWO_FILE_CYCLE, ZERO_COUNT_HUNK,
} from './__fixtures__/cycle-patches'

const lines = (rows: ReturnType<typeof cycleReviewFromPatch>[number]['rows']) => rows.map((row) => [row.beforeLine ?? null, row.afterLine ?? null])

describe('cycleReviewFromPatch', () => {
  it('reads each file with the line numbers its hunks give and counts the lines between hunks', () => {
    const [pricing, staging] = cycleReviewFromPatch(TWO_FILE_CYCLE)
    expect(pricing).toMatchObject({
      path: 'src/pricing.ts', repo: '/workspace/features/alpha', change: 'modified',
      blobs: { before: '33dd6fb', after: 'ff7213c' }, lineEnding: 'lf',
    })
    expect(pricing.previousPath).toBeUndefined()
    expect(lines(pricing.rows)).toEqual([[1, 1], [2, 2], [3, 3], [40, 40], [null, 41], [null, 42], [41, 43]])
    expect(pricing.rows.map((row) => row.gap)).toEqual([undefined, undefined, undefined, { before: 36, after: 36 }, undefined, undefined, undefined])
    expect(pricing.rows.map((row) => row.change)).toEqual([undefined, 1, undefined, undefined, 2, 2, undefined])
    expect(pricing.rows[1]).toMatchObject({
      id: 'cycle-0-1',
      before: 'export const total = (p: number) => Math.round(p * 0.95)',
      after: 'export const total = (p: number) => Math.round(p * 0.9)',
    })
    // Inside a hunk, a line beginning with `---` is source, not a header.
    expect(pricing.rows[5].after).toBe('--- divider')
    expect(staging).toMatchObject({ path: 'e2e/support/staging.ts', repo: '/workspace/features/alpha' })
    expect(staging.rows[0]).toMatchObject({ id: 'cycle-1-0', beforeLine: 5, afterLine: 5, change: 1, gap: { before: 4, after: 4 } })
  })

  it('names added and deleted files and leaves the missing side empty', () => {
    const [added] = cycleReviewFromPatch(ADDED_FILE)
    expect(added).toMatchObject({ path: 'e2e/new.spec.ts', repo: '/workspace/features/beta', change: 'added', blobs: { before: '0000000', after: '7b9a9f9' } })
    expect(added.rows.map((row) => [row.before, row.afterLine])).toEqual([[null, 1], [null, 2]])
    expect(added.rows.every((row) => !row.gap)).toBe(true)
    const [deleted] = cycleReviewFromPatch(DELETED_FILE)
    expect(deleted).toMatchObject({ path: 'e2e/old.spec.ts', change: 'deleted' })
    expect(deleted.rows.map((row) => [row.beforeLine, row.after])).toEqual([[1, null], [2, null]])
  })

  it('keeps a rename with no edits as a file without rows', () => {
    const [pure, edited] = cycleReviewFromPatch(RENAMES)
    expect(pure).toEqual({ path: 'src/b.ts', previousPath: 'src/a.ts', change: 'renamed', lineEnding: 'lf', rows: [] })
    expect(edited).toMatchObject({ path: 'src/d.ts', previousPath: 'src/c.ts', change: 'renamed', blobs: { before: '1111111', after: '2222222' } })
    expect(edited.rows).toHaveLength(1)
  })

  it('shows no rows for a binary file, even when its literal lines look like edits', () => {
    const files = cycleReviewFromPatch(BINARY_FILES)
    expect(files.map((file) => [file.path, file.change, file.rows.length])).toEqual([['assets/logo.png', 'binary', 0], ['assets/icon.png', 'binary', 0]])
  })

  it('records which side ends without a newline', () => {
    const [one, two, three] = cycleReviewFromPatch(NO_NEWLINE_AT_END)
    expect(one.noNewlineAtEnd).toEqual({ before: true, after: false })
    expect(two.noNewlineAtEnd).toEqual({ before: false, after: true })
    expect(three.noNewlineAtEnd).toEqual({ before: true, after: true })
    expect(one.rows).toEqual([{ id: 'cycle-0-0', before: 'export const one = 1', after: 'export const one = 2', beforeLine: 1, afterLine: 1, change: 1 }])
  })

  it('strips carriage returns from row text and says the file used them', () => {
    const [win, mixed] = cycleReviewFromPatch(LINE_ENDINGS)
    expect(win.lineEnding).toBe('crlf')
    expect(win.rows.map((row) => [row.before, row.after])).toEqual([['const a = 1', 'const a = 1'], ['const b = 1', 'const b = 2']])
    expect(mixed.lineEnding).toBe('mixed')
  })

  it('reads a fragment that has no diff --git headers', () => {
    const files = cycleReviewFromPatch(HEADERLESS_FRAGMENT)
    expect(files.map((file) => [file.path, file.change])).toEqual([['src/x.ts', 'modified'], ['src/y.ts', 'added'], ['src/z.ts', 'deleted']])
    expect(files.map((file) => lines(file.rows))).toEqual([[[1, 1]], [[null, 1]], [[1, null]]])
  })

  it('places a zero-count hunk after its start line', () => {
    const [list] = cycleReviewFromPatch(ZERO_COUNT_HUNK)
    expect(lines(list.rows)).toEqual([[null, 4], [null, 5], [10, 12]])
    expect(list.rows.map((row) => row.gap)).toEqual([{ before: 3, after: 3 }, undefined, { before: 6, after: 6 }])
  })

  it('keeps a quoted diff --git header whole, and reads nothing from an empty patch', () => {
    const [quoted] = cycleReviewFromPatch('diff --git "a/odd name.ts" "b/odd name.ts"\n')
    expect(quoted.path).toBe('"a/odd name.ts" "b/odd name.ts"')
    expect(cycleReviewFromPatch('')).toEqual([])
    expect(cycleReviewFromPatch('\n')).toEqual([])
    // Text before any file header has no file to belong to.
    expect(cycleReviewFromPatch('note: captured\n-stray\n')).toEqual([])
  })

  it('never pairs a deletion with an addition listed before it, and ignores notes after a hunk', () => {
    const [file] = cycleReviewFromPatch('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n+new\n-old\n\nnote: captured by hand\n')
    expect(file.rows.map((row) => [row.before, row.after])).toEqual([[null, 'new'], ['old', null]])
  })

  it('stays linear on a large added file', () => {
    const big = ['diff --git a/big.ts b/big.ts', '--- /dev/null', '+++ b/big.ts', '@@ -0,0 +1,2000 @@',
      ...Array.from({ length: 2000 }, (_, i) => `+export const v${i} = ${i}`), ''].join('\n')
    const started = performance.now()
    const [file] = cycleReviewFromPatch(big)
    expect(file.rows).toHaveLength(2000)
    expect(file.rows.at(-1)?.afterLine).toBe(2000)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('cycleFileAlignedInput', () => {
  it('places each patch line at its real line number, so the aligned rows read the hunk numbers', () => {
    const [pricing] = cycleReviewFromPatch(TWO_FILE_CYCLE)
    const { review, rows, labels } = cycleFileAlignedInput(pricing, 2)
    expect(labels).toEqual({ before: 'Before repair cycle 2', after: 'After repair cycle 2' })
    const before = review.before.source.split('\n')
    expect(before).toHaveLength(41)
    expect(before[1]).toBe('export const total = (p: number) => Math.round(p * 0.95)')
    expect(before[10]).toBe('')
    expect(review.after.source.split('\n')[41]).toBe('--- divider')
    expect(review.supportingFile).toBe(true)
    const aligned = alignedTestViewRows({ review, rows, mode: 'code', marks: 'word' })
    expect(aligned.map((pair) => [pair.before?.label, pair.after?.label])).toEqual([
      ['1', '1'], ['2', '2'], ['3', '3'], ['40', '40'], [undefined, '41'], [undefined, '42'], ['41', '43'],
    ])
    expect(aligned.filter((pair) => pair.after?.marks.words).map((pair) => pair.source.id)).toEqual(['cycle-0-1'])
  })
})
