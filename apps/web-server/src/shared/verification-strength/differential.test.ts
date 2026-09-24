import { describe, expect, it } from 'vitest'
import { extractTestPredicatesFromSource } from '../ast-extractor'
import type { PredicateChange, SpecDiff } from '../../../../../shared/verification-strength/types'
import { diffPredicateSets, diffSpecPredicates } from './differential'

// Every case runs the real extractor over a before/after spec source: the verdict
// is a derivation, so it is pinned against fixtures, not hand-built predicates.
function diff(before: string, after: string): SpecDiff {
  return diffSpecPredicates(
    extractTestPredicatesFromSource('a.spec.ts', before),
    extractTestPredicatesFromSource('a.spec.ts', after),
  )
}

function spec(body: string, name = 'checkout', declare = 'test'): string {
  return `${declare}('${name}', async ({ page }) => {\n${body}\n})`
}

function change(c: PredicateChange): string {
  const reason = c.reason ? ` (${c.reason})` : ''
  return `${c.kind}:${c.verdict}${reason} ${c.before?.source ?? '-'} => ${c.after?.source ?? '-'}`
}

function summary(result: SpecDiff): string[] {
  return result.tests.flatMap((t) => [
    `${t.kind}:${t.verdict} ${t.wasNamed ? `${t.wasNamed} -> ` : ''}${t.name}`,
    ...t.changes.map((c) => `  ${change(c)}`),
  ])
}

describe('diffSpecPredicates — equivalent edits produce no change', () => {
  it('reports an identical file as equivalent with nothing to show', () => {
    const src = spec(`  await expect(page.getByTestId('total')).toHaveText('$1')`)
    expect(diff(src, src)).toEqual({ verdict: 'equivalent', tests: [] })
  })

  it('reads a selector rename as the same predicate on a new target', () => {
    const before = spec(`  await expect(page.locator('.total')).toHaveText('$1')`)
    const after = spec(`  await expect(page.getByTestId('total')).toHaveText('$1')`)
    const result = diff(before, after)
    expect(result.verdict).toBe('equivalent')
    expect(summary(result)).toEqual([
      'changed:equivalent checkout',
      "  retargeted:equivalent await expect(page.locator('.total')).toHaveText('$1') => await expect(page.getByTestId('total')).toHaveText('$1')",
    ])
  })

  it('ignores soft, settlement, option order and formatting — none of them change what is proven', () => {
    const before = spec(`  expect(page.url()).toBe('/x')\n  await expect(page.getByText('a')).toHaveText('a', { timeout: 1, ignoreCase: true })\n  await expect(loadCart()).resolves.toBeDefined()`)
    const after = spec(`  expect.soft(page.url()).toBe( '/x' )\n  await expect(page.getByText('a')).toHaveText('a', { ignoreCase: true, timeout: 5000 })\n  await expect(loadCart()).resolves.toBeDefined()`)
    expect(diff(before, after)).toEqual({ verdict: 'equivalent', tests: [] })
  })

  it('cancels an unchanged predicate it could not rank, so an old run-time value does not taint every edit', () => {
    const shared = `  expect(count).toBeGreaterThan(previous)\n`
    const before = spec(`${shared}  await expect(page.locator('.ok')).toBeVisible()`)
    const after = spec(`${shared}  await expect(page.getByText('ok')).toBeVisible()`)
    expect(diff(before, after).verdict).toBe('equivalent')
  })

  it('reads a renamed test with the same assertions as equivalent', () => {
    const body = `  await expect(page.getByText('Pay')).toBeVisible()`
    const result = diff(spec(body, 'old name'), spec(body, 'new name'))
    expect(result.verdict).toBe('equivalent')
    expect(summary(result)).toEqual(['renamed:equivalent old name -> new name'])
    // A rename that also disables the test, or changes its assertions, is a deletion plus an addition.
    const kinds = (r: SpecDiff) => r.tests.map((t) => `${t.kind}:${t.verdict}`)
    expect(kinds(diff(spec(body, 'old name'), spec(body, 'new name', 'test.skip')))).toEqual(['deleted:weaker', 'added:equivalent'])
    expect(kinds(diff(spec(body, 'old name'), spec(`  await expect(page.getByText('Pay')).toHaveText('Pay')`, 'new name')))).toEqual(['deleted:weaker', 'added:stronger'])
  })
})

