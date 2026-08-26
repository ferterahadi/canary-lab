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
