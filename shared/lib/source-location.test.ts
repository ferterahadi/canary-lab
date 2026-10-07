import { describe, expect, it } from 'vitest'
import { parseSourceLocation, shortSourceLocation } from './source-location'

describe('parseSourceLocation', () => {
  it.each([
    ['', { file: '' }],
    ['e2e/cart.spec.ts', { file: 'e2e/cart.spec.ts' }],
    ['e2e/cart.spec.ts:2', { file: 'e2e/cart.spec.ts', line: '2' }],
    ['e2e/cart.spec.ts:2:1', { file: 'e2e/cart.spec.ts', line: '2', column: '1' }],
    ['C:\\repo\\cart.spec.ts:34:5', { file: 'C:\\repo\\cart.spec.ts', line: '34', column: '5' }],
    ['file:with:colons.ts:002:00', { file: 'file:with:colons.ts', line: '002', column: '00' }],
    ['cart.ts:0', { file: 'cart.ts', line: '0' }],
    ['cart.ts:2:bad', { file: 'cart.ts:2:bad' }],
    [':2:1', { file: '', line: '2', column: '1' }],
  ])('parses %s without resolving or rewriting the path', (input, expected) => {
    expect(parseSourceLocation(input)).toEqual(expected)
  })
})

describe('shortSourceLocation', () => {
  it.each([
    ['', ''],
    ['checkout.spec.ts:12', 'checkout.spec.ts:12'],
    ['/repo/e2e/checkout.spec.ts:12:3', 'e2e/checkout.spec.ts:12:3'],
    ['C:\\repo\\e2e\\checkout.spec.ts:12:3', 'e2e/checkout.spec.ts:12:3'],
    ['C:\\repo/e2e\\checkout.spec.ts:002:00', 'e2e/checkout.spec.ts:002:00'],
    ['\\\\server\\share\\e2e\\checkout.spec.ts', 'e2e/checkout.spec.ts'],
  ])('shortens %s for display', (input, expected) => {
    expect(shortSourceLocation(input)).toBe(expected)
  })
})
