import { expect, it } from 'vitest'
import { errorMessage } from './error-message'

it('returns an Error message, ignoring the fallback', () => {
  expect(errorMessage(new TypeError('boom'), 'Save failed')).toBe('boom')
})
it('stringifies a thrown non-Error when no fallback is given', () => {
  expect(errorMessage('plain')).toBe('plain')
  expect(errorMessage(42)).toBe('42')
})
it('uses the fallback for a thrown non-Error', () => {
  expect(errorMessage({ code: 1 }, 'Save failed')).toBe('Save failed')
})
