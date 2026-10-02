import { describe, expect, it } from 'vitest'
import { canonicalPathTypes } from './path-types'

describe('canonical path types', () => {
  it.each([undefined, null, 'happy', {}, []])('returns no default for %j', (value) => {
    expect(canonicalPathTypes(value)).toEqual([])
  })

  it('deduplicates and orders only exact vocabulary entries without mutating input', () => {
    const input = ['edge', ' happy', 'sad', 'HAPPY', 'happy', 'sad', 1, null]
    expect(canonicalPathTypes(input)).toEqual(['happy', 'sad', 'edge'])
    expect(input).toEqual(['edge', ' happy', 'sad', 'HAPPY', 'happy', 'sad', 1, null])
  })
})
