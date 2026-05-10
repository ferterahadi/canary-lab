import { describe, it, expect } from 'vitest'
import { extractTestsFromSource } from './ast-extractor'

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
