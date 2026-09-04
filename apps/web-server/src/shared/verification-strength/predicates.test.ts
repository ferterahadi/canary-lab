import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { extractTestPredicatesFromSource } from '../ast-extractor'
import { parseExpectation } from '../readable-tests/assertions'
import type { TestPredicate } from '../../../../../shared/verification-strength/types'

// One realistic Playwright spec exercising every assertion shape the predicate
// collector distinguishes. Line numbers in the expectations below are relative
// to this fixture, so keep it stable: the FIRST line of the template is line 1.
const SPEC = `import { test, expect } from '@playwright/test'

test('checkout total', { tag: ['@req-R14'] }, async ({ page }) => {
  await page.goto('/checkout')
  await expect(page.getByTestId('total')).toHaveText('$148.50')
  await expect(page.getByRole('heading')).toContainText(/Order/i, { ignoreCase: true })
  await expect(page.locator('.row')).toHaveCount(3)
  await expect(page.getByText('Pay')).toBeVisible()
  await expect(page.getByText('Error')).not.toBeVisible()
  expect.soft(page.url()).toContain('checkout')
  await expect(page).toHaveURL(/\\/checkout$/)
})

test('api contract', async ({ request }) => {
  const res = await request.get('/api/cart')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ sku: 'A1' })]) })
  expect(body.items).toHaveLength(2)
  expect(body.total).toBeGreaterThan(0)
  expect(body.currency).toEqual(expectedCurrency)
  expect(body.note).toBe(\`note-\${body.id}\`)
  expect(body.flags).toEqual([true, false])
  expect(body.meta).toStrictEqual(null)
  expect(body.ok).toBeTruthy()
  await expect(loadCart()).resolves.toBeDefined()
  await expect(loadCart()).rejects.toThrow('boom')
  expect(() => parse('x')).toThrow()
})

test('eventually consistent', async ({ page }) => {
  await expect.poll(() => page.locator('.badge').count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1)
  await expect(async () => {
    const n = await page.locator('.badge').count()
    expect(n).toBe(1)
  }).toPass()
  await test.step('inside a step', async () => {
    await expect(page.getByLabel('Name')).toHaveValue('Ada')
  })
  const check = async () => { await expect(page.getByText('done')).toBeAttached() }
  await check()
  expect(page.locator('#x')).toBeCustom(42)
  expect(page.locator('#y'))
})

test('no assertions', async ({ page }) => {
  await page.goto('/')
})
`

function predicates(name: string): TestPredicate[] {
  const result = extractTestPredicatesFromSource('checkout.spec.ts', SPEC)
  const test = result.tests.find((t) => t.name === name)
  if (!test) throw new Error(`fixture has no test named ${name}`)
  return test.predicates
}

function summary(p: TestPredicate): string {
  const flags = [
    p.negated ? 'not' : '',
    p.soft ? 'soft' : '',
    p.poll ? 'poll' : '',
    p.settlement ?? '',
  ].filter(Boolean).join(',')
  return `${p.matcher}|${p.target}|${p.expected}|${p.expectedText ?? ''}|${flags}`
}

