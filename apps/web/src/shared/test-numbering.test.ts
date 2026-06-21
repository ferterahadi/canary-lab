import { describe, it, expect } from 'vitest'
import { buildTestNumbering, parseLocation, stripLeadingTestOrdinal, testNumberKey } from './test-numbering'

describe('buildTestNumbering', () => {
  it('assigns 1-based ids by (file, line) source order', () => {
    const map = buildTestNumbering([
      { file: 'e2e/b.spec.ts', line: 10 },
      { file: 'e2e/a.spec.ts', line: 30 },
      { file: 'e2e/a.spec.ts', line: 5 },
    ])
    expect(map.get(testNumberKey('e2e/a.spec.ts', 5))).toBe(1)
    expect(map.get(testNumberKey('e2e/a.spec.ts', 30))).toBe(2)
    expect(map.get(testNumberKey('e2e/b.spec.ts', 10))).toBe(3)
  })

  it('is order-independent: the same test gets the same id regardless of input order', () => {
    const items = [
      { file: 'e2e/a.spec.ts', line: 5 },
      { file: 'e2e/a.spec.ts', line: 30 },
      { file: 'e2e/b.spec.ts', line: 10 },
    ]
    const forward = buildTestNumbering(items)
    const reversed = buildTestNumbering([...items].reverse())
    for (const it of items) {
      expect(reversed.get(testNumberKey(it.file, it.line)))
        .toBe(forward.get(testNumberKey(it.file, it.line)))
    }
  })

  it('a view holding only a subset still resolves canonical ids via lookup miss', () => {
    const full = buildTestNumbering([
      { file: 'e2e/a.spec.ts', line: 5 },
      { file: 'e2e/a.spec.ts', line: 30 },
      { file: 'e2e/b.spec.ts', line: 10 },
    ])
    // #2 is the same test whether or not #1 ran.
    expect(full.get(testNumberKey('e2e/a.spec.ts', 30))).toBe(2)
  })

  it('de-duplicates repeated (file, line) pairs', () => {
    const map = buildTestNumbering([
      { file: 'e2e/a.spec.ts', line: 5 },
      { file: 'e2e/a.spec.ts', line: 5 },
      { file: 'e2e/a.spec.ts', line: 9 },
    ])
    expect(map.size).toBe(2)
    expect(map.get(testNumberKey('e2e/a.spec.ts', 5))).toBe(1)
    expect(map.get(testNumberKey('e2e/a.spec.ts', 9))).toBe(2)
  })

  it('tolerates missing file/line', () => {
    const map = buildTestNumbering([{}, { line: 4 }])
    expect(map.get(testNumberKey('', 0))).toBe(1)
    expect(map.get(testNumberKey('', 4))).toBe(2)
  })
})

describe('parseLocation', () => {
  it('parses file:line', () => {
    expect(parseLocation('e2e/foo.spec.ts:34')).toEqual({ file: 'e2e/foo.spec.ts', line: 34 })
  })
  it('parses file:line:col', () => {
    expect(parseLocation('e2e/foo.spec.ts:34:5')).toEqual({ file: 'e2e/foo.spec.ts', line: 34 })
  })
  it('returns null for undefined', () => {
    expect(parseLocation(undefined)).toBeNull()
  })
  it('falls back to line 0 when there is no line', () => {
    expect(parseLocation('e2e/foo.spec.ts')).toEqual({ file: 'e2e/foo.spec.ts', line: 0 })
  })
})

describe('stripLeadingTestOrdinal', () => {
  it('strips a leading "N. " ordinal', () => {
    expect(stripLeadingTestOrdinal('1. gateway is healthy')).toBe('gateway is healthy')
  })
  it('strips a leading "N) " ordinal', () => {
    expect(stripLeadingTestOrdinal('12) does a thing')).toBe('does a thing')
  })
  it('leaves an unnumbered title untouched', () => {
    expect(stripLeadingTestOrdinal('approve → token issued')).toBe('approve → token issued')
  })
  it('does not strip a number that is part of the sentence', () => {
    expect(stripLeadingTestOrdinal('R1/R2/R3 env labels')).toBe('R1/R2/R3 env labels')
  })
  it('does not strip a decimal-looking prefix without a separator space', () => {
    expect(stripLeadingTestOrdinal('3.14 is pi')).toBe('3.14 is pi')
  })
})