describe('diffSpecPredicates — weaker', () => {
  it('flags a removed assertion', () => {
    const before = spec(`  await expect(page.getByText('Pay')).toBeVisible()\n  await expect(page.getByTestId('total')).toHaveText('$1')`)
    const after = spec(`  await expect(page.getByText('Pay')).toBeVisible()`)
    const result = diff(before, after)
    expect(result.verdict).toBe('weaker')
    expect(summary(result)).toEqual([
      'changed:weaker checkout',
      "  removed:weaker await expect(page.getByTestId('total')).toHaveText('$1') => -",
    ])
  })

  it('flags a matcher swapped for a weaker one on the same target', () => {
    const before = spec(`  await expect(page.getByTestId('total')).toHaveText('$1')`)
    const after = spec(`  await expect(page.getByTestId('total')).toBeVisible()`)
    expect(summary(diff(before, after))).toEqual([
      'changed:weaker checkout',
      "  reshaped:weaker await expect(page.getByTestId('total')).toHaveText('$1') => await expect(page.getByTestId('total')).toBeVisible()",
    ])
  })

  it('flags an exact match loosened to a containment or a regex', () => {
    const before = spec(`  await expect(page.getByRole('heading')).toHaveText('Order #1')`)
    expect(diff(before, spec(`  await expect(page.getByRole('heading')).toContainText('Order')`)).verdict).toBe('weaker')
    expect(diff(before, spec(`  await expect(page.getByRole('heading')).toHaveText(/Order/)`)).verdict).toBe('weaker')
    expect(diff(before, spec(`  await expect(page.getByRole('heading')).toHaveText('Order #1', { ignoreCase: true })`)).verdict).toBe('weaker')
  })

  it('lets a certain weakening dominate an addition elsewhere', () => {
    const before = spec(`  await expect(page.getByTestId('total')).toHaveText('$1')`)
    const after = spec(`  await expect(page.getByText('Pay')).toBeVisible()\n  await expect(page.getByText('Ship')).toBeEnabled()`)
    const result = diff(before, after)
    expect(result.verdict).toBe('weaker')
    expect(result.tests[0].changes.map((c) => c.verdict)).toEqual(['weaker', 'stronger', 'stronger'])
  })

  it('pairs a retarget once — a second identical predicate that vanished is still a removal', () => {
    const before = spec(`  await expect(page.locator('.a')).toHaveText('x')\n  await expect(page.locator('.b')).toHaveText('x')`)
    const after = spec(`  await expect(page.getByTestId('a')).toHaveText('x')`)
    expect(summary(diff(before, after))).toEqual([
      'changed:weaker checkout',
      "  retargeted:equivalent await expect(page.locator('.a')).toHaveText('x') => await expect(page.getByTestId('a')).toHaveText('x')",
      "  removed:weaker await expect(page.locator('.b')).toHaveText('x') => -",
    ])
  })

  it('cancels identical assertions one-for-one — a repeat that vanished is a removal', () => {
    const visible = `  await expect(page.getByText('Pay')).toBeVisible()`
    const before = spec(`${visible}\n  await page.getByText('Retry').click()\n${visible}`)
    const result = diff(before, spec(`${visible}\n  await page.getByText('Retry').click()`))
    expect(summary(result)).toEqual([
      'changed:weaker checkout',
      "  removed:weaker await expect(page.getByText('Pay')).toBeVisible() => -",
    ])
  })

  it('flags a deleted test; a live one with no readable assertion is weaker too, and only an empty or disabled one is equivalent', () => {
    const body = `  await expect(page.getByText('Pay')).toBeVisible()`
    const kept = spec(body, 'kept')
    expect(summary(diff(`${kept}\n${spec(body, 'gone')}`, kept))).toEqual([
      'deleted:weaker gone',
      "  removed:weaker await expect(page.getByText('Pay')).toBeVisible() => -",
    ])
    // Helpers assert and actions fail: a live test with statements checks something
    // even when no expect is visible in it. The reason carries what the change list cannot.
    expect(diff(`${kept}\n${spec(`  await expectCartEmpty(page)`, 'helpers')}`, kept)).toEqual({
      verdict: 'weaker',
      tests: [{
        kind: 'deleted', name: 'helpers', verdict: 'weaker', changes: [],
        reason: 'a live test with no readable assertion was deleted; what its helpers and actions checked is gone',
      }],
    })
    // An empty callback never enforced anything, and neither did a test a modifier had
    // already disabled: deleting either changes no proof.
    expect(diff(`${kept}\n${spec('', 'empty')}`, kept)).toEqual({
      verdict: 'equivalent',
      tests: [{ kind: 'deleted', name: 'empty', verdict: 'equivalent', changes: [] }],
    })
    expect(diff(`${kept}\n${spec(`  await expectCartEmpty(page)`, 'off', 'test.skip')}`, kept).verdict).toBe('equivalent')
  })

  it('flags test.skip / test.fixme / test.fail: a disabled test enforces nothing', () => {
    const body = `  await expect(page.getByText('Pay')).toBeVisible()`
    for (const declare of ['test.skip', 'test.fixme', 'test.fail']) {
      const result = diff(spec(body), spec(body, 'checkout', declare))
      expect(result.verdict, declare).toBe('weaker')
      expect(summary(result), declare).toEqual([
        'disabled:weaker checkout',
        "  removed:weaker await expect(page.getByText('Pay')).toBeVisible() => -",
      ])
    }
    // Disabled on both sides: nothing changed about what is proven.
    expect(diff(spec(body, 'checkout', 'test.skip'), spec(body, 'checkout', 'test.fixme'))).toEqual({ verdict: 'equivalent', tests: [] })
  })

  it('flags test.only: the other tests in the file stop running', () => {
    const a = spec(`  await expect(page.getByText('A')).toBeVisible()`, 'a')
    const b = spec(`  await expect(page.getByText('B')).toBeVisible()`, 'b')
    const bOnly = spec(`  await expect(page.getByText('B')).toBeVisible()`, 'b', 'test.only')
    expect(diff(`${a}\n${b}`, `${a}\n${bOnly}`)).toEqual({
      verdict: 'weaker',
      tests: [],
      reasons: ['test.only limits the run to 1 of 2 tests'],
    })
    // `only` on both sides: the run is equally narrowed; nothing changed.
    expect(diff(`${a}\n${bOnly}`, `${a}\n${bOnly}`)).toEqual({ verdict: 'equivalent', tests: [] })
  })
})