describe('extractTestPredicatesFromSource', () => {
  it('lists every test with its line, in declaration order', () => {
    const result = extractTestPredicatesFromSource('checkout.spec.ts', SPEC)
    expect(result.file).toBe('checkout.spec.ts')
    expect(result.parseError).toBeUndefined()
    expect(result.tests.map((t) => [t.name, t.line])).toEqual([
      ['checkout total', 3],
      ['api contract', 14],
      ['eventually consistent', 31],
      ['no assertions', 46],
    ])
  })

  it('reads web-first matchers with their target and expected shape', () => {
    expect(predicates('checkout total').map(summary)).toEqual([
      "toHaveText|page.getByTestId('total')|literal|'$148.50'|",
      "toContainText|page.getByRole('heading')|regex|/Order/i|",
      "toHaveCount|page.locator('.row')|literal|3|",
      "toBeVisible|page.getByText('Pay')|none||",
      "toBeVisible|page.getByText('Error')|none||not",
      "toContain|page.url()|literal|'checkout'|soft",
      'toHaveURL|page|regex|/\\/checkout$/|',
    ])
  })

  it('keeps matcher option keys — they can change what a predicate proves', () => {
    const [, containText, , visible] = predicates('checkout total')
    expect(containText.optionKeys).toEqual(['ignoreCase'])
    expect(containText.expectedArity).toBe(1)
    expect(visible.optionKeys).toBeUndefined()
    expect(visible.expectedArity).toBe(0)
  })

  it('classifies expected values: literal, asymmetric, collection, dynamic', () => {
    expect(predicates('api contract').map(summary)).toEqual([
      'toBe|res.status()|literal|200|',
      "toMatchObject|body|asymmetric|{ items: expect.arrayContaining([expect.objectContaining({ sku: 'A1' })]) }|",
      'toHaveLength|body.items|literal|2|',
      'toBeGreaterThan|body.total|literal|0|',
      'toEqual|body.currency|dynamic|expectedCurrency|',
      'toBe|body.note|dynamic|`note-${body.id}`|',
      'toEqual|body.flags|collection|[true, false]|',
      'toStrictEqual|body.meta|literal|null|',
      'toBeTruthy|body.ok|none||',
      'toBeDefined|loadCart()|none||resolves',
      "toThrow|loadCart()|literal|'boom'|rejects",
      "toThrow|() => parse('x')|none||",
    ])
  })

  it('reads expect.poll, toPass, step bodies and inline helpers; keeps unknown matchers', () => {
    expect(predicates('eventually consistent').map(summary)).toEqual([
      "toBeGreaterThanOrEqual|() => page.locator('.badge').count()|literal|1|poll",
      "toPass|async () => { const n = await page.locator('.badge').count() expect(n).toBe(1) }|none||",
      // The toPass block's inner expect is a predicate of its own — it is still
      // an assertion the test makes, just retried.
      'toBe|n|literal|1|',
      "toHaveValue|page.getByLabel('Name')|literal|'Ada'|",
      "toBeAttached|page.getByText('done')|none||",
      "toBeCustom|page.locator('#x')|literal|42|",
    ])
  })

  it('reports an expect() that never reaches a matcher as unparsed, never as absent', () => {
    const result = extractTestPredicatesFromSource('checkout.spec.ts', SPEC)
    const test = result.tests.find((t) => t.name === 'eventually consistent')
    expect(test?.unparsed).toEqual([
      { line: 43, source: "expect(page.locator('#y'))", reason: 'no matcher call' },
    ])
    expect(result.tests.find((t) => t.name === 'checkout total')?.unparsed).toBeUndefined()
  })

  it('reports an expect chain the shared parser rejects as unparsed', () => {
    // Two `.not` modifiers are not a standard chain; `parseExpectation` refuses
    // to guess what they mean, so the collector must surface the refusal.
    const src = `test('t', async () => { expect(a).not.not.toBe(1) })`
    const [test] = extractTestPredicatesFromSource('a.spec.ts', src).tests
    expect(test.predicates).toEqual([])
    expect(test.unparsed).toEqual([
      { line: 1, source: 'expect(a).not.not.toBe(1)', reason: 'unrecognized expect chain' },
    ])
  })

  it('records the line and normalized statement source of each predicate', () => {
    const [total] = predicates('checkout total')
    expect(total.line).toBe(5)
    expect(total.source).toBe("await expect(page.getByTestId('total')).toHaveText('$148.50')")
    // A poll predicate's source is the whole awaited chain, options included.
    expect(predicates('eventually consistent')[0].source).toBe(
      "await expect.poll(() => page.locator('.badge').count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1)",
    )
  })

  it('treats `new RegExp(...)` as a pattern and a negative number as a literal', () => {
    const src = `test('t', async () => {
      await expect(page).toHaveURL(new RegExp('^/x'))
      expect(delta).toBe(-1)
      expect(flag).toBe(undefined)
    })`
    const [test] = extractTestPredicatesFromSource('a.spec.ts', src).tests
    expect(test.predicates.map(summary)).toEqual([
      "toHaveURL|page|regex|new RegExp('^/x')|",
      'toBe|delta|literal|-1|',
      'toBe|flag|literal|undefined|',
    ])
  })

  it('takes the expected shape from the value argument of a two-argument matcher', () => {
    const src = `test('t', async () => {
      await expect(link).toHaveAttribute('href', /docs/)
      await expect(box).toHaveCSS('color', 'red', { timeout: 1000 })
      expect(obj).toHaveProperty('a.b')
    })`
    const [test] = extractTestPredicatesFromSource('a.spec.ts', src).tests
    expect(test.predicates.map((p) => [p.matcher, p.expected, p.expectedArity, p.optionKeys])).toEqual([
      ['toHaveAttribute', 'regex', 2, undefined],
      ['toHaveCSS', 'literal', 2, ['timeout']],
      ['toHaveProperty', 'literal', 1, undefined],
    ])
  })

  it('reads an option bag only when every property is a known option key', () => {
    const src = `test('t', async () => {
      await expect(el).toBeVisible({ timeout })
      expect(obj).toEqual({ ...rest })
      expect(obj).toEqual({})
      expect(obj).toEqual({ timeout: 1, colour: 'red' })
    })`
    const [test] = extractTestPredicatesFromSource('a.spec.ts', src).tests
    expect(test.predicates.map((p) => [p.expected, p.expectedArity, p.optionKeys])).toEqual([
      // Shorthand `{ timeout }` is still an option bag.
      ['none', 0, ['timeout']],
      // A spread, an empty object, or a stray non-option key make it a value.
      ['collection', 1, undefined],
      ['collection', 1, undefined],
      ['collection', 1, undefined],
    ])
  })

  it('gives a test with no assertions an empty predicate list', () => {
    expect(predicates('no assertions')).toEqual([])
  })

  it('surfaces a parse failure instead of throwing', () => {
    const result = extractTestPredicatesFromSource('bad.ts', undefined as unknown as string)
    expect(result.tests).toEqual([])
    expect(result.parseError).toBeTruthy()
  })

  it('stringifies a primitive parser failure', () => {
    const hostile = { get length(): number { throw 'predicate parse failure' } }
    const result = extractTestPredicatesFromSource('bad.ts', hostile as unknown as string)
    expect(result.parseError).toBe('predicate parse failure')
    expect(result.tests).toEqual([])
  })

  it('handles the details-object test signature and a test without a callback body', () => {
    const src = `
      test('declared only')
      test.skip('skipped', { tag: '@req-R1' }, async () => { expect(1).toBe(1) })
    `
    const result = extractTestPredicatesFromSource('a.spec.ts', src)
    expect(result.tests.map((t) => [t.name, t.predicates.length, t.modifier])).toEqual([
      ['declared only', 0, undefined],
      ['skipped', 1, 'skip'],
    ])
    // Absent, not `undefined`: the record is compared structurally downstream.
    expect('modifier' in result.tests[0]).toBe(false)
  })
})

