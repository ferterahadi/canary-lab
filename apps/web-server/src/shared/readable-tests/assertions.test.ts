import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { renderAssertionStatement } from './assertions'

function assertionFrom(source: string) {
  const sourceFile = ts.createSourceFile('assertions.ts', `async function scenario() { ${source} }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements[0]
  if (!ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error('Expected a function body')
  return renderAssertionStatement(declaration.body.statements[0], sourceFile)
}

describe('Playwright assertion rendering', () => {
  it('preserves the matcher target and expected value', () => {
    const cases: Array<[string, string]> = [
      ["await expect(page).toHaveURL('/orders/confirmed')", 'Check that the page URL equals “/orders/confirmed”'],
      ["await expect(page.getByText('Payment accepted')).toBeVisible()", 'Check that the text “Payment accepted” is visible'],
      ["await expect(page.getByLabel('Email')).toHaveValue('ada@example.com')", 'Check that the control labelled “Email” has value “ada@example.com”'],
      ['expect(response.status()).toBe(201)', 'Check that response status equals 201'],
      ['expect(items).toHaveCount(3)', 'Check that items has count 3'],
    ]
    for (const [source, text] of cases) {
      expect(assertionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'check' })
    }
  })

  it('preserves negation, soft checks, messages, and matcher options', () => {
    expect(assertionFrom("await expect(page.getByText('Error')).not.toBeVisible() ")).toEqual({
      text: 'Check that the text “Error” is not visible',
      fidelity: 'derived',
      role: 'check',
    })
    expect(assertionFrom("await expect.soft(page.getByTestId('name'), 'account name').toHaveText('Ada', { timeout: 500 })")).toEqual({
      text: 'Soft-check that the element with test ID “name” has text “Ada” using an object with timeout set to 500 with message “account name”',
      fidelity: 'derived',
      role: 'check',
    })
  })

  it('keeps unknown matcher source instead of inventing semantics', () => {
    expect(assertionFrom('expect(order).toSatisfyBusinessRule(rule)')).toEqual({
      text: 'expect(order).toSatisfyBusinessRule(rule)',
      fidelity: 'unresolved',
      role: 'check',
    })
  })
})
