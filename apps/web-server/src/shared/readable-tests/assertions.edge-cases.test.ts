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
      'expect(loadTotal()).toBe(2)',
      'expect(total).toBe(loadExpected())',
      'expect(total).toBe(2, loadOptions())',
      "expect(total, loadMessage()).toBe(2)",
      'expect(response.status(1)).toBe(200)',
      'expect(response.headers()).toBeDefined()',
    ]

    for (const source of sources) {
      expect(assertionFrom(source)).toEqual({ text: source, fidelity: 'unresolved', role: 'check' })
    }
  })
})