describe('parseExpectation poll gate', () => {
  function matcherCall(source: string): ts.CallExpression {
    const file = ts.createSourceFile('a.spec.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const statement = file.statements[0] as ts.ExpressionStatement
    return statement.expression as ts.CallExpression
  }

  it('rejects expect.poll unless the caller opts in — readable rendering keeps its fallback', () => {
    const call = matcherCall(`expect.poll(() => n).toBe(1)`)
    expect(parseExpectation(call)).toBeUndefined()
    expect(parseExpectation(call, { allowPoll: true })).toMatchObject({ matcher: 'toBe', poll: true, soft: false })
  })
})

describe('run-time guards', () => {
  it('records test.skip / test.fixme / test.fail calls in a body with their condition, wherever they sit', () => {
    const src = `test('t', async ({ page }) => {
      test.skip(!process.env.CREDS, 'needs credentials')
      test.fixme()
      await test.step('inner', async () => { test.fail(process.env.CI === 'true') })
      expect(1).toBe(1)
    })`
    const [test] = extractTestPredicatesFromSource('a.spec.ts', src).tests
    expect(test.guards).toEqual([
      { kind: 'skip', condition: '!process.env.CREDS', line: 2, source: "test.skip(!process.env.CREDS, 'needs credentials')" },
      { kind: 'fixme', line: 3, source: 'test.fixme()' },
      { kind: 'fail', condition: "process.env.CI === 'true'", line: 4, source: "test.fail(process.env.CI === 'true')" },
    ])
    expect(test.predicates).toHaveLength(1)
  })

  it('leaves the field absent when nothing guards a test — the record is compared structurally', () => {
    const [test] = extractTestPredicatesFromSource('a.spec.ts', `test('t', async () => { expect(1).toBe(1) })`).tests
    expect('guards' in test).toBe(false)
  })

  it('hands a describe-level or hook guard to every test in its scope, and a top-level one to all', () => {
    const src = `test.skip(process.platform === 'win32', 'posix only')
test.describe('outer', () => {
  test.beforeEach(async () => { test.skip(!process.env.CREDS, 'needs credentials') })
  test('a', async () => { expect(1).toBe(1) })
  describe('inner', () => {
    beforeEach(() => { test.fixme(flaky) })
    test.skip(({ browserName }) => browserName === 'webkit', 'no webkit')
    test('b', async () => { test.skip(true) })
  })
})
test('c', async () => {})`
    const result = extractTestPredicatesFromSource('a.spec.ts', src)
    const byName = Object.fromEntries(result.tests.map((t) => [t.name, (t.guards ?? []).map((g) => g.source)]))
    expect(byName).toEqual({
      a: ["test.skip(process.platform === 'win32', 'posix only')", "test.skip(!process.env.CREDS, 'needs credentials')"],
      b: [
        "test.skip(process.platform === 'win32', 'posix only')",
        "test.skip(!process.env.CREDS, 'needs credentials')",
        'test.fixme(flaky)',
        "test.skip(({ browserName }) => browserName === 'webkit', 'no webkit')",
        'test.skip(true)',
      ],
      c: ["test.skip(process.platform === 'win32', 'posix only')"],
    })
  })

  it('never mistakes a declaration — literal or dynamic title — for a guard, and drops a guard inside a helper whose callers are unknown', () => {
    const src = `function requireCreds() { test.skip(!process.env.CREDS) }
test.describe('suite', () => {
  test.skip('declared skipped', async () => { expect(1).toBe(1) })
  test.fixme(\`declared \${variant}\`, async () => {})
  test('t', async () => { requireCreds(); expect(1).toBe(1) })
  for (const name of names) test.skip(name, { tag: '@slow' }, async () => { expect(1).toBe(1) })
})`
    const result = extractTestPredicatesFromSource('a.spec.ts', src)
    const named = result.tests.filter((t) => ['declared skipped', 't', 'name'].includes(t.name))
    expect(named.map((t) => [t.name, t.modifier, t.guards])).toEqual([
      ['declared skipped', 'skip', undefined],
      ['t', undefined, undefined],
      ['name', 'skip', undefined],
    ])
    expect(result.tests.every((t) => !t.guards)).toBe(true)
  })
})
