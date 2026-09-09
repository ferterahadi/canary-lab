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
  expect(lines.get(4)).toMatchObject([{ depth: 0, step: { text: 'If enabled' } }]); expect(lines.get(5)).toMatchObject([{ depth: 1, step: { text: 'Expect the value to be 2' } }])
  expect(lines.get(6)).toBeNull(); expect(lines.has(7)).toBe(false)
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

it('retains both condition and then when the shared English story maps them to the same source line', () => {
  const review = testFileReview()
  const source = { file: review.file, startLine: 4, endLine: 6, snippet: '' }
  review.after.tests[0].readable.story = { steps: [{ id: 'if', kind: 'flow', role: 'setup', flowKind: 'condition', text: 'If enabled', spans: [], fidelity: 'exact', source, children: [{ id: 'then', kind: 'flow', role: 'setup', flowKind: 'then', text: 'When true', spans: [], fidelity: 'exact', source, children: [] }] }] }
  expect(englishLines(review.after).get(4)?.map(({ step }) => step.id)).toEqual(['if', 'then'])
})

it('keeps code fallback for missing stories and helper steps outside the reviewed tests', () => {
  const review = testFileReview()
  delete review.after.tests[0].readable.story
  expect(englishLines(review.after).size).toBe(0)
  review.after.tests[0].readable.story = { steps: [{ id: 'helper', role: 'setup', text: 'Helper setup', spans: [], fidelity: 'exact', source: { file: 'helper.ts', startLine: 90, endLine: 91, snippet: '' } }] }
  expect(englishLines(review.after).size).toBe(0)
})

it('does not erase a translated step when a later story item spans its source line', () => {
  const review = testFileReview()
  const step = { id: 'check', role: 'check' as const, text: 'Check value', spans: [], fidelity: 'exact' as const, source: { file: review.file, startLine: 5, endLine: 5, snippet: '' } }
  review.after.tests[0].readable.story = { steps: [step, { ...step, id: 'setup', source: { ...step.source, startLine: 4, endLine: 6 } }] }
  expect(englishLines(review.after).get(5)?.[0].step.id).toBe('check')
  expect(englishLines(review.after).get(6)).toBeNull()
})

it('limits an unmatched predicate to its reported first line instead of assigning the rest of the file', () => {
  const review = testFileReview()
  const change = review.assessment.tests[0].changes[0]
  change.before = { line: 5, source: 'expect(transformed).toBe(1)', reason: 'source spelling differs' }
  delete change.after
  expect(assessmentsForRows(review, [{ id: 'first', before: 'assertion', after: null, beforeLine: 5 }])).toEqual([change])
  expect(assessmentsForRows(review, [{ id: 'later', before: 'unrelated setup', after: null, beforeLine: 6 }])).toEqual([])
})