describe('diffSpecPredicates — stronger', () => {
  it('flags an added assertion and an added test', () => {
    const body = `  await expect(page.getByText('Pay')).toBeVisible()`
    const result = diff(spec(body), `${spec(`${body}\n  await expect(page.getByTestId('total')).toHaveText('$1')`)}\n${spec(body, 'extra')}`)
    expect(result.verdict).toBe('stronger')
    expect(summary(result)).toEqual([
      'changed:stronger checkout',
      "  added:stronger - => await expect(page.getByTestId('total')).toHaveText('$1')",
      'added:stronger extra',
      "  added:stronger - => await expect(page.getByText('Pay')).toBeVisible()",
    ])
  })

  it('flags an added live test whose assertions live in helpers, but not an added empty one', () => {
    const kept = spec(`  await expect(page.getByText('Pay')).toBeVisible()`, 'kept')
    expect(diff(kept, `${kept}\n${spec(`  await expectCartEmpty(page)`, 'helpers')}`)).toEqual({
      verdict: 'stronger',
      tests: [{
        kind: 'added', name: 'helpers', verdict: 'stronger', changes: [],
        reason: 'a live test with no readable assertion was added; what its helpers and actions check is new',
      }],
    })
    expect(diff(kept, `${kept}\n${spec('', 'empty')}`)).toEqual({
      verdict: 'equivalent',
      tests: [{ kind: 'added', name: 'empty', verdict: 'equivalent', changes: [] }],
    })
  })

  it('flags a matcher swapped for a stronger one, a re-enabled test, and a removed test.only', () => {
    const body = `  await expect(page.getByText('Pay')).toBeVisible()`
    expect(diff(spec(body), spec(`  await expect(page.getByText('Pay')).toHaveText('Pay')`)).verdict).toBe('stronger')
    expect(summary(diff(spec(body, 'checkout', 'test.skip'), spec(body)))).toEqual([
      'enabled:stronger checkout',
      "  added:stronger - => await expect(page.getByText('Pay')).toBeVisible()",
    ])
    const other = spec(body, 'other')
    expect(diff(`${spec(body, 'checkout', 'test.only')}\n${other}`, `${spec(body)}\n${other}`)).toEqual({
      verdict: 'stronger',
      tests: [],
      reasons: ['test.only removed; all 2 tests run again'],
    })
  })
})

