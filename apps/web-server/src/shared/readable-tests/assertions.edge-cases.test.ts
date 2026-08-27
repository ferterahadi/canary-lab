import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { renderAssertionStatement, renderGenericAssertionStatement } from './assertions'

function assertionFrom(source: string) {
  const sourceFile = ts.createSourceFile('assertions.ts', `async function scenario() { ${source} }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements[0]
  if (!ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error('Expected a function body')
  return renderAssertionStatement(declaration.body.statements[0], sourceFile)
}

function genericAssertionFrom(source: string) {
  const sourceFile = ts.createSourceFile('assertions.ts', `async function scenario() { ${source} }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = sourceFile.statements[0]
  if (!ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error('Expected a function body')
  return renderGenericAssertionStatement(declaration.body.statements[0], sourceFile)
}

describe('Playwright assertion edge cases', () => {
  it('renders state, truth, value, and comparison negation literally', () => {
    const cases: Array<[string, string]> = [
      ['expect(control).toBeEnabled()', 'Check that control is enabled'],
      ['expect(control).not.toBeEnabled()', 'Check that control is not enabled'],
      ['expect(value).toBeTruthy()', 'Check that value is true'],
      ['expect(value).not.toBeTruthy()', 'Check that value is false'],
      ["expect(items).not.toContain('archived')", 'Check that items does not contain “archived”'],
      ['expect([401, 403]).not.toContain(res.status())', 'Check that a list containing 401, 403 does not contain response status'],
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

  it('keeps safely named call results as assertion subjects', () => {
    const cases: Array<[string, string]> = [
      ['expect(isCleanExit(exit)).toBe(true)', 'Check that is clean exit result using exit equals true'],
      ['expect(consumer.logs()).toContain(DRAIN_COMPLETE_MARKER)', 'Check that logs result from consumer contains drain complete marker'],
      ['expect(response.headers()).toBeDefined()', 'Check that headers result from response is defined'],
      ['expect(service.read(id)).toBeDefined()', 'Check that read result from service using identifier is defined'],
      ['expect(response.status(1)).toBe(200)', 'Check that status result from response using 1 equals 200'],
    ]

    for (const [source, text] of cases) {
      expect(assertionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'check' })
    }

    for (const source of [
      'expect(computeTotal()).toBe(2)',
      'expect(factory().logs()).toBeDefined()',
      'expect(service.read(computeId())).toBeDefined()',
      'expect(service?.read(id)).toBeDefined()',
    ]) {
      expect(assertionFrom(source)).toEqual({ text: source, fidelity: 'unresolved', role: 'check' })
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
      'expect(total).toBe()',
      'expect(computeTotal()).toBe(2)',
      'expect(total).toBe(computeExpected())',
      'expect(total).toBe(2, computeOptions())',
    ]

    for (const source of sources) {
      expect(assertionFrom(source)).toEqual({ text: source, fidelity: 'unresolved', role: 'check' })
    }
  })

  it('keeps safe custom and asynchronous expectation chains visible', () => {
    const customCases: Array<[string, string]> = [
      ['expect(order).toMatchRule(rule)', 'Check that order passes the “match rule” check using rule'],
      ["expect.soft(order, 'business rule').not.toMatchRule(rule)", 'Soft-check that order does not pass the “match rule” check using rule with message “business rule”'],
    ]
    for (const [source, text] of customCases) {
      expect(genericAssertionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'check' })
    }

    const asynchronousCases: Array<[string, string]> = [
      ["await expect(requestPromise).resolves.toBe('READY')", 'Check that the resolved value of request promise equals “READY”'],
      ['await expect(requestPromise).resolves.not.toBeNull()', 'Check that the resolved value of request promise is not null'],
      ['expect(requestPromise).rejects.toThrow(TypeError)', 'Check that the rejection from request promise is an error of type TypeError'],
      ['expect(callbackPromise).resolves.toThrow(TypeError)', 'Check that the resolved value of callback promise throws an error of type TypeError'],
      ['expect(callbackPromise).resolves.not.toThrow()', 'Check that the resolved value of callback promise does not throw an error'],
    ]

    for (const [source, text] of asynchronousCases) {
      expect(assertionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'check' })
    }

    expect(genericAssertionFrom('expect(order).toMatchRule(computeRule())')).toEqual({
      text: 'expect(order).toMatchRule(computeRule())',
      fidelity: 'unresolved',
      role: 'check',
    })
  })

  it('rejects malformed chains and unsafe thrown-operation descriptions', () => {
    for (const source of [
      'expect(value).matcher.toBe(1)',
      'expect(value).not.not.toBe(1)',
      'expect(value).resolves.rejects.toBe(1)',
    ]) {
      expect(assertionFrom(source)).toBeUndefined()
    }

    for (const source of [
      'expect(() => computeService().run()).toThrow()',
      'expect(() => run(computeArgument())).toThrow()',
      'expect(() => service[method]()).toThrow()',
      'expect(computePromise()).rejects.toThrow()',
      'expect(computePromise()).resolves.toThrow()',
    ]) {
      expect(assertionFrom(source)).toEqual({ text: source, fidelity: 'unresolved', role: 'check' })
    }

    expect(assertionFrom('expect(((() => run()) as Callback)!).toThrow()')).toEqual({
      text: 'Check that calling run throws an error',
      fidelity: 'derived',
      role: 'check',
    })
    expect(assertionFrom('expect(() => { return (run()) }).toThrow()')).toEqual({
      text: 'Check that calling run throws an error',
      fidelity: 'derived',
      role: 'check',
    })
    expect(assertionFrom('expect(() => { return }).toThrow()')).toEqual({
      text: 'Check that the provided operation throws an error',
      fidelity: 'derived',
      role: 'check',
    })
    expect(assertionFrom('expect(() => { throw failure }).toThrow()')).toEqual({
      text: 'Check that the provided operation throws an error',
      fidelity: 'derived',
      role: 'check',
    })
    expect(assertionFrom('expect(requestPromise).rejects.not.toThrow()')).toEqual({
      text: 'Check that the rejection from request promise is not an error',
      fidelity: 'derived',
      role: 'check',
    })

    expect(genericAssertionFrom('const value = 1')).toBeUndefined()
    expect(genericAssertionFrom('verify(value)')).toBeUndefined()
    expect(genericAssertionFrom('expect(value).toBe(1)')).toBeUndefined()
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

  it('renders collection predicate checks without dropping their callback condition', () => {
    const cases: Array<[string, string]> = [
      [
        "expect(msgs.every((m) => m.pattern === 'TRIGGER_EMAIL_BATCH')).toBe(true)",
        'Check that for every item in msgs, item pattern equals “TRIGGER_EMAIL_BATCH”',
      ],
      [
        'expect(msgs.every((m) => (m as TriggerBatchMessage).data.emailInfo.transactionId === txId)).toBe(true)',
        'Check that for every item in msgs, item data email info transaction identifier equals txId',
      ],
      [
        "expect(rows.some((row) => row.status === 'FAILED')).toBeFalsy()",
        'Check that it is false that for at least one item in rows, item status equals “FAILED”',
      ],
      [
        'expect((rows.every((row) => row.ready)) as boolean).not.toEqual(false)',
        'Check that for every item in rows, item ready',
      ],
      [
        'expect(Array.isArray(payload.redirect_uris)).toBe(true)',
        'Check that payload redirect uris is a list',
      ],
      [
        'expect(Array.isArray(payload.contacts)).toBe(false)',
        'Check that it is false that payload contacts is a list',
      ],
    ]

    for (const [source, text] of cases) {
      expect(assertionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'check' })
    }
  })

  it('renders property and thrown-error checks instead of dropping them from the story', () => {
    const cases: Array<[string, string]> = [
      ["expect(account).toHaveProperty('id')", 'Check that account has property “id”'],
      ["expect(account).not.toHaveProperty('id')", 'Check that account does not have property “id”'],
      ["expect(account).toHaveProperty('status', 'READY')", 'Check that account has property “status” equal to “READY”'],
      ["expect.soft(account, 'account shape').not.toHaveProperty(['private', 'token'], secret)", 'Soft-check that account does not have property a list containing “private”, “token” equal to secret with message “account shape”'],
      ['expect(() => run()).toThrow()', 'Check that calling run throws an error'],
      ["expect(() => parse(value)).not.toThrow('invalid')", 'Check that calling parse using value does not throw an error matching “invalid”'],
      ['expect(() => service.load(value)).toThrow(TypeError)', 'Check that calling load on service using value throws an error of type TypeError'],
      ['expect(function () { run() }).toThrowError(/boom/i)', 'Check that calling run throws an error matching /boom/i'],
      ['expect(callback).toThrow()', 'Check that callback throws an error'],
      ['expect(() => { prepare(); run() }).toThrow()', 'Check that the provided operation throws an error'],
    ]

    for (const [source, text] of cases) {
      expect(assertionFrom(source)).toEqual({ text, fidelity: 'derived', role: 'check' })
    }

    for (const source of [
      'expect(account).toHaveProperty()',
      "expect(account).toHaveProperty('id', value, extra)",
      'expect(computeAccount()).toHaveProperty(\'id\')',
      'expect(account).toHaveProperty(computePath())',
      'expect(() => computeCall()).toThrow(computeExpected())',
      'expect(value.property).toThrow()',
      'expect(() => run()).toThrow(a, b)',
    ]) {
      expect(assertionFrom(source)).toEqual({ text: source, fidelity: 'unresolved', role: 'check' })
    }
  })
})
