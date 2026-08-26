import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { renderLocator } from './locator'

function locatorFrom(source: string) {
  const sourceFile = ts.createSourceFile('locator.ts', `const target = ${source}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const statement = sourceFile.statements[0]
  if (!ts.isVariableStatement(statement)) throw new Error('Expected a variable statement')
  const locator = statement.declarationList.declarations[0].initializer
  if (!locator) throw new Error('Expected a locator initializer')
  return { locator, sourceFile }
}

describe('Playwright locator rendering', () => {
  it('renders the supported semantic locator methods', () => {
    const cases: Array<[string, string]> = [
      ["page.getByRole('button', { name: 'Pay now' })", 'the “Pay now” button'],
      ["page.getByLabel('Email')", 'the control labelled “Email”'],
      ["page.getByText('Payment accepted')", 'the text “Payment accepted”'],
      ["page.getByTestId('account-name')", 'the element with test ID “account-name”'],
      ["page.getByPlaceholder('Search')", 'the field with placeholder “Search”'],
      ["page.locator('#checkout button[type=submit]')", 'the element matching “#checkout button[type=submit]”'],
    ]

    for (const [source, text] of cases) {
      const parsed = locatorFrom(source)
      expect(renderLocator(parsed.locator, parsed.sourceFile)).toEqual({ text, fidelity: 'derived' })
    }
  })

  it('keeps exact, role-state, scope, and position semantics', () => {
    const exact = locatorFrom("dialog.getByRole('heading', { name: 'Checkout', exact: true, level: 2 })")
    expect(renderLocator(exact.locator, exact.sourceFile)).toEqual({
      text: 'the “Checkout” heading at level 2 using an exact match inside dialog',
      fidelity: 'derived',
    })

    const positioned = locatorFrom("page.getByText('Retry').nth(2)")
    expect(renderLocator(positioned.locator, positioned.sourceFile)).toEqual({
      text: 'the match at zero-based index 2 for the text “Retry”',
      fidelity: 'derived',
    })
  })

  it('falls back to exact source when a locator option is unsafe to summarize', () => {
    const parsed = locatorFrom("page.getByRole('button', { name: /pay/i, customState })")
    expect(renderLocator(parsed.locator, parsed.sourceFile)).toEqual({
      text: "page.getByRole('button', { name: /pay/i, customState })",
      fidelity: 'unresolved',
    })
  })

  it('does not claim unrelated calls are locators', () => {
    const parsed = locatorFrom('service.findAccount()')
    expect(renderLocator(parsed.locator, parsed.sourceFile)).toBeUndefined()
  })
})