describe('diffSpecPredicates — unclassifiable, never silently equivalent', () => {
  const total = (value: string) => spec(`  await expect(page.getByTestId('total')).toHaveText(${value})`)

  it('refuses a changed expected value at equal strength — the lattice cannot rank it', () => {
    const result = diff(total(`'$148.50'`), total(`'$0.00'`))
    expect(result.verdict).toBe('unclassifiable')
    expect(summary(result)).toEqual([
      'changed:unclassifiable checkout',
      "  reshaped:unclassifiable (expected value changed at equal strength) await expect(page.getByTestId('total')).toHaveText('$148.50') => await expect(page.getByTestId('total')).toHaveText('$0.00')",
    ])
  })

  it('refuses a polarity flip and a matcher change at equal strength', () => {
    const before = spec(`  await expect(page.getByText('Error')).toBeVisible()`)
    const flipped = diff(before, spec(`  await expect(page.getByText('Error')).not.toBeVisible()`))
    expect(flipped.tests[0].changes[0]).toMatchObject({ kind: 'reshaped', verdict: 'unclassifiable', reason: 'polarity flipped' })
    const swapped = diff(total(`'$1'`), spec(`  await expect(page.getByTestId('total')).toHaveValue('$1')`))
    expect(swapped.tests[0].changes[0]).toMatchObject({ kind: 'reshaped', verdict: 'unclassifiable', reason: 'matcher changed at equal strength' })
  })

  it('carries the lattice refusal when either side is unrankable', () => {
    const result = diff(total(`'$1'`), total('computedTotal'))
    expect(result.tests[0].changes[0]).toMatchObject({ verdict: 'unclassifiable', reason: 'expected value is computed at run time' })
    expect(diff(total('computedTotal'), total(`'$1'`)).tests[0].changes[0]).toMatchObject({ verdict: 'unclassifiable', reason: 'expected value is computed at run time' })
    expect(diff(total(`'$1'`), spec(`  await expect(page.getByTestId('total')).toBeCustom(1)`)).tests[0].changes[0].reason).toBe('unknown matcher toBeCustom')
  })

  it('refuses when an expect() the collector cannot read appears or disappears', () => {
    const before = spec(`  await expect(page.getByText('Pay')).toBeVisible()`)
    const after = spec(`  await expect(page.getByText('Pay')).toBeVisible()\n  expect(page.locator('#y'))`)
    expect(summary(diff(before, after))).toEqual([
      'changed:unclassifiable checkout',
      "  unreadable:unclassifiable (an assertion the collector cannot read was added) - => expect(page.locator('#y'))",
    ])
    expect(summary(diff(after, before))).toEqual([
      'changed:unclassifiable checkout',
      "  unreadable:unclassifiable (an assertion the collector cannot read was removed) expect(page.locator('#y')) => -",
    ])
  })

  it('ranks unclassifiable above stronger and below weaker when changes mix', () => {
    const base = spec(`  await expect(page.getByTestId('total')).toHaveText('$1')`)
    const plusUnknown = spec(`  await expect(page.getByTestId('total')).toHaveText('$2')\n  await expect(page.getByText('Pay')).toBeVisible()`)
    expect(diff(base, plusUnknown).verdict).toBe('unclassifiable')
    const minusPlusUnknown = spec(`  await expect(page.getByTestId('total')).toHaveText('$2')`)
    const twoBefore = spec(`  await expect(page.getByTestId('total')).toHaveText('$1')\n  await expect(page.getByText('Pay')).toBeVisible()`)
    expect(diff(twoBefore, minusPlusUnknown).verdict).toBe('weaker')
  })

  it('refuses a side that does not parse, naming the side', () => {
    const good = extractTestPredicatesFromSource('a.spec.ts', spec(`  await expect(page.getByText('Pay')).toBeVisible()`))
    const bad = extractTestPredicatesFromSource('a.spec.ts', undefined as unknown as string)
    expect(diffSpecPredicates(good, bad)).toMatchObject({ verdict: 'unclassifiable', tests: [], reasons: [expect.stringMatching(/^after side does not parse: /)] })
    expect(diffSpecPredicates(bad, good)).toMatchObject({ verdict: 'unclassifiable', tests: [], reasons: [expect.stringMatching(/^before side does not parse: /)] })
  })
})

