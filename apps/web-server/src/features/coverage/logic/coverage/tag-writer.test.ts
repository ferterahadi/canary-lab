import { describe, it, expect } from 'vitest'
import { writeCoversTag, writeCoversTags, coversTagTokens, stripCoverageTags } from './tag-writer'
import { extractTestsFromSource } from '../../../config/logic/ast-extractor'

describe('coversTagTokens', () => {
  it('renders requirement + path tokens', () => {
    expect(coversTagTokens({ requirements: ['R1', 'R2'], pathTypes: ['happy', 'sad'] })).toEqual([
      '@req-R1', '@req-R2', '@path-happy', '@path-sad',
    ])
  })
})

describe('writeCoversTag', () => {
  it('inserts a details object on a 2-arg test', () => {
    const src = `test('creates a todo', async () => { expect(1).toBe(1) })`
    const out = writeCoversTag(src, 'creates a todo', { requirements: ['R1'], pathTypes: ['happy'] })
    expect(out).toContain("{ tag: ['@req-R1', '@path-happy'] }")
    // The body must be untouched and still parse to the same test.
    const tests = extractTestsFromSource('a.spec.ts', out).tests
    expect(tests[0].requirements).toEqual(['R1'])
    expect(tests[0].pathTypes).toEqual(['happy'])
    expect(tests[0].bodySource).toContain('expect(1).toBe(1)')
  })

  it('merges into an existing tag array without duplicating', () => {
    const src = `test('t', { tag: ['@req-R1'] }, async () => {})`
    const out = writeCoversTag(src, 't', { requirements: ['R1', 'R2'] })
    expect(out).toContain("['@req-R1', '@req-R2']")
    expect(out.match(/@req-R1/g)).toHaveLength(1) // not duplicated
  })

  it('upgrades a string tag to an array when merging', () => {
    const src = `test('t', { tag: '@smoke' }, async () => {})`
    const out = writeCoversTag(src, 't', { requirements: ['R3'] })
    expect(out).toContain("['@smoke', '@req-R3']")
  })

  it('adds a tag property to a details object that lacks one', () => {
    const src = `test('t', { annotation: { type: 'issue' } }, async () => {})`
    const out = writeCoversTag(src, 't', { requirements: ['R4'] })
    const tests = extractTestsFromSource('a.spec.ts', out).tests
    expect(tests[0].requirements).toEqual(['R4'])
  })

  it('is idempotent when the tag is already present', () => {
    const src = `test('t', { tag: ['@req-R1'] }, async () => {})`
    expect(writeCoversTag(src, 't', { requirements: ['R1'] })).toBe(src)
  })

  it('returns source unchanged when the test is absent', () => {
    const src = `test('other', async () => {})`
    expect(writeCoversTag(src, 'missing', { requirements: ['R1'] })).toBe(src)
  })

  it('only touches the named test, not its siblings', () => {
    const src = [
      `test('first', async () => {})`,
      `test('second', async () => {})`,
    ].join('\n')
    const out = writeCoversTag(src, 'second', { requirements: ['R2'] })
    const tests = extractTestsFromSource('a.spec.ts', out).tests
    expect(tests[0].requirements).toBeUndefined()
    expect(tests[1].requirements).toEqual(['R2'])
  })
})

describe('writeCoversTags (batch)', () => {
  it('applies several non-overlapping mappings in one pass', () => {
    const src = [
      `test('a', async () => {})`,
      `test('b', async () => {})`,
    ].join('\n')
    const out = writeCoversTags(src, [
      { testName: 'a', tag: { requirements: ['R1'] } },
      { testName: 'b', tag: { requirements: ['R2'], pathTypes: ['sad'] } },
    ])
    const tests = extractTestsFromSource('a.spec.ts', out).tests
    expect(tests[0].requirements).toEqual(['R1'])
    expect(tests[1].requirements).toEqual(['R2'])
    expect(tests[1].pathTypes).toEqual(['sad'])
  })
})

