import { describe, expect, it } from 'vitest'
import { compareReviewFiles, reviewRevision } from './test-review-comparison'

const bytes = (entries: Array<[string, string | Buffer]>) => new Map(entries.map(([file, content]) => [file, Buffer.from(content)]))

describe('persisted review fingerprints', () => {
  // Captured from suiteReviewRevision before extraction. Computing expected
  // hashes with the new helper would not protect existing approval receipts.
  it('keeps the empty inventory revision', () => {
    expect(compareReviewFiles(new Map(), new Map())).toEqual({
      revision: 'fc6818fa21d92d2d314fa4568ca3fd117c06942ecb757f8678ae602c95472a0c', files: [],
    })
  })

  it('hashes unchanged files independently of map insertion order', () => {
    const before = bytes([['z.ts', 'z\n'], ['a.ts', 'a\n']])
    const after = bytes([['a.ts', 'a\n'], ['z.ts', 'z\n']])
    expect(compareReviewFiles(before, after)).toEqual({
      revision: '21a686f09d68565eb9cf669b5c26524f5fef2003f6ff053c264c64b3bcc842e2', files: [],
    })
    after.set('a.ts', Buffer.from('different\n'))
    before.set('a.ts', Buffer.from('different\n'))
    expect(compareReviewFiles(before, after).files).toEqual([])
    expect(reviewRevision(before, after)).not.toBe('21a686f09d68565eb9cf669b5c26524f5fef2003f6ff053c264c64b3bcc842e2')
  })

  it('preserves added, deleted, empty, newline and binary byte evidence', () => {
    const before = bytes([
      ['same.ts', 'same\n'], ['newline.ts', 'line\n'], ['deleted.txt', 'old'],
      ['empty-deleted', ''], ['binary.bin', Buffer.from([0, 255, 1])],
    ])
    const after = bytes([
      ['same.ts', 'same\n'], ['newline.ts', 'line'], ['added.txt', 'new'],
      ['empty-added', ''], ['binary.bin', Buffer.from([0, 255, 2])],
    ])
    expect(compareReviewFiles(before, after)).toEqual({
      revision: '96a5aad90b9f61b00deb3d5b4ced6acc11716083e8f435451816084247f4dc92',
      files: [
        { file: 'added.txt', change: 'added' }, { file: 'binary.bin', change: 'modified' },
        { file: 'deleted.txt', change: 'deleted' }, { file: 'empty-added', change: 'added' },
        { file: 'empty-deleted', change: 'deleted' }, { file: 'newline.ts', change: 'modified' },
      ],
    })
  })

  it('preserves an explicitly disclosed absent path without hashing invented bytes', () => {
    const before = bytes([['empty', ''], ['changed', 'before']])
    const after = bytes([['empty', ''], ['changed', 'after']])
    const comparison = compareReviewFiles(before, after, ['missing', 'empty', 'missing'])
    expect(comparison).toEqual({ revision: reviewRevision(before, after), files: [{ file: 'missing', change: 'added' }] })
    expect(compareReviewFiles(before, after, []).files).toEqual([])
    expect(before.has('missing')).toBe(false)
    expect(after.has('missing')).toBe(false)
  })
})
