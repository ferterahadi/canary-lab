import { expect, it } from 'vitest'
import { normalizeEnvironmentName, normalizeEnvironmentNames } from './environment-names'

it.each([undefined, [], [' ', '\t']])('defaults an empty environment list to local (%j)', (input) => {
  expect(normalizeEnvironmentNames(input)).toEqual(['local'])
})
it('trims and deduplicates without reordering or changing case', () => {
  const input = [' staging ', '', 'dev_2', 'staging', 'PROD-1']
  expect(normalizeEnvironmentNames(input)).toEqual(['staging', 'dev_2', 'PROD-1'])
  expect(input).toEqual([' staging ', '', 'dev_2', 'staging', 'PROD-1'])
})
it.each(['staging/eu', 'staging\\eu', '..', 'a.b', 'a b'])('rejects invalid nonblank list entries (%s)', (env) => {
  expect(() => normalizeEnvironmentNames(['local', env])).toThrow(`invalid env name: ${env}`)
})
it('keeps scalar validation strict for explicit blanks', () => {
  expect(normalizeEnvironmentName(' local ')).toBe('local')
  expect(() => normalizeEnvironmentName(' ')).toThrow('invalid env name:  ')
})
