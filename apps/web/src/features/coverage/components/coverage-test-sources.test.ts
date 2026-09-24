import { describe, expect, it } from 'vitest'
import type { FeatureTests, TestCoverage } from '@/shared/api/types'
import { readableTest } from '@/shared/api/__fixtures__/readable-test'
import { coverageTestSources } from './coverage-test-sources'

const declaration: TestCoverage = {
  name: '${channel}: empty scope', file: 'e2e/conversations.spec.ts', line: 75,
  requirements: ['R1'], pathTypes: ['happy'],
}
const spec = (file: string, names: string[]): FeatureTests[number] => ({
  file,
  tests: names.map((name) => ({ name, line: 75, bodySource: '{}', steps: [], readable: readableTest(name, []) })),
})

describe('coverageTestSources', () => {
  it('keeps all generated cases and excludes a same-basename spec in another directory', () => {
    const specs = [
      spec('/repo/e2e/conversations.spec.ts', ['whatsapp: empty scope', 'line: empty scope']),
      spec('/repo/other/conversations.spec.ts', ['unrelated']),
    ]
    expect(coverageTestSources(specs, declaration).map(({ test }) => test.name))
      .toEqual(['whatsapp: empty scope', 'line: empty scope'])
  })

  it('uses an exact title when multiple literal declarations share a source line', () => {
    expect(coverageTestSources([spec('/repo/e2e/conversations.spec.ts', ['first', 'second'])], {
      ...declaration, name: 'second',
    }).map(({ test }) => test.name)).toEqual(['second'])
  })

  it('matches helper origins and normalizes Windows paths', () => {
    const wrapper = spec('/repo/e2e/wrapper.spec.ts', ['whatsapp: empty scope'])
    wrapper.tests[0].sourceFile = 'C:\\repo\\helpers\\conversations.ts'
    expect(coverageTestSources([wrapper], { ...declaration, file: 'helpers/conversations.ts' })[0].absFile)
      .toBe(wrapper.tests[0].sourceFile)
  })

  it('recovers a moved declaration only when its name is unambiguous', () => {
    const first = spec('/repo/e2e/first.spec.ts', ['moved'])
    const second = spec('/repo/e2e/second.spec.ts', ['moved'])
    expect(coverageTestSources([first], { ...declaration, name: 'moved', line: 1 })).toHaveLength(1)
    expect(coverageTestSources([first, second], { ...declaration, name: 'moved', line: 1 })).toEqual([])
    expect(coverageTestSources([first], declaration)).toEqual([])
  })
})
