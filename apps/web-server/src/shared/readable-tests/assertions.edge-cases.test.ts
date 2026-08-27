import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { renderAssertionStatement } from './assertions'

function assertionFrom(source: string) {
  const sourceFile = ts.createSourceFile('assertions.ts', `async function scenario() { ${source} }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements[0]
  if (!ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error('Expected a function body')
  return renderAssertionStatement(declaration.body.statements[0], sourceFile)
}

describe('Playwright assertion edge cases', () => {
  it('renders state, truth, value, and comparison negation literally', () => {
    const cases: Array<[string, string]> = [
      ['expect(control).toBeEnabled()', 'Check that control is enabled'],
      ['expect(control).not.toBeEnabled()', 'Check that control is not enabled'],
      ['expect(value).toBeTruthy()', 'Check that value is true'],
      ['expect(value).not.toBeTruthy()', 'Check that value is false'],
      ["expect(items).not.toContain('archived')", 'Check that items does not contain “archived”'],
      ['expect(total).toBeGreaterThan(2)', 'Check that total is greater than 2'],
      ['expect(total).not.toBeGreaterThan(2)', 'Check that total is not greater than 2'],
    ]

    for (const [source, text] of cases) {
      expect(assertionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'check' })
    }
  })

  it('names page and non-page URL and title subjects without losing the receiver', () => {
    const cases: Array<[string, string]> = [
      ["expect(response).not.toHaveURL('/orders')", 'Check that response URL does not equal “/orders”'],
      ["expect(page).toHaveTitle('Orders')", 'Check that the page title equals “Orders”'],
      ["expect(response).not.toHaveTitle('Orders')", 'Check that response title does not equal “Orders”'],
      ["expect(response.url()).toBe('/orders')", 'Check that response URL equals “/orders”'],
      ['expect(response.ok()).toBeTruthy()', 'Check that whether response is successful is true'],
    ]

    for (const [source, text] of cases) {
      expect(assertionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'check' })
    }
  })

  it('renders shape, length, and instance matchers literally', () => {
    const cases: Array<[string, string]> = [
      ['expect(list).toHaveLength(3)', 'Check that list has length 3'],
      ['expect(list).not.toHaveLength(3)', 'Check that list does not have length 3'],
      ['expect(rows).toContainEqual(row)', 'Check that rows contains an item equal to row'],
      ['expect(rows).not.toContainEqual(row)', 'Check that rows does not contain an item equal to row'],
      ['expect(res.data).toMatchObject({ id: 1 })', 'Check that response data includes an object with identifier set to 1'],
      ['expect(res.data).not.toMatchObject({ id: 1 })', 'Check that response data does not include an object with identifier set to 1'],
      // The class argument keeps its authored casing — `Date`, never "date".
      ['expect(row.deliveredAt).toBeInstanceOf(Date)', 'Check that row delivered at is an instance of Date'],
      ['expect(value).not.toBeInstanceOf(Date)', 'Check that value is not an instance of Date'],
      ['expect(value).toBeInstanceOf(errors.TimeoutError)', 'Check that value is an instance of errors timeout error'],
    ]

    for (const [source, text] of cases) {
      expect(assertionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'check' })
    }
  })

  it('supports returned and parenthesized expectation calls', () => {
    expect(assertionFrom('return expect(total).toBe(2)')).toEqual({
      text: 'Check that total equals 2',
      fidelity: 'derived',
      role: 'check',
    })
    expect(assertionFrom('(expect(total).toBe(2))')).toEqual({
      text: 'Check that total equals 2',
      fidelity: 'derived',
      role: 'check',
    })
  })

  it('returns undefined when a statement is not an expectation', () => {
    const sources = [
      'const total = 2',
      'total',
      'expect(total)',
      'expect.not.toBe(2)',
      'factory(total).toBe(2)',
      'expect().toBe(2)',
    ]

    for (const source of sources) {
      expect(assertionFrom(source)).toBeUndefined()
    }
  })

  it('uses exact source for unsupported or unsafe expectation semantics', () => {
    const sources = [
      'expect(order).toMatchRule(rule)',
      'expect(total).toBe()',
      'expect(computeTotal()).toBe(2)',
      'expect(total).toBe(computeExpected())',
      'expect(total).toBe(2, computeOptions())',
      'expect(response.status(1)).toBe(200)',
      'expect(response.headers()).toBeDefined()',
    ]

    for (const source of sources) {
      expect(assertionFrom(source)).toEqual({ text: source, fidelity: 'unresolved', role: 'check' })
    }
  })

  it('keeps a proven assertion when only its diagnostic message is dynamic', () => {
    expect(assertionFrom('expect(total, computeMessage()).toBe(2)')).toEqual({
      text: 'Check that total equals 2',
      fidelity: 'derived',
      role: 'check',
    })
    expect(assertionFrom('expect(allSms.length, JSON.stringify(allSms.map((sms) => sms.body))).toBe(1)')).toEqual({
      text: 'Check that all sms length equals 1',
      fidelity: 'derived',
      role: 'check',
    })
  })
})
