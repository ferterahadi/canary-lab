import path from 'path'
import { describe, expect, it } from 'vitest'
import { specFileOfKnownTest } from './rerun-targets'

describe('rerun source locations', () => {
  it.each(['e2e/cart.spec.ts', 'e2e/cart.spec.ts:2', 'e2e/cart.spec.ts:2:1'])(
    'resolves the spec file for %s', (location) => {
      expect(specFileOfKnownTest({ name: 'cart', title: 'cart', location })).toBe(path.resolve('e2e/cart.spec.ts'))
    },
  )
  it('retains missing and empty file defaults', () => {
    for (const location of [undefined, '', ':2:1']) {
      expect(specFileOfKnownTest({ name: 'cart', title: 'cart', location })).toBeUndefined()
    }
  })
})