describe('writeCoversTag — branch coverage', () => {
  it('does NOT tag test.step calls (isTestCall returns false for step)', () => {
    const src = `test.step('creates a todo', async () => {})`
    expect(writeCoversTag(src, 'creates a todo', { requirements: ['R1'] })).toBe(src)
  })

  it('does NOT tag test.describe itself, but DOES tag inner test()', () => {
    const src = [
      `test.describe('suite', () => {`,
      `  test('creates a todo', async () => {})`,
      `})`,
    ].join('\n')
    const out = writeCoversTag(src, 'creates a todo', { requirements: ['R1'] })
    expect(out).toContain("tag: ['@req-R1']")
    // test.describe line should not have acquired a tag object itself
    expect(out).not.toMatch(/test\.describe\([^)]*tag/)
  })

  it('DOES tag test.only calls (not step/describe, so isTestCall returns true)', () => {
    const src = `test.only('creates a todo', async () => {})`
    const out = writeCoversTag(src, 'creates a todo', { requirements: ['R1'] })
    expect(out).toContain("tag: ['@req-R1']")
  })

  it('returns source unchanged when first arg is a non-string-literal (getStringArg returns null)', () => {
    // `name` is an Identifier, not a StringLiteral — getStringArg returns null
    const src = `const name = 'creates a todo'; test(name, async () => {})`
    expect(writeCoversTag(src, 'creates a todo', { requirements: ['R1'] })).toBe(src)
  })

  it('getCalleeChain handles nested property access (e.g. test.only)', () => {
    // Indirectly tested via DOES tag test.only — this confirms the chain is
    // ['test', 'only'], which passes isTestCall.
    const src = `test.only('my test', async () => {})`
    const out = writeCoversTag(src, 'my test', { requirements: ['R5'] })
    expect(out).toContain('@req-R5')
  })

  it('getCalleeChain returns [] when base is a call expression, not an identifier/property (line 36 branch)', () => {
    // fn().step('my test', ...) → PropertyAccessExpression where expression is
    // a CallExpression. getCalleeChain(callExpr) returns [] → `if (head.length === 0) return []`.
    // isTestCall then sees chain.length === 0 → returns false → no tag written.
    const src = `getFixture().step('my test', async () => {})`
    expect(writeCoversTag(src, 'my test', { requirements: ['R1'] })).toBe(src)
  })

  it('merges into a details object whose tag property is a string-literal key (line 118 branch)', () => {
    // Property name is a quoted string literal `'tag'` — hits ts.isStringLiteralLike(p.name).
    const src = `test('t', { 'tag': '@smoke' }, async () => {})`
    const out = writeCoversTag(src, 't', { requirements: ['R6'] })
    expect(out).toContain('@req-R6')
    expect(out).toContain('@smoke')
  })

  it('skips non-string-literal elements in the existing tag array (line 136-137 branch)', () => {
    // Array contains an identifier — ts.isStringLiteralLike(el) is false for it,
    // so it is skipped (not added to `existing`). The new token is still appended.
    const src = `test('t', { tag: [someVar, '@smoke'] }, async () => {})`
    const out = writeCoversTag(src, 't', { requirements: ['R7'] })
    // @smoke was in existing; @req-R7 is new → merged array contains both.
    expect(out).toContain('@req-R7')
    expect(out).toContain('@smoke')
  })
})

describe('writeCoversTag — remaining branch coverage', () => {
  // line 72: planTagEdit returns null immediately when coversTagTokens is empty
  it('returns source unchanged when tag has no requirements and no pathTypes', () => {
    const src = `test('t', async () => {})`
    expect(writeCoversTag(src, 't', { requirements: [] })).toBe(src)
  })

  // line 101: planInsertDetail — test call has no arguments (title is undefined)
  it('returns source unchanged for a test() call with no arguments', () => {
    const src = `test()`
    expect(writeCoversTag(src, '', { requirements: ['R1'] })).toBe(src)
  })

  // line 136: false branch of isArrayLiteralExpression — tag value is neither string
  // literal nor array (e.g. a call expression) → existing stays empty, new token added
  it('handles a tag value that is neither string literal nor array (call expression)', () => {
    // tag: getMyTags() — value is a CallExpression, not string literal, not array
    const src = `test('t', { tag: getMyTags() }, async () => {})`
    const out = writeCoversTag(src, 't', { requirements: ['R8'] })
    expect(out).toContain('@req-R8')
  })
})

