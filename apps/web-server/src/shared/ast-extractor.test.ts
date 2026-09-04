import { describe, it, expect } from 'vitest'

import {
  extractTestMetadataFromSource,
  extractTestsFromSource,
  parseTestAnnotations,
  parseTestTagList,
} from './ast-extractor'

describe('extractTestsFromSource', () => {
  it('returns empty array when no tests are present', () => {
    const r = extractTestsFromSource('a.spec.ts', `import {} from 'x';\nconst x = 1;`)
    expect(r.tests).toEqual([])
    expect(r.parseError).toBeUndefined()
  })

  it('extracts a template-literal test name (lines 60-61 branch)', () => {
    // getNameArg: when the first argument is a template expression (backtick string),
    // lines 60-61 read its source text and strip the surrounding backticks.
    const src = `
      const x = 'world'
      test(\`hello \${x}\`, async () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests).toHaveLength(1)
    expect(r.tests[0].name).toBe('hello ${x}')
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
    expect(r.tests[0].readable).toEqual(expect.objectContaining({
      version: 2,
      title: 'hello world',
      completeness: 'complete',
      nodes: [expect.objectContaining({
        kind: 'leaf',
        role: 'syntax',
        text: 'call:\n    property `toBe`\n    of:\n        call `expect`\n        with argument number 1\nwith argument number 1',
      })],
    }))
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

  it('records the callback body line separately from a multiline test call', () => {
    const src = [
      'test(',
      "  'multiline declaration',",
      '  async () => {',
      '    await page.reload()',
      '  },',
      ')',
    ].join('\n')

    const test = extractTestsFromSource('a.spec.ts', src).tests[0]
    expect(test.line).toBe(1)
    expect(test.bodyLine).toBe(3)
    expect(test.readable.nodes[0].source.startLine).toBe(4)
  })

  it('translates from the existing AST and expands top-level local helpers', () => {
    const src = [
      'async function loginAs(page, email) {',
      "  await page.getByLabel('Email').fill(email)",
      '}',
      '',
      "test('logs in', async ({ page }) => {",
      "  await loginAs(page, 'ada@example.com')",
      "  await expect(page.getByText('Welcome')).toBeVisible()",
      '})',
    ].join('\n')
    const readable = extractTestsFromSource('account.spec.ts', src).tests[0].readable

    expect(readable.completeness).toBe('complete')
    expect(readable.nodes).toEqual([
      expect.objectContaining({
        kind: 'group',
        text: 'await:\n    call `loginAs`\n    with arguments:\n        `page`\n        string "ada@example.com"',
        source: expect.objectContaining({ file: 'account.spec.ts', startLine: 6 }),
        children: [expect.objectContaining({
          text: expect.stringContaining('call property `getByLabel` of `page`'),
          source: expect.objectContaining({ file: 'account.spec.ts', startLine: 2 }),
        })],
      }),
      expect.objectContaining({
        kind: 'leaf',
        role: 'syntax',
        text: expect.stringContaining('property `toBeVisible`'),
        source: expect.objectContaining({ file: 'account.spec.ts', startLine: 7 }),
      }),
    ])
  })

  it('collects top-level arrow and function-expression helpers once', () => {
    const src = [
      'declare function declaredOnly(): void',
      'export default function () {}',
      "async function duplicate(page) { await page.getByText('First').click() }",
      "async function duplicate(page) { await page.getByText('Ignored').click() }",
      "const arrowHelper = async (page) => { await page.getByLabel('Email').fill('ada@example.com') }",
      "const functionHelper = async function (page) { await page.getByRole('button', { name: 'Save' }).click() }",
      'const [ignoredHelper] = [async () => {}]',
      'const notAHelper = 42',
      '',
      "test('uses local helpers', async ({ page }) => {",
      '  await duplicate(page)',
      '  await arrowHelper(page)',
      '  await functionHelper(page)',
      '})',
    ].join('\n')

    const readable = extractTestsFromSource('helpers.spec.ts', src).tests[0].readable
    expect(readable.nodes).toEqual([
      expect.objectContaining({
        kind: 'group',
        text: 'await:\n    call `duplicate`\n    with argument `page`',
        children: [expect.objectContaining({ text: expect.stringContaining('string "First"') })],
      }),
      expect.objectContaining({
        kind: 'group',
        text: 'await:\n    call `arrowHelper`\n    with argument `page`',
        children: [expect.objectContaining({ text: expect.stringContaining('string "ada@example.com"') })],
      }),
      expect.objectContaining({
        kind: 'group',
        text: 'await:\n    call `functionHelper`\n    with argument `page`',
        children: [expect.objectContaining({ text: expect.stringContaining('string "Save"') })],
      }),
    ])
  })

  it('keeps bodySource line-for-line with the source so highlights map 1:1', () => {
    // The live test view maps the latest located Playwright step and resolves
    // "open in editor" by adding a body-line offset to the callback body's start
    // line, so body line N must correspond to source line N. A blank line between statements
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

  it('keeps a dynamic title when an inline callback proves this is a test declaration', () => {
    const src = [
      "const variant = { desc: 'dynamic title' }",
      "test.beforeEach('named setup', async () => {})",
      'test.afterEach(async () => {})',
      "test.skip(!enabled, 'conditional setup')",
      'test(variant.desc, async () => { expect(1).toBe(1) })',
    ].join('\n')
    const r = extractTestsFromSource('a.spec.ts', src)

    // The callback is load-bearing: it distinguishes a dynamically-named test
    // from conditional modifiers such as test.skip(condition, description).
    expect(r.tests).toHaveLength(1)
    expect(r.tests[0].name).toBe('variant.desc')
    expect(r.tests[0].bodySource).toContain('expect(1).toBe(1)')
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

  it('translates an expression-bodied test callback from its exact source line', () => {
    const r = extractTestsFromSource(
      'a.spec.ts',
      ["test('expression body',", "  async () => expect(1).toBe(1))"].join('\n'),
    )

    expect(r.tests[0].bodyLine).toBe(2)
    expect(r.tests[0].bodySource).toBe('expect(1).toBe(1)')
    expect(r.tests[0].readable.nodes[0]).toEqual(expect.objectContaining({
      kind: 'leaf',
      role: 'syntax',
      text: 'call:\n    property `toBe`\n    of:\n        call `expect`\n        with argument number 1\nwith argument number 1',
      source: expect.objectContaining({ startLine: 2, endLine: 2 }),
    }))
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

  it('ignores calls not rooted at a test declarator', () => {
    const src = `
      foo.test('bar', () => {})
      suite('group', () => { check('case', () => {}) })
      tests.it('x', () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests).toEqual([])
  })

  it('accepts `it` — the vitest/jest spelling and Playwright\'s `test as it` alias — with its steps and modifiers', () => {
    const src = `
      describe('group', () => { it('case', async () => { await it.step('s', async () => {}) }) })
      it.only('solo', () => {})
      // A table declared through \`.each\` is a call on a call, not a declarator chain:
      // it is not read (WeakenBench gap L6b), and must not be mistaken for a test either.
      it.each([1])('table %i', () => {})
    `
    const r = extractTestsFromSource('a.spec.ts', src)
    expect(r.tests.map((t) => [t.name, t.steps.map((s) => s.label)])).toEqual([['case', ['s']], ['solo', []]])
  })

  it('returns parseError when createSourceFile throws', () => {
    // Force the failure path by passing a non-string source.
    const r = extractTestsFromSource('bad.ts', undefined as unknown as string)
    expect(r.parseError).toBeTruthy()
    expect(r.tests).toEqual([])
  })
})

