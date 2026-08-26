import { describe, expect, it } from 'vitest'
import {
  READABLE_TEST_FIXTURE_CATEGORIES,
  READABLE_TEST_FIXTURES,
} from './__fixtures__/readable-test-fixtures'

describe('readable test fixture matrix', () => {
  it('covers both source languages and every required behavior category', () => {
    expect(new Set(READABLE_TEST_FIXTURES.map((fixture) => fixture.language))).toEqual(
      new Set(['javascript', 'typescript']),
    )
    expect(new Set(READABLE_TEST_FIXTURES.flatMap((fixture) => fixture.categories))).toEqual(
      new Set(READABLE_TEST_FIXTURE_CATEGORIES),
    )
  })

  it('keeps fixture identities and source entry points unambiguous', () => {
    const ids = READABLE_TEST_FIXTURES.map((fixture) => fixture.id)
    const files = READABLE_TEST_FIXTURES.map((fixture) => fixture.file)

    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(files).size).toBe(files.length)
    for (const fixture of READABLE_TEST_FIXTURES) {
      expect(fixture.source).toContain(`test('${fixture.testName}'`)
    }
  })

  it('keeps every control-flow form in the load-bearing fixture', () => {
    const source = READABLE_TEST_FIXTURES.find((fixture) => fixture.id === 'typescript-control-flow')?.source

    expect(source).toContain('if (')
    expect(source).toContain('switch (')
    expect(source).toContain('for (let attempt')
    expect(source).toContain('for (const item of items)')
    expect(source).toContain('for await (const event of stream)')
    expect(source).toContain('while (')
    expect(source).toContain('do {')
    expect(source).toContain('break')
    expect(source).toContain('continue')
  })
})
