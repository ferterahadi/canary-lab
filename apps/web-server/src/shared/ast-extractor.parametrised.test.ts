import { expect, it } from 'vitest'
import { extractTestMetadataFromSource } from './ast-extractor'

it('expands wrapped literal inputs without claiming dynamic titles are resolved', () => {
  const source = `
    const rows = ([{ label: 'paid' }, { label: 'refunded' }] as const) satisfies readonly unknown[]
    for (const { label } of rows!) {
      test(\`order \${label}\`, () => {})
    }
    test('fixed title', () => {})
    test(dynamicTitle, () => {})
    test(\`dynamic \${unknownValue}\`, () => {})
  `
  const result = extractTestMetadataFromSource('orders.spec.ts', source, { expandParametrised: true })
  expect(result.parseError).toBeUndefined()
  expect(result.tests.map(({ name, unresolvedTitle }) => ({ name, unresolvedTitle }))).toEqual([
    { name: 'order paid', unresolvedTitle: undefined },
    { name: 'order refunded', unresolvedTitle: undefined },
    { name: 'fixed title', unresolvedTitle: undefined },
    { name: 'dynamicTitle', unresolvedTitle: true },
    { name: 'dynamic ${unknownValue}', unresolvedTitle: true },
  ])
})