describe('extractTestMetadataFromSource', () => {
  it('returns only syntax-derived identity and body data for integrity checks', () => {
    const source = [
      "test('first', async () => { expect(1).toBe(1) })",
      "test.skip('second', async () => { expect(2).toBe(2) })",
    ].join('\n')

    const result = extractTestMetadataFromSource('/workspace/e2e/example.spec.ts', source)

    expect(result).toEqual({
      file: '/workspace/e2e/example.spec.ts',
      tests: [
        {
          name: 'first',
          line: 1,
          bodyLine: 1,
          bodySource: '{ expect(1).toBe(1) }',
        },
        {
          name: 'second',
          line: 2,
          bodyLine: 2,
          bodySource: '{ expect(2).toBe(2) }',
        },
      ],
    })
    expect(result.tests.every((test) => !('readable' in test))).toBe(true)
  })

  it('keeps the extractor failure-safe without invoking the presentation path', () => {
    const result = extractTestMetadataFromSource('bad.ts', undefined as unknown as string)
    expect(result.tests).toEqual([])
    expect(result.parseError).toBeTruthy()
  })

  it('stringifies a primitive syntax-parser failure', () => {
    const hostile = { get length(): number { throw 'metadata parse failure' } }
    const result = extractTestMetadataFromSource('bad.ts', hostile as unknown as string)

    expect(result.tests).toEqual([])
    expect(result.parseError).toBe('metadata parse failure')
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

  it('parses @variant tokens (line 160 branch — the variant for-loop body)', () => {
    // A comment with @variant exercises the `for (const token of m[1].split(...))` body.
    const out = parseTestAnnotations('// @variant email, sms')
    expect(out.variants).toEqual(['email', 'sms'])
  })
})
