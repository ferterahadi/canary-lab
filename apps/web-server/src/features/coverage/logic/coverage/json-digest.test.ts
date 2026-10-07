import { describe, expect, it } from 'vitest'
import { coverageJsonDigest } from './json-digest'

describe('coverageJsonDigest', () => {
  it.each([
    [null, '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'],
    [true, 'b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b'],
    [42, '73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049'],
    ['hello', '5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a'],
    [[], '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'],
    [[1, 'x', null], 'c3462050a94ca819b16ded452c5ac9dc70605f7e5c841ab7bff396cf60e2cc67'],
    [{ a: 1, b: 2 }, '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777'],
    [{ b: 2, a: 1 }, '3fb75453225c732a76b7899ea2096dda1455189c89817239732182f73fe5a09f'],
  ])('preserves the serialized digest for %j', (value, expected) => {
    expect(coverageJsonDigest(value)).toBe(expected)
  })

  it('retains JSON handling of nested undefined and toJSON', () => {
    expect(coverageJsonDigest({ a: 1, ignored: undefined, b: 2 })).toBe(coverageJsonDigest({ a: 1, b: 2 }))
    expect(coverageJsonDigest([1, 'x', undefined])).toBe(coverageJsonDigest([1, 'x', null]))
    expect(coverageJsonDigest({ toJSON: () => 42 })).toBe(coverageJsonDigest(42))
  })

  it('propagates unsupported input and serialization failures', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    for (const value of [undefined, circular, BigInt(1)]) {
      expect(() => coverageJsonDigest(value)).toThrow(TypeError)
    }
    const failure = new Error('serialization failed')
    expect(() => coverageJsonDigest({ toJSON() { throw failure } })).toThrow(failure)
  })
})