describe('diffSpecPredicates — pairing tests by name', () => {
  it('pairs same-named tests in declaration order, as the dirty-spec key does', () => {
    const body = `  await expect(page.getByText('Pay')).toBeVisible()`
    const before = `${spec(body, 'dup')}\n${spec(`${body}\n  await expect(page.getByText('Ship')).toBeVisible()`, 'dup')}`
    const after = `${spec(body, 'dup')}\n${spec(body, 'dup')}`
    expect(summary(diff(before, after))).toEqual([
      'changed:weaker dup',
      "  removed:weaker await expect(page.getByText('Ship')).toBeVisible() => -",
    ])
  })

  it('lists added tests in declaration order even when a name repeats', () => {
    const body = `  await expect(page.getByText('Pay')).toBeVisible()`
    const after = `${spec(body, 'dup')}\n${spec(body, 'solo')}\n${spec(body, 'dup')}`
    expect(diff(spec(body, 'dup'), after).tests.map((t) => `${t.kind}:${t.name}`)).toEqual(['added:solo', 'added:dup'])
  })
})

describe('diffPredicateSets', () => {
  it('diffs two bare predicate sets — the per-test core the spec diff is built on', () => {
    const [before] = extractTestPredicatesFromSource('a.spec.ts', spec(`  await expect(page.getByText('Pay')).toBeVisible()`)).tests
    expect(diffPredicateSets(before, { predicates: [] })).toMatchObject({ verdict: 'weaker', changes: [{ kind: 'removed' }] })
    expect(diffPredicateSets({ predicates: [] }, before)).toMatchObject({ verdict: 'stronger', changes: [{ kind: 'added' }] })
    expect(diffPredicateSets(before, before)).toEqual({ verdict: 'equivalent', changes: [] })
  })
})

