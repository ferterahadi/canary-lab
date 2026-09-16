import { expect, it } from 'vitest'
import { suiteRelativeFile } from './test-versions'

it('normalizes source and snapshot paths without matching unrelated prefixes', () => {
  expect(suiteRelativeFile('/source/e2e/a.spec.ts', '/source', '/recorded')).toBe('e2e/a.spec.ts')
  expect(suiteRelativeFile('/recorded/e2e/a.spec.ts', '/source', '/recorded')).toBe('e2e/a.spec.ts')
  expect(suiteRelativeFile('/source-other/a.spec.ts', '/source')).toBe('/source-other/a.spec.ts')
  expect(suiteRelativeFile('e2e/a.spec.ts', undefined)).toBe('e2e/a.spec.ts')
})
