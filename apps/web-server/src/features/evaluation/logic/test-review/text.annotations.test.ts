import { expect, it } from 'vitest'
import { annotationCases } from '../../../../../../../shared/__fixtures__/test-annotations'
import { splitAnnotations } from './text'

it.each(annotationCases)('keeps report annotation policy: $source', ({ source, title, tags }) => {
  expect(splitAnnotations(source)).toEqual({ text: title, tags: [...new Set(tags)] })
})

it('retains generic report annotations', () => {
  expect(splitAnnotations('@owner-team @req-R1 checkout')).toEqual({ text: 'checkout', tags: ['@owner-team', '@req-R1'] })
})
