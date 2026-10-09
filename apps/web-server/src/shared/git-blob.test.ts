import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { gitBlobSha1, isZeroBlob, matchesBlob } from './git-blob'
import { git } from '../../../../tools/test-helpers/git-repo'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-git-blob-')

describe('gitBlobSha1', () => {
  // Each case is hashed by git itself, so the helper is held to git's bytes
  // rather than to a hash written down by hand.
  const cases: Array<[string, string]> = [
    ['LF', 'one\ntwo\n'],
    ['CRLF', 'one\r\ntwo\r\n'],
    ['empty', ''],
    ['UTF-8 multibyte', 'café — 日本\n'],
    ['no trailing newline', 'last line'],
  ]
  it.each(cases)('matches git hash-object for %s content', (_name, content) => {
    const file = path.join(tempDir(), 'file')
    fs.writeFileSync(file, content)
    const expected = git(path.dirname(file), 'hash-object', '--no-filters', file)
    expect(gitBlobSha1(content)).toBe(expected)
    expect(gitBlobSha1(Buffer.from(content, 'utf8'))).toBe(expected)
  })
})

describe('matchesBlob', () => {
  const full = gitBlobSha1('one\n')
  it('accepts an abbreviation of the full id', () => {
    expect(matchesBlob(full, full.slice(0, 7))).toBe(true)
    expect(matchesBlob(full, full)).toBe(true)
  })
  it('refuses another id, a too-short abbreviation and the zero id', () => {
    expect(matchesBlob(full, gitBlobSha1('two\n').slice(0, 7))).toBe(false)
    expect(matchesBlob(full, full.slice(0, 3))).toBe(false)
    expect(matchesBlob('0000000000', '0000000')).toBe(false)
  })
})

describe('isZeroBlob', () => {
  it('names the zero id only', () => {
    expect(isZeroBlob('0000000')).toBe(true)
    expect(isZeroBlob('0000001')).toBe(false)
  })
})
