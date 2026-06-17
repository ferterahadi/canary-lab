import { describe, it, expect } from 'vitest'
import { extractTestsFromSource, parseTestAnnotations, parseTestTagList } from './ast-extractor'

describe('extractTestsFromSource', () => {
  it('returns empty array when no tests are present', () => {
    const r = extractTestsFromSource('a.spec.ts', `import {} from 'x';\nconst x = 1;`)
    expect(r.tests).toEqual([])
    expect(r.parseError).toBeUndefined()
  })

  it('extracts a flat test with no steps', () => {
    const src = `
      import { test } from '@playwright/test'
      test('hello world', async () => {
        expect(1).toBe(1)
      })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests).toHaveLength(1)
    expect(r.tests[0].name).toBe('hello world')
    expect(r.tests[0].steps).toEqual([])
    expect(r.tests[0].line).toBeGreaterThan(0)
  })

  it('extracts flat test.step calls inside a test', () => {
    const src = `
      test('outer', async () => {
        await test.step('first', async () => { await page.goto('/') })
        await test.step('second', async () => { await page.click('#btn') })
        await page.click('#x')
      })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests).toHaveLength(1)
    expect(r.tests[0].steps).toHaveLength(2)
    expect(r.tests[0].steps.map((s) => s.label)).toEqual(['first', 'second'])
    expect(r.tests[0].steps[0].bodySource).toContain("page.goto('/')")
    expect(r.tests[0].steps[0].children).toEqual([])
  })

  it('extracts nested test.step calls into children', () => {
    const src = `
      test('outer', async () => {
        await test.step('parent', async () => {
          await test.step('child', async () => { x++ })
        })
      })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    const parent = r.tests[0].steps[0]
    expect(parent.label).toBe('parent')
    expect(parent.children).toHaveLength(1)
    expect(parent.children[0].label).toBe('child')
    expect(parent.children[0].bodySource).toContain('x++')
  })

  it('captures the test bodySource', () => {
    const src = `
      test('with body', async () => { const x = 1; expect(x).toBe(1) })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].bodySource).toContain('const x = 1')
    expect(r.tests[0].bodySource).toContain('expect(x).toBe(1)')
  })

  it('keeps bodySource line-for-line with the source so highlights map 1:1', () => {
    // The live test view highlights the running line and resolves "open in
    // editor" by adding a body-line offset to the test's start line, so body
    // line N must correspond to source line N. A blank line between statements
    // must therefore be preserved — re-printing the AST would drop it and
    // shift every subsequent line.
    const src = [
      "test('mapping', async () => {",
      '  const a = 1',
      '',
      '  expect(a).toBe(1)',
      '})',
    ].join('\n')
    const body = extractTestsFromSource('a.spec.ts', src).tests[0].bodySource.split('\n')
    expect(body[0]).toBe('{')
    expect(body[1]).toContain('const a = 1')
    expect(body[2]).toBe('') // blank line preserved
    expect(body[3]).toContain('expect(a).toBe(1)')
  })

  it('ignores test.describe groups but extracts inner tests', () => {
    const src = `
      test.describe('group', () => {
        test('inner1', async () => { x++ })
        test('inner2', async () => { y++ })
      })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests.map((t) => t.name)).toEqual(['inner1', 'inner2'])
  })

  it('handles test.only and test.skip but ignores test.step at top level', () => {
    const src = `
      test.only('focused', async () => { await test.step('a', async () => {}) })
      test.skip('skipped', async () => {})
      test.step('top-level step is not a test', async () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests.map((t) => t.name)).toEqual(['focused', 'skipped'])
    expect(r.tests[0].steps[0].label).toBe('a')
  })

  it('accepts template-literal labels', () => {
    const src = "test(`tpl name`, async () => { await test.step(`tpl step`, async () => {}) })"
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests[0].name).toBe('tpl name')
    expect(r.tests[0].steps[0].label).toBe('tpl step')
  })

  it('skips test calls whose first arg is not a string literal', () => {
    const src = `const NAME='dyn'; test(NAME, async () => {})`
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests).toEqual([])
  })

  it('skips test.step calls with non-string label; allows missing body', () => {
    const src = `
      test('outer', async () => {
        await test.step(LABEL, async () => {})
        await test.step('no-body')
        await test.step('with body fn', function () { /* fn expr */ })
      })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    const steps = r.tests[0].steps
    expect(steps.map((s) => s.label)).toEqual(['no-body', 'with body fn'])
    // No-body case has empty bodySource and no children.
    expect(steps[0].bodySource).toBe('')
    expect(steps[0].children).toEqual([])
    // Function-expression body still captures source.
    expect(steps[1].bodySource).toContain('fn expr')
  })

  it('ignores a test() call with no arguments', () => {
    // getStringArg returns null on a missing first arg.
    const r = extractTestsFromSource('a.spec.ts', `test()`)
    expect(r.tests).toEqual([])
  })

  it('accepts a no-substitution template literal title and no body', () => {
    // Covers the NoSubstitutionTemplateLiteral title path and the bodyless
    // test branches (empty bodySource + no steps).
    const r = extractTestsFromSource('a.spec.ts', 'test(`plain title`)')
    expect(r.tests).toHaveLength(1)
    expect(r.tests[0].name).toBe('plain title')
    expect(r.tests[0].bodySource).toBe('')
    expect(r.tests[0].steps).toEqual([])
  })

  it('stringifies a non-Error thrown during parsing', () => {
    // A source whose `.length` getter throws a primitive makes
    // ts.createSourceFile throw a non-Error, exercising the String(err) fallback.
    const hostile = { get length(): number { throw 'plain string failure' } }
    const r = extractTestsFromSource('a.spec.ts', hostile as unknown as string)
    expect(r.parseError).toBe('plain string failure')
    expect(r.tests).toEqual([])
  })

  it('treats a test.step whose second arg is not a function as bodyless', () => {
    // getStepBody hits its non-arrow/non-function-expression fallthrough.
    const src = `
      test('outer', async () => {
        await test.step('weird', 123)
      })
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    const steps = r.tests[0].steps
    expect(steps.map((s) => s.label)).toEqual(['weird'])
    expect(steps[0].bodySource).toBe('')
    expect(steps[0].children).toEqual([])
  })

  it('still returns gracefully on syntactically odd input', () => {
    // TS createSourceFile is lenient; this just ensures we don't throw.
    const src = `test('a', async () => { @@@ }`
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(Array.isArray(r.tests)).toBe(true)
  })

  it('ignores calls on identifiers other than test', () => {
    const src = `
      describe('group', () => { it('case', () => {}) })
      foo.test('bar', () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests).toEqual([])
  })

  it('returns parseError when createSourceFile throws', () => {
    // Force the failure path by passing a non-string source.
    const r = extractTestsFromSource('bad.ts', undefined as unknown as string)
    expect(r.parseError).toBeTruthy()
    expect(r.tests).toEqual([])
  })
})

describe('parseTestAnnotations', () => {
  it('parses @requirement (repeatable, deduped, order preserved)', () => {
    const out = parseTestAnnotations('// @requirement R2\n// @requirement R1\n// @requirement R2')
    expect(out.requirements).toEqual(['R2', 'R1'])
  })

  it('parses @path single, list, and repeated forms; canonical order', () => {
    expect(parseTestAnnotations('// @path sad').pathTypes).toEqual(['sad'])
    expect(parseTestAnnotations('// @path sad, happy').pathTypes).toEqual(['happy', 'sad'])
    expect(parseTestAnnotations('// @path edge\n// @path happy').pathTypes).toEqual(['happy', 'edge'])
  })

  it('ignores invalid path tokens', () => {
    expect(parseTestAnnotations('// @path bogus happy').pathTypes).toEqual(['happy'])
    expect(parseTestAnnotations('// @path nothing-valid').pathTypes).toBeUndefined()
  })

  it('returns undefined fields when nothing is annotated', () => {
    expect(parseTestAnnotations('// just a normal comment')).toEqual({
      requirements: undefined,
      pathTypes: undefined,
    })
  })
})

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
})
