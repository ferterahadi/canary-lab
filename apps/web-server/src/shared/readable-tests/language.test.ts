import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  actionFromIdentifier,
  calledNameFromText,
  humanizeIdentifier,
  isMeaningfulFlowStatement,
  readableActionName,
  setupLikeStatement,
} from './language'

describe('readable test language', () => {
  it('preserves the evaluation audience vocabulary', () => {
    expect(actionFromIdentifier('expectOrder')).toBe('check order')
    expect(actionFromIdentifier('createUserId')).toBe('prepare unique identifiers')
    expect(actionFromIdentifier('waitForReceipt')).toBe('wait for for receipt')
    expect(readableActionName('', 'plain statement')).toBe('Run the next step')
    expect(humanizeIdentifier('checkout.submitOrder')).toBe('checkout submit order')
  })

  it('keeps digit-carrying acronyms whole while still splitting camel digits', () => {
    expect(humanizeIdentifier('process.env.E2E_USER')).toBe('process environment e2e user')
    expect(humanizeIdentifier('B2B')).toBe('b2b')
    expect(humanizeIdentifier('apiV2Response')).toBe('api v2 response')
    expect(humanizeIdentifier('order2Confirm')).toBe('order2 confirm')
    expect(humanizeIdentifier('step2API')).toBe('step2 api')
    expect(humanizeIdentifier('E2ESuite')).toBe('e2e suite')
  })

  it('classifies calls and setup statements without executing source', () => {
    const source = ts.createSourceFile(
      'flow.ts',
      "const value = 'literal'\nawait page.goto('/checkout')",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )

    expect(isMeaningfulFlowStatement(source.statements[0])).toBe(false)
    expect(isMeaningfulFlowStatement(source.statements[1])).toBe(true)
    expect(calledNameFromText('await seed()')).toBe('seed')
    expect(setupLikeStatement('await seed()')).toBe(true)
  })
})
