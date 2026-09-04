import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { extractTestMetadataFromSource, extractTestPredicatesFromSource, extractTestsFromSource } from '../ast-extractor'
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
    // Targets and values are canonical text: the fixture's single quotes print double.
    expect(predicates('checkout total').map(summary)).toEqual([
      'toHaveText|page.getByTestId("total")|literal|"$148.50"|',
      'toContainText|page.getByRole("heading")|regex|/Order/i|',
      'toHaveCount|page.locator(".row")|literal|3|',
      'toBeVisible|page.getByText("Pay")|none||',
      'toBeVisible|page.getByText("Error")|none||not',
      'toContain|page.url()|literal|"checkout"|soft',
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
      'toMatchObject|body|asymmetric|{ items: expect.arrayContaining([expect.objectContaining({ sku: "A1" })]) }|',
      'toHaveLength|body.items|literal|2|',
      'toBeGreaterThan|body.total|literal|0|',
      'toEqual|body.currency|dynamic|expectedCurrency|',
      'toBe|body.note|dynamic|`note-${body.id}`|',
      'toEqual|body.flags|collection|[true, false]|',
      'toStrictEqual|body.meta|literal|null|',
      'toBeTruthy|body.ok|none||',
      'toBeDefined|loadCart()|none||resolves',
      'toThrow|loadCart()|literal|"boom"|rejects',
      'toThrow|() => parse("x")|none||',
    ])
  })

  it('reads expect.poll, toPass, step bodies and inline helpers; keeps unknown matchers', () => {
    expect(predicates('eventually consistent').map(summary)).toEqual([
      'toBeGreaterThanOrEqual|() => page.locator(".badge").count()|literal|1|poll',
      // A function body re-prints with the statement separators the printer uses.
      'toPass|async () => { const n = await page.locator(".badge").count(); expect(n).toBe(1); }|none||',
      // The toPass block's inner expect is a predicate of its own — it is still
      // an assertion the test makes, just retried.
      'toBe|n|literal|1|',
      'toHaveValue|page.getByLabel("Name")|literal|"Ada"|',
      'toBeAttached|page.getByText("done")|none||',
      'toBeCustom|page.locator("#x")|literal|42|',
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
      'toHaveURL|page|regex|new RegExp("^/x")|',
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
      { kind: 'fail', condition: 'process.env.CI === "true"', line: 4, source: "test.fail(process.env.CI === 'true')" },
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

describe('canonical comparison text', () => {
  function firstPredicate(body: string): TestPredicate {
    return extractTestPredicatesFromSource('a.spec.ts', `test('t', async () => {\n${body}\n})`).tests[0].predicates[0]
  }

  it('reads quote style, line breaks, trailing commas and number spelling as the same target and value', () => {
    const compact = firstPredicate(`await expect(page.getByRole('button', { name: 'Pay' })).toHaveText('$1', { timeout: 1_000 })`)
    const reformatted = firstPredicate(`await expect(\n  page.getByRole("button", {\n    name: "Pay",\n  }),\n).toHaveText("$1", { timeout: 1000 },);`)
    expect(reformatted.target).toBe(compact.target)
    expect(reformatted.expectedText).toBe(compact.expectedText)
    // The statement as written is kept for the reader.
    expect(compact.source).toContain("'Pay'")
    expect(reformatted.source).toContain('"Pay"')
  })

  it('reads a quoted property name, a template with no substitution and 1.0 as their plain spellings', () => {
    const plain = firstPredicate(`expect(body).toEqual({ a: 1, list: [1, 2] })`)
    const spelled = firstPredicate("expect(body).toEqual({ 'a': 0x1, list: [1.0, 2,], })")
    expect(spelled.expectedText).toBe(plain.expectedText)
    expect(firstPredicate('expect(name).toBe(`Ada`)').expectedText).toBe(firstPredicate("expect(name).toBe('Ada')").expectedText)
    // A different value is still a different value, and a key that needs quoting keeps them.
    expect(firstPredicate(`expect(body).toEqual({ a: 2 })`).expectedText).not.toBe(plain.expectedText)
    expect(firstPredicate(`expect(body).toEqual({ 'kebab-case': 1 })`).expectedText).not.toBe(firstPredicate(`expect(body).toEqual({ kebabCase: 1 })`).expectedText)
  })

  it('canonicalises a guard condition the same way, and keeps its source as written', () => {
    const [test] = extractTestPredicatesFromSource('a.spec.ts', `test('t', async () => { test.skip(process.env.CI === 'true', 'ci') })`).tests
    expect(test.guards).toEqual([{ kind: 'skip', condition: 'process.env.CI === "true"', line: 1, source: "test.skip(process.env.CI === 'true', 'ci')" }])
  })
})

describe('the `it` spelling', () => {
  it('declares tests, steps, hooks, describes and guards under `it` exactly as under `test`', () => {
    const src = `import { test as it, expect } from '@playwright/test'
it.describe('suite', () => {
  it.beforeEach(async () => { it.skip(!process.env.CREDS, 'creds') })
  it('a', async ({ page }) => {
    await it.step('inner', async () => { expect(1).toBe(1) })
  })
  it.skip('b', async () => { expect(2).toBe(2) })
  it.fixme(process.platform === 'win32', 'posix')
})`
    const result = extractTestPredicatesFromSource('a.spec.ts', src)
    const inherited = ["it.skip(!process.env.CREDS, 'creds')", "it.fixme(process.platform === 'win32', 'posix')"]
    expect(result.tests.map((t) => [t.name, t.modifier, t.predicates.length, (t.guards ?? []).map((g) => g.source)])).toEqual([
      ['a', undefined, 1, inherited],
      ['b', 'skip', 1, inherited],
    ])
  })
})

describe('parametrised declarations', () => {
  const names = (src: string): string[] => extractTestPredicatesFromSource('a.spec.ts', src).tests.map((t) => t.name)

  it('declares one test per element of an inline or const-bound array, with the title resolved', () => {
    expect(names(`for (const key of ['a', 'b']) test(\`redeems \${key} voucher\`, async () => { await go(key) })`))
      .toEqual(['redeems a voucher', 'redeems b voucher'])
    expect(names(`const KEYS = ['x', 2, true] as const
test.describe('suite', () => {
  for (const key of KEYS) {
    test(\`case \${key}\`, async () => { await go(key) })
  }
})`)).toEqual(['case x', 'case 2', 'case true'])
  })

  it('resolves destructured object and array elements, and property access on an element', () => {
    const src = `const cases = [
  { key: 'expired', errorText: 'This voucher has expired' },
  { key: 'invalidCode', errorText: 'Voucher cannot be applied' },
] as const
for (const { key, errorText: text } of cases) test(\`rejects \${key}: \${text}\`, async () => { await go(key) })
for (const entry of cases) test(\`entry \${entry.key} / \${entry.missing} / \${other.key}\`, async () => { await go(entry) })
for (const [a, b] of [[1, 'one'], [2, 'two']]) test(\`pair \${a}-\${b}\`, async () => { await go(a) })`
    expect(names(src)).toEqual([
      'rejects expired: This voucher has expired',
      'rejects invalidCode: Voucher cannot be applied',
      'entry expired / ${entry.missing} / ${other.key}',
      'entry invalidCode / ${entry.missing} / ${other.key}',
      'pair 1-one',
      'pair 2-two',
    ])
  })

  it('takes the product of nested loops, outer first, and reads forEach like for…of', () => {
    const src = `const sizes = ['s', 'l']
for (const colour of ['red', 'blue']) {
  sizes.forEach((size) => {
    test(\`\${colour} \${size}\`, async () => { await go(colour, size) })
  })
}`
    expect(names(src)).toEqual(['red s', 'red l', 'blue s', 'blue l'])
  })

  it('keeps one template-named test when the set cannot be read', () => {
    const cases = [
      `for (const key of keysFor(env)) test(\`k \${key}\`, async () => { await go(key) })`,
      `for (const key of [...base, 'x']) test(\`k \${key}\`, async () => { await go(key) })`,
      `for (const key of imported) test(\`k \${key}\`, async () => { await go(key) })`,
      `const keys = keys\nfor (const key of keys) test(\`k \${key}\`, async () => { await go(key) })`,
      `var keys = ['a']\nfor (const key of keys) test(\`k \${key}\`, async () => { await go(key) })`,
      `{ const keys = ['a'] }\nfor (const key of keys) test(\`k \${key}\`, async () => { await go(key) })`,
      `for (key of ['a']) test(\`k \${key}\`, async () => { await go(key) })`,
      `['a'].map((key) => test(\`k \${key}\`, async () => { await go(key) }))`,
    ]
    for (const src of cases) expect(names(src), src).toEqual(['k ${key}'])
    // A readable set whose pattern the element cannot satisfy, or a name the loop does
    // not bind, resolves what it can and leaves the rest as written.
    expect(names(`for (const { key } of ['plain']) test(\`k \${key}\`, async () => { await go(key) })`)).toEqual(['k ${key}'])
    expect(names(`[{ key: 'a' }].forEach(({ key }, index) => test(\`k \${key} \${index}\`, async () => { await go(index) }))`)).toEqual(['k a ${index}'])
  })

  it('lets an inner const shadow an outer one; a static or dynamic title resolves per element too', () => {
    const src = `const keys = ['outer']
test.describe('s', () => {
  const keys = ['inner1', 'inner2']
  for (const key of keys) test(\`k \${key}\`, async () => { await go(key) })
})
for (const key of keys) test('static', async () => { await go(key) })
for (const key of ['dyn']) test(key, async () => { await go(key) })
for (const [{ key }] of [[{ key: 'nested' }]]) test(\`deep \${key}\`, async () => { await go(key) })`
    expect(names(src)).toEqual(['k inner1', 'k inner2', 'static', 'dyn', 'deep ${key}'])
  })

  it('binds only what the element can supply: quoted or shorthand keys yes; nested, rest, computed, missing or call interpolations stay as written', () => {
    const src = `const key = 'shorthand'
for (const { key: k, 'quoted': q } of [{ key, 'quoted': 'Q' }]) test(\`a \${k} \${q}\`, async () => { await go(k) })
for (const { a: { b }, ...rest } of [{ a: { b: 1 }, c: 2 }]) test(\`b \${b} \${rest}\`, async () => { await go(b) })
for (const { [dyn]: v, nope } of [{ x: 1 }]) test(\`c \${v} \${nope}\`, async () => { await go(v) })
for (const key2 of ['up']) test(\`d \${key2.toUpperCase()} \${key2}\`, async () => { await go(key2) })`
    // A shorthand element property is a variable, so it interpolates as its source name.
    expect(names(src)).toEqual(['a key Q', 'b ${b} ${rest}', 'c ${v} ${nope}', 'd ${key2.toUpperCase()} up'])
  })

  it('leaves the metadata and readable extractors on the template name — the runner resolves those', () => {
    const src = `for (const key of ['a', 'b']) test(\`k \${key}\`, async () => { await go(key) })`
    expect(extractTestMetadataFromSource('a.spec.ts', src).tests.map((t) => t.name)).toEqual(['k ${key}'])
    expect(extractTestsFromSource('a.spec.ts', src).tests.map((t) => t.name)).toEqual(['k ${key}'])
  })

  it('marks a test that can enforce nothing: no callback, or a callback with no statements', () => {
    const src = `test('todo')\ntest('empty', async () => {})\ntest('live', async () => { await page.goto('/') })\ntest('expr', () => go())`
    expect(extractTestPredicatesFromSource('a.spec.ts', src).tests.map((t) => [t.name, t.emptyBody])).toEqual([
      ['todo', true], ['empty', true], ['live', undefined], ['expr', undefined],
    ])
  })
})
