import { expect, it } from 'vitest'
import { testFileReview } from '../api/__fixtures__/test-review'
import { assessmentsForRows, englishLines, rowsForTest, sourceRows, testSelections } from './test-review-model'
it('keeps unchanged context, source line numbers and contiguous change groups', () => {
  const review = testFileReview(); const rows = sourceRows(review)
  expect(rows).toHaveLength(8)
  expect(rows[4]).toMatchObject({ beforeLine: 5, afterLine: 5, change: 1 })
  expect(rows[6].change).toBe(2)
  const context = rowsForTest(rows, testSelections(review, rows)[0], review)
  expect(context).toHaveLength(6)
  expect(context[0].after).toContain("test('a'")
  expect(context.at(-1)?.after).toBe('})')
  expect(assessmentsForRows(review, [rows[4]])[0].verdict).toBe('unclassifiable')
  expect(assessmentsForRows(review, [rows[0]])).toEqual([])
})
it('never drops tests sharing a name and retains removed tests as source contexts', () => {
  const review = testFileReview()
  review.after.tests.push({ ...review.after.tests[0], line: 9, endLine: 10 })
  review.before.tests.push({ ...review.before.tests[0], name: 'removed', line: 11, endLine: 12 })
  const rows = sourceRows(review)
  rows.push({ id: 'removed', before: "test('removed')", after: null, beforeLine: 11, change: 3 })
  const choices = testSelections(review, rows)
  expect(choices.map((item) => item.key)).toEqual(['after:3', 'after:9', 'before:11'])
  expect(rowsForTest(rows, choices[2], review)).toEqual([rows.at(-1)])
})
it('keeps both sides of a rename plus assertion edit together using source boundaries', () => {
  const review = testFileReview(); review.before.tests[0].name = 'old name'
  const rows = sourceRows(review)
  expect(testSelections(review, rows)).toHaveLength(1)
  expect(rowsForTest(rows, testSelections(review, rows)[0], review)).toHaveLength(6)
})
it('preserves complete source when unchanged or viewing full file', () => {
  const review = testFileReview(); review.before = review.after; review.patch = ''
  const rows = sourceRows(review)
  expect(rows.every((row) => row.change == null)).toBe(true)
  expect(rowsForTest(rows, undefined, review)).toBe(rows)
})
it('projects the existing English story in source order and retains code fallback outside translated ranges', () => {
  const review = testFileReview()
  review.after.tests[0].readable.story = { steps: [{ id: 'branch', kind: 'flow', role: 'setup', flowKind: 'condition', text: 'If enabled', spans: [], fidelity: 'exact', source: { file: review.file, startLine: 4, endLine: 8, snippet: '' }, children: [{ id: 'check', role: 'check', text: 'Expect the value to be 2', spans: [], fidelity: 'exact', source: { file: review.file, startLine: 5, endLine: 6, snippet: '' } }] }] }
  const lines = englishLines(review.after)
  expect(lines.get(4)).toBe('If enabled'); expect(lines.get(5)).toBe('  Expect the value to be 2')
  expect(lines.get(6)).toBe(''); expect(lines.has(7)).toBe(false)
})

it('finds an assessment when the edit is inside a multiline assertion rather than on its first line', () => {
  const review = testFileReview()
  review.before.source = 'expect(body).toEqual({\n  count: 1\n})'
  review.after.source = 'expect(body).toEqual({\n  count: 2\n})'
  const change = review.assessment.tests[0].changes[0]
  change.before = { line: 1, source: 'expect(body).toEqual({ count: 1 })', reason: 'value' }
  change.after = { line: 1, source: 'expect(body).toEqual({ count: 2 })', reason: 'value' }
  expect(assessmentsForRows(review, [{ id: 'inner', before: 'count: 1', after: 'count: 2', beforeLine: 2, afterLine: 2 }])).toEqual([change])
})
