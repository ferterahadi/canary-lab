import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { renderActionStatement } from './actions'

function actionFrom(source: string) {
  const sourceFile = ts.createSourceFile('actions.ts', `async function scenario() { ${source} }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements[0]
  if (!ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error('Expected a function body')
  return renderActionStatement(declaration.body.statements[0], sourceFile)
}

describe('Playwright action rendering', () => {
  it('renders navigation, interaction, upload, keyboard, and waits', () => {
    const cases: Array<[string, string]> = [
      ["await page.goto('/checkout')", 'Open “/checkout”'],
      ["await page.getByLabel('Email').fill('ada@example.com')", 'Enter “ada@example.com” in the control labelled “Email”'],
      ["await page.getByRole('button', { name: 'Pay now' }).click()", 'Click the “Pay now” button'],
      ["await page.getByLabel('Receipt').setInputFiles('receipt.pdf')", 'Upload “receipt.pdf” using the control labelled “Receipt”'],
      ["await page.keyboard.press('Enter')", 'Press “Enter” with the keyboard'],
      ["await page.waitForURL('/orders/confirmed')", 'Wait for the page URL to match “/orders/confirmed”'],
    ]

    for (const [source, text] of cases) {
      expect(actionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'action' })
    }
  })

  it('renders API requests and setup calls', () => {
    expect(actionFrom("const response = await request.post('/api/orders', { data: { plan: 'team' } })")).toEqual({
      text: 'Send a POST request to “/api/orders” using an object with data set to an object with plan set to “team”',
      fidelity: 'derived',
      role: 'action',
    })
    expect(actionFrom("await page.route('**/orders', async route => route.fulfill({ status: 200 }))")).toEqual({
      text: 'Intercept requests matching “**/orders” using the authored route handler',
      fidelity: 'derived',
      role: 'setup',
    })
    expect(actionFrom("test.skip(!process.env.E2E_USER, 'missing user')")).toEqual({
      text: 'Skip this scenario when process environment e2e user is missing — “missing user”',
      fidelity: 'derived',
      role: 'setup',
    })
    expect(actionFrom('const startedAt = new Date()')).toEqual({
      text: 'Record the start time',
      fidelity: 'derived',
      role: 'action',
    })
  })

  it('leaves computed and unsupported calls for the unresolved fallback', () => {
    expect(actionFrom('await page[method](targetFromEnvironment())')).toBeUndefined()
    expect(actionFrom("await page.getByRole('button', { name: /pay/i }).click()")).toEqual({
      text: 'Click the /pay/i button',
      fidelity: 'derived',
      role: 'action',
    })
  })
})