describe('diffSpecPredicates — run-time guards', () => {
  it('flags a test.skip(cond) added inside a body: the test sits out whenever it fires', () => {
    const before = spec(`  await expect(page.getByText('ok')).toBeVisible()`)
    const after = spec(`  test.skip(!process.env.CREDS, 'needs credentials')\n  await expect(page.getByText('ok')).toBeVisible()`)
    const result = diff(before, after)
    expect(result.verdict).toBe('weaker')
    expect(summary(result)).toEqual([
      'changed:weaker checkout',
      "  guarded:weaker - => test.skip(!process.env.CREDS, 'needs credentials')",
    ])
  })

  it('flags a guard removed as stronger, cancels one kept, and ignores a reworded reason', () => {
    const before = spec(`  test.fixme(flaky)\n  test.skip(!a, 'x')\n  expect(1).toBe(1)`)
    const after = spec(`  test.fixme(flaky, 'still flaky')\n  expect(1).toBe(1)`)
    const result = diff(before, after)
    expect(result.verdict).toBe('stronger')
    expect(summary(result)).toEqual([
      'changed:stronger checkout',
      "  unguarded:stronger test.skip(!a, 'x') => -",
    ])
  })

  it('reads a guard whose condition changed as removed + added, which rolls up weaker', () => {
    const before = spec(`  test.skip(!a, 'x')\n  expect(1).toBe(1)`)
    const after = spec(`  test.skip(!a || !b, 'x')\n  expect(1).toBe(1)`)
    expect(summary(diff(before, after))).toEqual([
      'changed:weaker checkout',
      "  unguarded:stronger test.skip(!a, 'x') => -",
      "  guarded:weaker - => test.skip(!a || !b, 'x')",
    ])
  })

  it('reads a bare test.skip() / test.fixme() like a declaration modifier: the test enforces nothing', () => {
    const live = spec(`  expect(1).toBe(1)`)
    const silenced = spec(`  test.fixme()\n  expect(1).toBe(1)`)
    expect(summary(diff(live, silenced))).toEqual(['disabled:weaker checkout', '  removed:weaker expect(1).toBe(1) => -'])
    expect(summary(diff(silenced, live))).toEqual(['enabled:stronger checkout', '  added:stronger - => expect(1).toBe(1)'])
  })

  it('reaches every test under a describe-level guard, one entry per test', () => {
    const wrap = (guard: string) => `test.describe('suite', () => {\n${guard}\n  test('a', async () => { expect(1).toBe(1) })\n  test('b', async () => { expect(2).toBe(2) })\n})`
    const result = diff(wrap(''), wrap(`  test.skip(!process.env.CREDS, 'needs credentials')`))
    expect(result.verdict).toBe('weaker')
    expect(summary(result)).toEqual([
      'changed:weaker a',
      "  guarded:weaker - => test.skip(!process.env.CREDS, 'needs credentials')",
      'changed:weaker b',
      "  guarded:weaker - => test.skip(!process.env.CREDS, 'needs credentials')",
    ])
    expect(result.reasons).toBeUndefined()
  })

  it('does not read a guard on a new or re-enabled test as a weakening — there was nothing to weaken', () => {
    const before = `test.skip('a', async () => { expect(1).toBe(1) })`
    const after = `test('a', async () => { test.skip(!creds, 'needs creds'); expect(1).toBe(1) })\ntest.describe('new', () => {\n  test.skip(!creds, 'needs creds')\n  test('b', async () => { expect(2).toBe(2) })\n  test('c', async () => { test.skip() })\n})`
    const result = diff(before, after)
    expect(result.verdict).toBe('stronger')
    expect(summary(result)).toEqual([
      'enabled:stronger a',
      '  added:stronger - => expect(1).toBe(1)',
      'added:stronger b',
      '  added:stronger - => expect(2).toBe(2)',
      'added:equivalent c',
    ])
    // The mirror image: deleting or disabling a guarded test is a removal, not a lifted guard.
    expect(summary(diff(after, before))).toEqual([
      'disabled:weaker a',
      '  removed:weaker expect(1).toBe(1) => -',
      'deleted:weaker b',
      '  removed:weaker expect(2).toBe(2) => -',
      'deleted:equivalent c',
    ])
  })

  it('counts a guard on a live test whose assertions all live in helpers — no direct expect is not no test', () => {
    // Pilot pair 58ae6f0af517a649: `test.skip(!entry, …)` lifted from tests that assert
    // only through `expectVoucherInList(page, …)`. The test still runs; the guard still gates it.
    const guarded = spec(`  test.skip(!entry, 'fixture missing')\n  await expectVoucherInList(page, entry.code)`)
    const live = spec(`  await expectVoucherInList(page, entry.code)`)
    expect(summary(diff(guarded, live))).toEqual(['changed:stronger checkout', "  unguarded:stronger test.skip(!entry, 'fixture missing') => -"])
    expect(summary(diff(live, guarded))).toEqual(['changed:weaker checkout', "  guarded:weaker - => test.skip(!entry, 'fixture missing')"])
  })

  it('ignores guards inside a test that a declaration modifier already disables', () => {
    const before = spec(`  test.skip(!a)\n  expect(1).toBe(1)`, 'checkout', 'test.skip')
    const after = spec(`  expect(1).toBe(1)`, 'checkout', 'test.skip')
    expect(diff(before, after)).toEqual({ verdict: 'equivalent', tests: [] })
  })
})

