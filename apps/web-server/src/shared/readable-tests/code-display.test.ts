import { describe, expect, it } from 'vitest'
import type { ExtractedTest } from '../../../../../shared/extracted-test'
import { codeDisplayAttacher } from './code-display'

function test(overrides: Partial<ExtractedTest>): ExtractedTest {
  return { name: 't', line: 3, bodySource: '{\n  await page.goto("/")\n}', steps: [], readable: {} as ExtractedTest['readable'], ...overrides }
}

describe('codeDisplayAttacher', () => {
  it('leaves a test with no body alone', () => {
    const empty = test({ bodySource: '' })
    expect(codeDisplayAttacher()(empty)).toBe(empty)
  })

  it('numbers the listing from the body line, or the test line when there is none', () => {
    const attach = codeDisplayAttacher()
    expect(attach(test({ bodyLine: 5 })).codeDisplay!.lineMap.map((line) => line.sourceLine)).toEqual([5, 6, 7])
    expect(attach(test({})).codeDisplay!.lineMap.map((line) => line.sourceLine)).toEqual([3, 4, 5])
  })

  it('formats a body shared by several tests once', () => {
    const attach = codeDisplayAttacher()
    const first = attach(test({ name: 'a' }))
    const second = attach(test({ name: 'b' }))
    expect(second.codeDisplay).toBe(first.codeDisplay)
  })
})
