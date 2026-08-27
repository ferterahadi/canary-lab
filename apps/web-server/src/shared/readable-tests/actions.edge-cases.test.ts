import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { renderActionExpression, renderActionStatement } from './actions'

function actionFrom(source: string) {
  const sourceFile = ts.createSourceFile('actions.ts', `async function scenario() { ${source} }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements[0]
  if (!ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error('Expected a function body')
  return renderActionStatement(declaration.body.statements[0], sourceFile)
}

function expressionActionFrom(source: string) {
  const sourceFile = ts.createSourceFile('actions.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const statement = sourceFile.statements[0]
  if (!ts.isExpressionStatement(statement)) throw new Error('Expected an expression statement')
  return renderActionExpression(statement.expression, sourceFile)
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
      'await page.reload(computeOptions())',
      'await page.waitForLoadState(computeState())',
      "await page.waitForLoadState('load', computeOptions())",
      'await page.goto()',
      'await page.goto(computeURL())',
      "await page.goto('/checkout', computeOptions())",
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
      'await page.click(computeSelector())',
      "await page.getByText('Pay').click(computeOptions())",
      "await page.getByLabel('Search').fill()",
      "await page.getByLabel('Search').fill(computeValue())",
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
      'await page.keyboard.press(computeKey())',
      "await page.keyboard.press('Enter', computeOptions())",
      "await page.getByRole('button', { custom: true }).waitFor()",
      "await page.getByText('Ready').waitFor(computeOptions())",
      'await page.waitForTimeout()',
      'await page.waitForResponse(computeMatcher())',
      "await page.waitForResponse('/orders', computeOptions())",
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
      // Skip guards name the variable they depend on, never a generic sentence.
      ['test.skip()', 'Skip this scenario'],
      ['test.skip(flag)', 'Skip this scenario when flag'],
      ["test.skip(!token, 'LINE creds required')", 'Skip this scenario when token is missing — “LINE creds required”'],
      ['test.skip(!account.token)', 'Skip this scenario when account token is missing'],
      // Condition is a call, so only the authored reason can explain the skip.
      ["test.skip(!isSyncSqlConfigured(), 'sync sql not configured')", 'Skip this scenario — “sync sql not configured”'],
      ["test.fixme(true, 'repair pending')", 'Mark this scenario as needing repair'],
      ["test.fail(true, 'known failure')", 'Expect this scenario to fail'],
      ['test.slow()', 'Allow extra time for this scenario'],
      // A bare number gets its milliseconds unit; a named expression already
      // carries its meaning.
      ['test.setTimeout(300000)', 'Allow 300000 milliseconds for this scenario'],
      ['test.setTimeout(INTERACTIVE_TIMEOUT_MS + 60_000)', 'Allow interactive timeout ms plus 60000 for this scenario'],
      ["test.use({ locale: 'en-SG' })", 'Configure test fixtures using an object with locale set to “en-SG”'],
    ]
    for (const [source, text] of setupCases) {
      expect(actionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'setup' })
    }

    for (const source of [
      'await request.get()',
      'await request.get(computeURL())',
      "await request.get('/orders', computeOptions())",
      'await page.route(computePattern(), handler)',
      'await page.setViewportSize(computeViewport())',
      'test.use(computeFixtures())',
      'test.skip(computeCond())',
      'test.skip(!computeAccount().token)',
      'test.skip(flag, computeMsg())',
      'test.skip(computeCond(), someVar)',
      "test.skip(true, 'x', extra)",
      'test.setTimeout()',
      'test.setTimeout(300, extra)',
      'test.setTimeout(computeMs())',
    ]) unresolved(source)
  })

  it('renders zero-argument lifecycle calls as the verb applied to the receiver', () => {
    const cases: Array<[string, string]> = [
      ['await ctx.session.close()', 'Close the session'],
      ['callbackServer.start()', 'Start the callback server'],
      ['await callbackServer.stop()', 'Stop the callback server'],
      ['await client.disconnect()', 'Disconnect the client'],
      ['sink.dispose()', 'Dispose the sink'],
    ]
    for (const [source, text] of cases) {
      expect(actionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'action' })
    }

    // A computed receiver has no name to speak of.
    unresolved('getSession().close()')
    // An argument changes what the call does — naming just the verb would hide it.
    expect(actionFrom('session.close(force)')).toBeUndefined()
  })

  it('renders the bare-sleep Promise idiom and nothing looser', () => {
    expect(actionFrom('await new Promise((r) => setTimeout(r, 3000))'))
      .toEqual({ text: 'Delay for 3000 ms', fidelity: 'derived', role: 'action' })
    expect(actionFrom('await new Promise((resolve) => setTimeout(resolve, 10_000))'))
      .toEqual({ text: 'Delay for 10000 ms', fidelity: 'derived', role: 'action' })

    // Every guard in the shape check: a looser executor could be doing real work.
    for (const source of [
      'await new Promise',
      'await new Promise()',
      'await new Promise((r) => setTimeout(r, 100), extra)',
      'await new Promise(executorFn)',
      'await new Promise(() => setTimeout(done, 100))',
      'await new Promise((res, rej) => setTimeout(res, 100))',
      'await new Promise(({ resolve }) => setTimeout(resolve, 100))',
      'await new Promise((r) => { setTimeout(r, 100) })',
      'await new Promise((r) => r)',
      'await new Promise((r) => window.setTimeout(r, 100))',
      'await new Promise((r) => queueMicrotask(r))',
      'await new Promise((r) => setTimeout(r))',
      "await new Promise((r) => setTimeout(r, 100, 'x'))",
      'await new Promise((r) => setTimeout(done, 100))',
      'await new Promise((r) => setTimeout(r.bind(null), 100))',
      'await new Promise((r) => setTimeout(r, delayMs))',
      'await new lib.Promise((r) => setTimeout(r, 100))',
      'await new Deferred((r) => setTimeout(r, 100))',
    ]) expect(actionFrom(source)).toBeUndefined()
  })

  it('renders rethrows and authored error messages, leaving computed throws as source', () => {
    expect(actionFrom('throw error')).toEqual({ text: 'Rethrow the error', fidelity: 'derived', role: 'action' })
    expect(actionFrom("throw new Error('sync sql unreachable')"))
      .toEqual({ text: 'Fail with “sync sql unreachable”', fidelity: 'derived', role: 'action' })

    for (const source of [
      'throw new Error(`took ${elapsed}ms`)',
      'throw new Error',
      'throw new Error()',
      "throw new Error('a', { cause })",
      "throw new TypeError('x')",
      'throw makeError()',
      'throw payload.error',
    ]) expect(actionFrom(source)).toBeUndefined()
  })

  it('renders console output with every argument visible', () => {
    const cases: Array<[string, string]> = [
      ["console.log('sync complete')", 'Log “sync complete” to the console'],
      ['console.log()', 'Log an empty line to the console'],
      ["console.error('boom', code)", 'Log “boom” and code to the console'],
      ['console.warn(count)', 'Log count to the console'],
      ["console.info('ready')", 'Log “ready” to the console'],
      ["console.debug('trace')", 'Log “trace” to the console'],
    ]
    for (const [source, text] of cases) {
      expect(actionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'action' })
    }

    unresolved('console.log(computeValue())')
    expect(actionFrom("logger.log('x')")).toBeUndefined()
  })

  it('renders call-free declarations, assignments, deletes, and returns when both sides are readable', () => {
    const setupCases: Array<[string, string]> = [
      ['const total = base + 1', 'Set total to base plus 1'],
      ['const stamp = new Date(startedAt)', 'Set stamp to started at as a date'],
      // Method calls outside the action-rule tables still read as declarations
      // when the expression layer knows the call.
      ['const startedAt = Date.now()', 'Set started at to the current time'],
      ['const body = await res.json()', 'Set body to the JSON body of response'],
      ['const keys = Object.keys(account)', 'Set keys to the keys of account'],
    ]
    for (const [source, text] of setupCases) {
      expect(actionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'setup' })
    }

    const actionCases: Array<[string, string]> = [
      ['state.messageId = messageId', 'Set state message identifier to message identifier'],
      ['count += 1', 'Increase count by 1'],
      ['count -= step', 'Decrease count by step'],
      ['count *= 2', 'Multiply count by 2'],
      ['count /= divisor', 'Divide count by divisor'],
      ['count %= divisor', 'Set count to its remainder after division by divisor'],
      ['count **= exponent', 'Raise count to the power of exponent'],
      ['flags &= mask', 'Apply bitwise AND to flags using mask'],
      ['flags |= mask', 'Apply bitwise OR to flags using mask'],
      ['flags ^= mask', 'Apply bitwise XOR to flags using mask'],
      ['flags <<= bits', 'Shift flags left by bits'],
      ['flags >>= bits', 'Shift flags right by bits'],
      ['flags >>>= bits', 'Unsigned-shift flags right by bits'],
      ['result &&= fallback', 'Conditionally set result to fallback when its current value is true'],
      ['result ||= fallback', 'Conditionally set result to fallback when its current value is false'],
      ['result ??= fallback', 'Conditionally set result to fallback when its current value is null or undefined'],
      ['count++', 'Increase count by 1'],
      ['--count', 'Decrease count by 1'],
      ['delete payload.from', 'Remove “from” from payload'],
      ['delete payload[key]', 'Remove the property at key from payload'],
      // Zero-argument `new Date` (with or without parentheses) is the start-time idiom.
      ['const t0 = new Date', 'Record the start time'],
      ['return { res, elapsedMs }', 'Return an object with response, elapsed ms'],
      ['return total', 'Return total'],
      ['return res.text()', 'Return the text body of response'],
    ]
    for (const [source, text] of actionCases) {
      expect(actionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'action' })
    }

    const undefinedCases = [
      'const [first] = pair',
      'const method = methods[index++]',
      'delete computePayload().from',
      'delete payload[computeKey()]',
      'delete value',
      '+count',
      'payload.from = computeSender()',
      'computeTarget().enabled = true',
      'total',
      'return',
      'return computeValue() + 1',
    ]
    for (const source of undefinedCases) expect(actionFrom(source)).toBeUndefined()
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

  it('renders standalone action expressions for nested story branches', () => {
    expect(expressionActionFrom("page.goto('/orders')")).toEqual({
      text: 'Open “/orders”',
      fidelity: 'derived',
      role: 'action',
    })
    expect(expressionActionFrom('computeTarget().value++')).toBeUndefined()
    expect(expressionActionFrom('ready && submit()')).toBeUndefined()
  })
})