describe('diffSpecPredicates — the corpus gaps L6, L7, L8', () => {
  it('reads a dropped element of a loop-declared test as a deleted test (L6)', () => {
    const loop = (keys: string): string => `const sadKeys = [${keys}] as const
test.describe('sad paths', () => {
  for (const key of sadKeys) {
    test(\`rejects \${key} with error toast\`, async ({ page }) => {
      await redeemCode(page, key)
      await expectErrorToast(page)
    })
  }
})`
    const result = diff(loop(`'expired', 'minSpendNotMet', 'invalidCode'`), loop(`'expired', 'invalidCode'`))
    expect(result.verdict).toBe('weaker')
    expect(result.tests.map((t) => `${t.kind}:${t.verdict} ${t.name}`)).toEqual(['deleted:weaker rejects minSpendNotMet with error toast'])
    // The other direction is a strengthening, and a reordered set changes nothing.
    expect(diff(loop(`'expired'`), loop(`'expired', 'invalidCode'`)).verdict).toBe('stronger')
    expect(diff(loop(`'a', 'b'`), loop(`'b', 'a'`))).toEqual({ verdict: 'equivalent', tests: [] })
  })

  it('reads a formatter pass — quotes, wrapping, semicolons, trailing commas — as equivalent (L7)', () => {
    const before = `test('checkout', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Pay' })).toHaveText('Pay now', { timeout: 5_000 })
  expect(body).toEqual({ items: [1, 2], total: 3 })
  test.skip(process.env.CI === 'true', 'flaky on CI')
})`
    const after = `test("checkout", async ({ page }) => {
  await expect(
    page.getByRole("button", {
      name: "Pay",
    }),
  ).toHaveText("Pay now", { timeout: 5000 });
  expect(body).toEqual({
    items: [1, 2],
    total: 3,
  });
  test.skip(process.env.CI === "true", "flaky on CI");
});`
    expect(diff(before, after)).toEqual({ verdict: 'equivalent', tests: [] })
  })

  it('reads an `it` suite test by test instead of as one opaque file (L8)', () => {
    const suite = (extra: string): string => `import { describe, it, expect } from 'vitest'
describe('sum', () => {
  it('adds', () => { expect(sum(1, 2)).toBe(3)${extra} })
  it('is commutative', () => { expect(sum(2, 1)).toBe(sum(1, 2)) })
})`
    expect(summary(diff(suite(`; expect(sum(0, 0)).toBe(0)`), suite('')))).toEqual([
      'changed:weaker adds',
      '  removed:weaker expect(sum(0, 0)).toBe(0) => -',
    ])
  })
})
