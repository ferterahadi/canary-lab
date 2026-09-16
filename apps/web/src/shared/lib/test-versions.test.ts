import { describe, expect, it } from 'vitest'
import type { FeatureSpecFile } from '../api/types'
import { readableTest } from '../api/__fixtures__/readable-test'
import { compareTestVersions } from './test-versions'

const specs = (root: string, files: Record<string, Array<[string, number]>>): FeatureSpecFile[] => Object.entries(files).map(([file, tests]) => ({
  file: `${root}/${file}`, tests: tests.map(([name, line]) => ({ name, line, bodySource: '', steps: [], readable: readableTest(name) })),
}))

describe('test version identities', () => {
  it('finds additions and deletions even when the total count is unchanged', () => {
    const result = compareTestVersions(specs('/source', { 'e2e/a.spec.ts': [['kept', 30], ['new', 40]] }),
      specs('/recorded', { 'e2e/a.spec.ts': [['kept', 3], ['old', 10]] }), ['/source', '/recorded'], [])
    expect(result.added).toEqual([{ file: 'e2e/a.spec.ts', name: 'new', line: 40 }])
    expect(result.removed).toEqual([{ file: 'e2e/a.spec.ts', name: 'old', line: 10 }])
    expect(result.changed).toEqual([])
  })

  it('does not collapse repeated titles or match names across files', () => {
    const result = compareTestVersions(specs('/source', { 'a.spec.ts': [['same', 1], ['same', 20]], 'b.spec.ts': [['same', 1]] }),
      specs('/recorded', { 'a.spec.ts': [['same', 10]], 'c.spec.ts': [['same', 1]] }), ['/source', '/recorded'], [])
    expect(result.added.map((test) => [test.file, test.line])).toEqual([['a.spec.ts', 20], ['b.spec.ts', 1]])
    expect(result.removed.map((test) => test.file)).toEqual(['c.spec.ts'])
  })

  it('separates new declarations from existing tests affected by edits', () => {
    const result = compareTestVersions(specs('/source', { 'a.spec.ts': [['edited', 15], ['new', 30]], 'b.spec.ts': [['edited', 1]] }),
      specs('/recorded', { 'a.spec.ts': [['edited', 1]], 'b.spec.ts': [['edited', 1]] }), ['/source', '/recorded'],
      [{ file: 'a.spec.ts', affectedTests: ['edited', 'new'] }])
    expect(result.changed).toEqual([{ file: 'a.spec.ts', name: 'edited', line: 15 }])
    expect(result.added).toEqual([{ file: 'a.spec.ts', name: 'new', line: 30 }])
    expect(result.removed).toEqual([])
  })
})
