import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { renderActionStatement } from './actions'

function actionFrom(source: string) {
  const sourceFile = ts.createSourceFile('actions.ts', `async function scenario() { ${source} }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements[0]
  if (!ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error('Expected a function body')
  return renderActionStatement(declaration.body.statements[0], sourceFile)
}

function unresolved(source: string) {
  expect(actionFrom(source)).toEqual({
    text: source.replace(/^await /, ''),
    fidelity: 'unresolved',
    role: 'unknown',
  })
}

describe('Playwright action edge cases', () => {
  it('renders all navigation shapes and their safe options', () => {
    const cases: Array<[string, string]> = [
      ["await page.goBack({ waitUntil: 'load' })", 'Go back to the previous page using an object with wait until set to “load”'],
      ['await page.goForward()', 'Go forward to the next page'],
      ['return page.reload()', 'Reload the page'],
      ['await page.waitForLoadState()', 'Wait for the page to finish loading'],
      ["await page.waitForLoadState('networkidle', { timeout: 500 })", 'Wait for the page to reach “networkidle” using an object with timeout set to 500'],
      ["await page.goto('/checkout', { waitUntil: 'domcontentloaded' })", 'Open “/checkout” using an object with wait until set to “domcontentloaded”'],
      ["await page.waitForURL('/orders', { timeout: 500 })", 'Wait for the page URL to match “/orders” using an object with timeout set to 500'],
    ]
    for (const [source, text] of cases) {
      expect(actionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'action' })
    }

    for (const source of [
      'await page.reload(loadOptions())',
      'await page.waitForLoadState(loadState())',
      "await page.waitForLoadState('load', loadOptions())",
      'await page.goto()',
      'await page.goto(loadURL())',
      "await page.goto('/checkout', loadOptions())",
    ]) unresolved(source)
  })

  it('renders direct-page and locator interactions without hiding values', () => {
    const cases: Array<[string, string]> = [
      ["await page.click('#pay')", 'Click the element matching “#pay”'],
      ["await page.getByText('Pay').dblclick()", 'Double-click the text “Pay”'],
      ["await page.getByText('Pay').tap()", 'Tap the text “Pay”'],
      ["await page.getByText('Pay').hover()", 'Point at the text “Pay”'],
      ["await page.getByText('Pay').focus()", 'Focus the text “Pay”'],
      ["await page.getByText('Pay').clear()", 'Clear the text “Pay”'],
      ["await page.getByText('Pay').check()", 'Check the text “Pay”'],
      ["await page.getByText('Pay').uncheck()", 'Uncheck the text “Pay”'],
      ["await page.getByLabel('Plan').selectOption('team')", 'Select “team” in the control labelled “Plan”'],
      ["await page.getByLabel('Upload').setInputFiles('file.pdf')", 'Upload “file.pdf” using the control labelled “Upload”'],
      ["await page.getByLabel('Search').press('Enter')", 'Press “Enter” on the control labelled “Search”'],
      ["await page.getByLabel('Search').pressSequentially('Ada')", 'Type “Ada” into the control labelled “Search”'],
      ["await page.getByLabel('Search').type('Ada', { delay: 10 })", 'Type “Ada” into the control labelled “Search” using an object with delay set to 10'],
    ]
    for (const [source, text] of cases) {
      expect(actionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'action' })
    }

    for (const source of [
      'await page.click()',
      'await page.click(loadSelector())',
      "await page.getByText('Pay').click(loadOptions())",
      "await page.getByLabel('Search').fill()",
      "await page.getByLabel('Search').fill(loadValue())",
    ]) unresolved(source)
  })

  it('renders keyboard and wait operations and preserves unsafe arguments', () => {
    const cases: Array<[string, string]> = [
      ["await page.keyboard.type('Ada')", 'Type “Ada” with the keyboard'],
      ["await page.keyboard.insertText('Ada', { delay: 10 })", 'Type “Ada” with the keyboard using an object with delay set to 10'],
      ["await page.getByText('Ready').waitFor({ state: 'visible' })", 'Wait for the text “Ready” using an object with state set to “visible”'],
      ['await page.waitForTimeout(250)', 'Wait for 250 milliseconds'],
      ["await page.waitForSelector('#ready', { state: 'visible' })", 'Wait for the element matching “#ready” using an object with state set to “visible”'],
      ["await page.waitForRequest('/orders')", 'Wait for the request matching “/orders”'],
      ["await page.waitForResponse('/orders', { timeout: 500 })", 'Wait for the response matching “/orders” using an object with timeout set to 500'],
    ]
    for (const [source, text] of cases) {
      expect(actionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'action' })
    }

    for (const source of [
      'await page.keyboard.press()',
      'await page.keyboard.press(loadKey())',
      "await page.keyboard.press('Enter', loadOptions())",
      "await page.getByRole('button', { custom: true }).waitFor()",
      "await page.getByText('Ready').waitFor(loadOptions())",
      'await page.waitForTimeout()',
      'await page.waitForResponse(loadMatcher())',
      "await page.waitForResponse('/orders', loadOptions())",
    ]) unresolved(source)
  })

  it('renders request clients, setup calls, and test controls', () => {
    const requestCases: Array<[string, string]> = [
      ["await request.get('/orders')", 'Send a GET request to “/orders”'],
      ["await api.post('/orders')", 'Send a POST request to “/orders”'],
      ["await apiRequest.put('/orders')", 'Send a PUT request to “/orders”'],
      ["await requestContext.patch('/orders')", 'Send a PATCH request to “/orders”'],
      ["await request.delete('/orders')", 'Send a DELETE request to “/orders”'],
      ["await request.head('/orders')", 'Send a HEAD request to “/orders”'],
      ["await request.fetch('/orders', { method: 'OPTIONS' })", 'Send a FETCH request to “/orders” using an object with method set to “OPTIONS”'],
    ]
    for (const [source, text] of requestCases) {
      expect(actionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'action' })
    }

    const setupCases: Array<[string, string]> = [
      ['await page.addInitScript(script)', 'Add a browser initialization script'],
      ["await page.unroute('**/orders')", 'Stop intercepting requests matching “**/orders”'],
      ["await page.setExtraHTTPHeaders({ authorization: 'token' })", 'Set extra HTTP headers to an object with authorization set to “token”'],
      ['await page.setViewportSize({ width: 800, height: 600 })', 'Set the browser viewport to an object with width set to 800, height set to 600'],
      ["await page.emulateMedia({ colorScheme: 'dark' })", 'Set browser media preferences to an object with color scheme set to “dark”'],
      ["await context.addCookies([{ name: 'session', value: 'abc' }])", 'Add cookies from a list containing an object with name set to “session”, value set to “abc”'],
      ["test.fixme(true, 'repair pending')", 'Mark this scenario as needing repair'],
      ["test.fail(true, 'known failure')", 'Expect this scenario to fail'],
      ['test.slow()', 'Allow extra time for this scenario'],
      ["test.use({ locale: 'en-SG' })", 'Configure test fixtures using an object with locale set to “en-SG”'],
    ]
    for (const [source, text] of setupCases) {
      expect(actionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'setup' })
    }

    for (const source of [
      'await request.get()',
      'await request.get(loadURL())',
      "await request.get('/orders', loadOptions())",
      'await page.route(loadPattern(), handler)',
      'await page.setViewportSize(loadViewport())',
      'test.use(loadFixtures())',
    ]) unresolved(source)
  })

  it('returns undefined for statements and receivers outside the rule table', () => {
    const sources = [
      'const first = run(), second = run()',
      'let result',
      'const created = new URL(url)',
      'runScenario()',
      'service.findAccount()',
      "suite.skip(true, 'not a Playwright test control')",
      "getPage().keyboard.press('Enter')",
      "getRequest().get('/orders')",
    ]
    for (const source of sources) expect(actionFrom(source)).toBeUndefined()

    expect(actionFrom('const startedAt = (new Date())')).toEqual({
      text: 'Record the start time',
      fidelity: 'derived',
      role: 'action',
    })
  })
})
