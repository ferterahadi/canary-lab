import { expect, it } from 'vitest'
import { tokenizeTestAnnotations } from './test-annotations'
import { annotationCases } from './__fixtures__/test-annotations'

it.each(annotationCases)('retains complete tokens: $source', ({ source, title, tags }) => {
  const parsed = tokenizeTestAnnotations(source)
  expect(parsed.title).toBe(title)
  expect(parsed.tokens.map((token) => token.raw)).toEqual(tags)
  for (const token of parsed.tokens) expect(`@${token.kind}-${token.value}`).toBe(token.raw)
})

it('leaves unsupported kinds in prose without broadening the consumer vocabulary', () => {
  expect(tokenizeTestAnnotations('@owner-team @req-R1 checkout', ['req'])).toEqual({ title: '@owner-team checkout', tokens: [{ raw: '@req-R1', kind: 'req', value: 'R1' }] })
})
