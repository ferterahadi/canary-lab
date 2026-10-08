import { expect, it } from 'vitest'
import { checkSharedBehaviors, sharedBehaviors, checkForbiddenSharedCopies, forbiddenSharedCopies } from './shared-behavior-contracts.mjs'

it.each(sharedBehaviors)('enforces shared behavior in $file', (rule) => {
  const legal = `import { ${rule.symbols.join(', ')} } from '${rule.owner}'\n${rule.symbols.map((symbol) => `${symbol}()`).join('\n')}`
  expect(checkSharedBehaviors(() => legal, [rule])).toEqual([])
  for (const symbol of rule.symbols) {
    expect(checkSharedBehaviors(() => legal.replace(`${symbol}()`, `local${symbol}()`), [rule])).not.toEqual([])
    expect(checkSharedBehaviors(() => legal.replace(rule.owner, 'copied-owner'), [rule])).not.toEqual([])
  }
  expect(checkSharedBehaviors(() => `${legal}\ninterface TestReview {}`, [rule])).not.toEqual([])
})

it.each(forbiddenSharedCopies)('rejects the removed local implementation in $file', (rule) => {
  expect(checkForbiddenSharedCopies(() => rule.valid, [rule])).toEqual([])
  expect(checkForbiddenSharedCopies(() => rule.invalid, [rule])).toEqual([`${rule.file}: ${rule.message}`])
  expect(checkForbiddenSharedCopies(() => `// ${rule.invalid}\n${rule.valid}`, [rule])).toEqual([])
})
