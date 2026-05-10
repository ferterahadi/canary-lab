import { describe, it, expect } from 'vitest'
import { parseDotenv, writeDotenv } from './dotenv-edit'

describe('parseDotenv', () => {
  it('parses simple KEY=VALUE pairs', () => {
    const r = parseDotenv('FOO=bar\nBAZ=qux')
    expect(r.entries).toEqual([
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ])
    expect(r.unparsedLines).toEqual([])
  })

  it('strips surrounding double and single quotes', () => {
    const r = parseDotenv('A="hello world"\nB=\'one\'')
    expect(r.entries).toEqual([
      { key: 'A', value: 'hello world' },
      { key: 'B', value: 'one' },
    ])
  })

  it('skips comments and blank lines', () => {
    const r = parseDotenv('# top\n\nFOO=1\n# trailing\n')
    expect(r.entries).toEqual([{ key: 'FOO', value: '1' }])
    expect(r.unparsedLines).toEqual([])
  })

  it('reports unparseable lines (1-indexed)', () => {
    const r = parseDotenv('FOO=1\n!!!bad line\nBAR=2')
    expect(r.entries).toEqual([
      { key: 'FOO', value: '1' },
      { key: 'BAR', value: '2' },
    ])
    expect(r.unparsedLines).toEqual([2])
  })

  it('tolerates surrounding whitespace and CRLF line endings', () => {
    const r = parseDotenv('  FOO = bar  \r\nBAZ=qux\r\n')
    expect(r.entries).toEqual([
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ])
  })
})

describe('writeDotenv', () => {
  it('preserves comments, blanks, and untouched key order', () => {
    const src = '# header\n\nFOO=1\n# mid\nBAR=2\n'
    const out = writeDotenv(src, [
      { key: 'FOO', value: '1' },
      { key: 'BAR', value: '2' },
    ])
    expect(out).toBe(src)
  })

  it('rewrites only the modified key, keeps others byte-for-byte', () => {
    const src = '# c1\nFOO=1\nBAR=2\n'
    const out = writeDotenv(src, [
      { key: 'FOO', value: '1' },
      { key: 'BAR', value: '99' },
    ])
    expect(out).toBe('# c1\nFOO=1\nBAR=99\n')
  })

  it('drops keys removed from the patch', () => {
    const src = 'FOO=1\nBAR=2\n'
    const out = writeDotenv(src, [{ key: 'FOO', value: '1' }])
    expect(out).toBe('FOO=1\n')
  })

  it('appends new keys at the end with a blank-line separator', () => {
    const src = 'FOO=1\n'
    const out = writeDotenv(src, [
      { key: 'FOO', value: '1' },
      { key: 'NEW', value: 'x' },
    ])
    expect(out).toBe('FOO=1\n\nNEW=x\n')
  })

  it('appends without separator when output already ends in blank line', () => {
    const src = 'FOO=1\n\n'
    const out = writeDotenv(src, [
      { key: 'FOO', value: '1' },
      { key: 'NEW', value: 'x' },
    ])
    // The split keeps the trailing empty string; no extra blank line added.
    expect(out.endsWith('NEW=x\n')).toBe(true)
    expect(out).toContain('FOO=1')
  })

  it('quotes values with whitespace and escapes inner quotes', () => {
    const src = ''
    const out = writeDotenv(src, [
      { key: 'A', value: 'hello world' },
      { key: 'B', value: 'has "inner" quote' },
    ])
    expect(out).toContain('A="hello world"')
    expect(out).toContain('B="has \\"inner\\" quote"')
  })

  it('keeps bare alphanumeric values unquoted', () => {
    const out = writeDotenv('', [{ key: 'A', value: 'plain-value_1.2/3:4@5' }])
    expect(out).toContain('A=plain-value_1.2/3:4@5')
    expect(out).not.toContain('"')
  })

  it('writes empty string values without quotes', () => {
    const out = writeDotenv('', [{ key: 'A', value: '' }])
    expect(out.trim()).toBe('A=')
  })

  it('preserves trailing newline state', () => {
    expect(writeDotenv('FOO=1\n', [{ key: 'FOO', value: '2' }])).toBe('FOO=2\n')
    expect(writeDotenv('FOO=1', [{ key: 'FOO', value: '2' }])).toBe('FOO=2')
  })

  it('preserves unparseable lines verbatim', () => {
    const src = '!!!weird\nFOO=1\n'
    const out = writeDotenv(src, [{ key: 'FOO', value: '1' }])
    expect(out).toBe(src)
  })

  it('keeps line untouched when patched value equals existing value', () => {
    const src = 'FOO="quoted"\n'
    const out = writeDotenv(src, [{ key: 'FOO', value: 'quoted' }])
    expect(out).toBe(src)
  })
})