describe('stripCoverageTags', () => {
  it('removes the details object when @req/@path were the only tags', () => {
    const src = `test('t', { tag: ['@req-R1', '@path-happy'] }, async () => { expect(1).toBe(1) })`
    const out = stripCoverageTags(src)
    expect(out).toBe(`test('t', async () => { expect(1).toBe(1) })`)
    // Reparses cleanly with no coverage linkage.
    const tests = extractTestsFromSource('a.spec.ts', out).tests
    expect(tests[0].requirements).toBeUndefined()
    expect(tests[0].pathTypes).toBeUndefined()
  })

  it('preserves non-coverage tags, dropping only @req/@path tokens', () => {
    const src = `test('t', { tag: ['@req-R1', '@smoke', '@path-sad'] }, async () => {})`
    const out = stripCoverageTags(src)
    expect(out).toContain("['@smoke']")
    expect(out).not.toContain('@req-R1')
    expect(out).not.toContain('@path-sad')
  })

  it('drops only the tag property when the details object has other props', () => {
    const src = `test('t', { tag: ['@req-R1'], timeout: 1000 }, async () => {})`
    const out = stripCoverageTags(src)
    expect(out).not.toContain('@req-R1')
    expect(out).toContain('timeout: 1000')
    // Still a valid 3-arg test with a details object.
    expect(extractTestsFromSource('a.spec.ts', out).tests).toHaveLength(1)
  })

  it('is idempotent — source with no coverage tags is returned unchanged', () => {
    const src = `test('t', { tag: ['@smoke'] }, async () => {})`
    expect(stripCoverageTags(src)).toBe(src)
    const plain = `test('t', async () => {})`
    expect(stripCoverageTags(plain)).toBe(plain)
  })

  it('strips across multiple tests in one pass', () => {
    const src = [
      `test('a', { tag: ['@req-R1'] }, async () => {})`,
      `test('b', { tag: ['@req-R2', '@smoke'] }, async () => {})`,
      `test('c', async () => {})`,
    ].join('\n')
    const out = stripCoverageTags(src)
    expect(out).not.toContain('@req-R1')
    expect(out).not.toContain('@req-R2')
    expect(out).toContain('@smoke')
    const tests = extractTestsFromSource('a.spec.ts', out).tests
    expect(tests.map((t) => t.requirements)).toEqual([undefined, undefined, undefined])
  })

  it('round-trips with writeCoversTag (write then strip returns to original)', () => {
    const original = `test('creates a todo', async () => { expect(1).toBe(1) })`
    const tagged = writeCoversTag(original, 'creates a todo', { requirements: ['R1'], pathTypes: ['happy'] })
    expect(tagged).not.toBe(original)
    expect(stripCoverageTags(tagged)).toBe(original)
  })
})

describe('writeCoversTags — no-op mapping branch (line 169)', () => {
  it('skips a mapping whose test is already fully tagged (planTagEdit returns null)', () => {
    // 'a' is already tagged with @req-R1 → planTagEdit returns null → edit not pushed.
    // 'b' is untagged → edit IS pushed. Checks the if (edit) false branch at line 169.
    const src = [
      `test('a', { tag: ['@req-R1'] }, async () => {})`,
      `test('b', async () => {})`,
    ].join('\n')
    const out = writeCoversTags(src, [
      { testName: 'a', tag: { requirements: ['R1'] } },  // no-op — already tagged
      { testName: 'b', tag: { requirements: ['R2'] } },  // adds tag
    ])
    expect(out).toContain('@req-R2')
    // 'a' must be unchanged (no duplication)
    expect(out.match(/@req-R1/g)).toHaveLength(1)
  })
})
