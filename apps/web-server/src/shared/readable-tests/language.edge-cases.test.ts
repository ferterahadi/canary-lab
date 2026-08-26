import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  actionFromIdentifier,
  assignedNameFromStatement,
  calledNameFromText,
  displayWord,
  humanizeIdentifier,
  identifierWords,
  isMeaningfulFlowStatement,
  looksLikeIdentifier,
  readableActionName,
  readableCreatedObject,
  readableHelperName,
  readableObject,
  sentenceCase,
  setupLikeStatement,
} from './language'

describe('readable language edge cases', () => {
  it('distinguishes code-shaped words from ordinary dotted prose', () => {
    expect(looksLikeIdentifier('order_id')).toBe(true)
    expect(looksLikeIdentifier('$order')).toBe(true)
    expect(looksLikeIdentifier('order.status')).toBe(true)
    expect(looksLikeIdentifier('e.g.')).toBe(false)
    expect(looksLikeIdentifier('orderStatus')).toBe(true)
    expect(looksLikeIdentifier('ordinary')).toBe(false)
  })

  it('humanizes names, acronyms, display words, and empty input', () => {
    expect(identifierWords('HTTPResponse_ids')).toEqual(['http', 'response', 'ids'])
    expect(humanizeIdentifier('')).toBe('')
    expect(readableHelperName('')).toBe('')
    expect(readableHelperName('seedOrder')).toBe('Seed order')
    expect(displayWord('ids')).toBe('identifiers')
    expect(displayWord('id')).toBe('identifier')
    expect(displayWord('order')).toBe('order')
    expect(sentenceCase('')).toBe('')
    expect(sentenceCase('checkout')).toBe('Checkout')
    expect(readableObject(['async', '', 'order', 'id'])).toBe('order identifier')
    expect(readableObject([])).toBe('')
  })

  it('maps helper verbs to literal action families', () => {
    const cases: Array<[string, string]> = [
      ['expectOrder', 'check order'],
      ['assert', 'check the expected outcome'],
      ['checkOrder', 'check order'],
      ['mockOrder', 'prepare order'],
      ['mock', 'prepare test data'],
      ['createOrder', 'prepare order'],
      ['makeOrder', 'prepare order'],
      ['buildOrder', 'prepare order'],
      ['generateOrder', 'prepare order'],
      ['prepareOrder', 'prepare order'],
      ['sendOrder', 'send order'],
      ['postOrder', 'send order'],
      ['submitOrder', 'send order'],
      ['publishOrder', 'send order'],
      ['sendPost', 'send the request'],
      ['queryOrder', 'read order'],
      ['readOrder', 'read order'],
      ['fetchOrder', 'read order'],
      ['getOrder', 'read order'],
      ['findOrder', 'read order'],
      ['get', 'read the saved record'],
      ['pollOrder', 'wait for order'],
      ['wait', 'wait for the expected result'],
      ['toggleOrder', 'toggle order'],
      ['enableOrder', 'enable order'],
      ['disableOrder', 'disable order'],
      ['restoreOrder', 'restore order'],
      ['updateOrder', 'update order'],
      ['upsertOrder', 'upsert order'],
      ['toggle', 'toggle test data'],
      ['withOrders', 'check orders'],
      ['with', 'check the related records'],
      ['performClickNow', 'click the relevant control'],
      ['performFillNow', 'enter the required value'],
      ['processOrder', 'process order'],
      ['', ''],
    ]

    for (const [name, text] of cases) expect(actionFromIdentifier(name)).toBe(text)
  })

  it('uses assignment context only when a create helper omits its object', () => {
    expect(readableCreatedObject([], 'orderIds')).toBe('unique identifiers')
    expect(readableCreatedObject(['ids'])).toBe('unique identifiers')
    expect(readableCreatedObject(['order'])).toBe('order')
    expect(readableCreatedObject([])).toBe('test data')
    expect(actionFromIdentifier('create', 'order')).toBe('prepare order')
  })

  it('renders statement-derived action names and source classifiers', () => {
    expect(readableActionName('createOrder', 'const order = createOrder()')).toBe('Prepare order')
    expect(readableActionName('', 'const startedAt = new Date()')).toBe('Record the start time')
    expect(assignedNameFromStatement('let order_id = createOrder()')).toBe('order_id')
    expect(assignedNameFromStatement('createOrder()')).toBeUndefined()
    expect(calledNameFromText('return (createOrder())')).toBe('createOrder')
    expect(calledNameFromText('plain text')).toBeUndefined()
    expect(setupLikeStatement('await page.route(pattern, handler)')).toBe(true)
    expect(setupLikeStatement('await page.click()')).toBe(false)
  })

  it('detects calls, awaits, and constructors without evaluating the tree', () => {
    const source = ts.createSourceFile(
      'flow.ts',
      `const literal = 1
const called = loadValue()
await ready
const created = new Date()
anotherCall()`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )

    expect(isMeaningfulFlowStatement(source.statements[0])).toBe(false)
    expect(isMeaningfulFlowStatement(source.statements[1])).toBe(true)
    expect(isMeaningfulFlowStatement(source.statements[2])).toBe(true)
    expect(isMeaningfulFlowStatement(source.statements[3])).toBe(true)
    expect(isMeaningfulFlowStatement(source)).toBe(true)
  })
})
