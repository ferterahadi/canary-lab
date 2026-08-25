import { describe, it, expect } from 'vitest'

import { extractTestsFromSource, parseTestAnnotations, parseTestTagList } from './ast-extractor'

describe('extractTestsFromSource — coverage annotations', () => {
  it('attaches requirements + pathTypes from a // block above the test', () => {
    const src = `
      import { test } from '@playwright/test'
      // @requirement R1
      // @path happy, sad
      test('login works', async () => { expect(1).toBe(1) })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toEqual(['R1'])
    expect(r.tests[0].pathTypes).toEqual(['happy', 'sad'])
  })

  it('supports a /* */ block annotation', () => {
    const src = `
      /* @requirement R3
         @path edge */
      test('boundary', async () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toEqual(['R3'])
    expect(r.tests[0].pathTypes).toEqual(['edge'])
  })

  it('multiple requirements on one test', () => {
    const src = `
      // @requirement R1
      // @requirement R2
      test('cross-cutting', async () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toEqual(['R1', 'R2'])
  })

  it('leaves fields undefined for an un-annotated test', () => {
    const src = `test('plain', async () => {})`
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toBeUndefined()
    expect(r.tests[0].pathTypes).toBeUndefined()
    expect(r.tests[0].assertions).toBeUndefined()
  })

  it('collects expect() matcher chains and navigation/network/db/file calls', () => {
    const src = `
      test('send', async () => {
        await page.goto('https://line.com/inbox')
        await expect(page.locator('.msg')).toBeVisible()
        const row = await prisma.message.findFirst({ where: { id } })
        const log = fs.readFileSync('app.log', 'utf-8')
        expect(total).toBe(1)
      })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    const asserts = r.tests[0].assertions ?? []
    expect(asserts.some((a) => a.includes("page.goto('https://line.com/inbox')"))).toBe(true)
    expect(asserts.some((a) => a.includes('expect(page.locator') && a.includes('toBeVisible'))).toBe(true)
    expect(asserts.some((a) => a.includes('prisma.message.findFirst'))).toBe(true)
    expect(asserts.some((a) => a.includes("fs.readFileSync('app.log'"))).toBe(true)
    expect(asserts.some((a) => a.includes('expect(total).toBe(1)'))).toBe(true)
  })

  it('does not bleed annotations from one test onto the next', () => {
    const src = `
      // @requirement R1
      test('annotated', async () => {})
      test('bare', async () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toEqual(['R1'])
    expect(r.tests[1].requirements).toBeUndefined()
  })
})

describe('parseTestTagList', () => {
  it('maps @req-<id> tags to requirements (deduped, order preserved)', () => {
    expect(parseTestTagList(['@req-R2', '@req-R1', '@req-R2']).requirements).toEqual(['R2', 'R1'])
  })

  it('maps @path-<type> tags to canonically-ordered path types', () => {
    expect(parseTestTagList(['@path-sad', '@path-happy']).pathTypes).toEqual(['happy', 'sad'])
  })

  it('preserves hyphenated requirement ids after the @req- prefix', () => {
    expect(parseTestTagList(['@req-CHK-3']).requirements).toEqual(['CHK-3'])
  })

  it('ignores unrelated tags and invalid path types', () => {
    const out = parseTestTagList(['@smoke', '@path-bogus', '@req-R1'])
    expect(out.requirements).toEqual(['R1'])
    expect(out.pathTypes).toBeUndefined()
  })

  it('returns undefined fields when no coverage tags are present', () => {
    expect(parseTestTagList(['@smoke', '@slow'])).toEqual({
      requirements: undefined,
      pathTypes: undefined,
    })
  })

  it('maps @variant-<value> tags to lower-cased, deduped variants (D1)', () => {
    expect(parseTestTagList(['@variant-email', '@variant-WhatsApp', '@variant-email']).variants).toEqual([
      'email', 'whatsapp',
    ])
  })

  it('coexists with req + path tags', () => {
    const out = parseTestTagList(['@req-R6', '@path-sad', '@variant-line'])
    expect(out.requirements).toEqual(['R6'])
    expect(out.pathTypes).toEqual(['sad'])
    expect(out.variants).toEqual(['line'])
  })
})

describe('extractTestsFromSource — Playwright tag linkage (R1)', () => {
  it('reads requirements + paths from an array tag on the details object', () => {
    const src = `
      test('tagged', { tag: ['@req-R3', '@path-happy', '@path-edge'] }, async () => {
        expect(1).toBe(1)
      })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toEqual(['R3'])
    expect(r.tests[0].pathTypes).toEqual(['happy', 'edge'])
  })

  it('reads @variant tags onto the extracted test (D1)', () => {
    const src = `
      test('tagged', { tag: ['@req-R6', '@path-happy', '@variant-email'] }, async () => {
        expect(1).toBe(1)
      })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].variants).toEqual(['email'])
  })

  it('reads a single string tag', () => {
    const src = `test('one', { tag: '@req-R5' }, async () => {})`
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toEqual(['R5'])
  })

  it('extracts body steps + assertions through the 3-arg details form', () => {
    // Regression: the body is arguments[2] when a details object is present, so
    // the body finder must scan past the object literal.
    const src = `
      test('with details', { tag: ['@req-R1'] }, async () => {
        await test.step('go', async () => { await page.goto('https://line.com') })
        await expect(page.locator('.ok')).toBeVisible()
      })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].steps.map((s) => s.label)).toEqual(['go'])
    expect((r.tests[0].assertions ?? []).some((a) => a.includes('toBeVisible'))).toBe(true)
    expect((r.tests[0].assertions ?? []).some((a) => a.includes("page.goto('https://line.com')"))).toBe(true)
  })

  it('unions Playwright tags with comment annotations (migration fallback)', () => {
    const src = `
      // @requirement R9
      // @path sad
      test('mixed', { tag: ['@req-R1', '@path-happy'] }, async () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toEqual(['R1', 'R9'])
    expect(r.tests[0].pathTypes).toEqual(['happy', 'sad'])
  })

  it('returns empty annotations when the details object has no tag/tags property (line 202 branch)', () => {
    // The details object has `annotation` but no `tag`/`tags` key — the loop
    // hits `if (key !== 'tag' && key !== 'tags') continue` for every property
    // and falls through to `return {}` (line 202).
    const src = `test('no tag', { annotation: { type: 'issue', description: 'abc' } }, async () => {})`
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toBeUndefined()
    expect(r.tests[0].pathTypes).toBeUndefined()
  })

  it('skips non-PropertyAssignment nodes in details object (line 197 continue branch)', () => {
    // A spread element ({ ...base }) produces a SpreadAssignment, not a PropertyAssignment.
    // The loop hits `if (!ts.isPropertyAssignment(prop)) continue` and skips it.
    const src = `
      const base = {}
      test('spread', { ...base }, async () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toBeUndefined()
  })

  it('ignores non-string array elements in tag value (line 183 FALSE branch)', () => {
    // readTagPropertyStrings: when the tag value is an array containing a non-string element,
    // `if (ts.isStringLiteralLike(el))` is false for that element and it is skipped.
    const src = `test('mixed', { tag: [1, '@req-R7'] }, async () => {})`
    const r = extractTestsFromSource('a.spec.ts', src)
    // The numeric `1` is skipped; only '@req-R7' is read.
    expect(r.tests[0].requirements).toEqual(['R7'])
  })

  it('reads tag when the property key is a quoted string literal (line 198 isStringLiteralLike branch)', () => {
    // parseTestTags line 198: `ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)`
    // When the key is written as a quoted string ('tag') rather than an identifier (tag),
    // isIdentifier is false but isStringLiteralLike is true.
    const src = `test('quoted key', { 'tag': '@req-R8' }, async () => {})`
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toEqual(['R8'])
  })

  it('ignores computed property name keys in details object (line 198 fallback branch)', () => {
    // parseTestTags line 198: `ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : ''`
    // A computed property name [k] is neither Identifier nor StringLiteralLike → key falls back to '',
    // which matches neither 'tag' nor 'tags' → no coverage tags extracted.
    const src = `
      const k = 'tag'
      test('computed key', { [k]: '@req-R9' }, async () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toBeUndefined()
  })

  it('returns empty when tag value is neither string nor array (line 181 else-if FALSE branch)', () => {
    // readTagPropertyStrings: when the tag value is not a string literal and not an array,
    // both branches are false and the function returns [].
    const src = `test('obj tag', { tag: {} }, async () => {})`
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].requirements).toBeUndefined()
    expect(r.tests[0].pathTypes).toBeUndefined()
  })

  it('deduplicates requirement ids when the same id appears in both tag and comment (line 211 FALSE branch)', () => {
    // mergeAnnotations: iterating over [...primary.requirements, ...fallback.requirements],
    // if R1 appears in both, the second encounter hits `if (!requirements.includes(id))` as FALSE.
    const src = `
      // @requirement R1
      test('dup req', { tag: ['@req-R1'] }, async () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    // R1 from both sources → should appear exactly once after dedup
    expect(r.tests[0].requirements).toEqual(['R1'])
  })
})

describe('extractTestsFromSource — duplicate assertion dedup (line 259 FALSE branch)', () => {
  it('deduplicates identical expect(...) snippets in the collected assertions', () => {
    // The same expect call written twice → seen.has(text) is true on second encounter → not added again.
    const src = `
      test('dup assert', async () => {
        expect(total).toBe(42)
        expect(total).toBe(42)
      })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    const assertions = r.tests[0].assertions ?? []
    // Only one unique snippet should be collected
    const count = assertions.filter((a) => a.includes('total')).length
    expect(count).toBe(1)
  })
})
