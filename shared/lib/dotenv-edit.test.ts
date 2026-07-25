import { describe, expect, it } from 'vitest'
import { parseDotenv, writeDotenv } from './dotenv-edit'

describe('parseDotenv', () => {
  it('reads KEY=VALUE pairs and skips blanks and comments', () => {
    const parsed = parseDotenv(['# header', '', 'PORT=3000', '  API_URL = http://x  ', ''].join('\n'))
    expect(parsed.entries).toEqual([
      { key: 'PORT', value: '3000' },
      { key: 'API_URL', value: 'http://x' },
    ])
    expect(parsed.unparsedLines).toEqual([])
  })

  it('strips a matched pair of surrounding quotes', () => {
    const parsed = parseDotenv(['D="two words"', "S='single quoted'", 'BARE=plain', 'MIXED="unbalanced'].join('\n'))
    expect(parsed.entries).toEqual([
      { key: 'D', value: 'two words' },
      { key: 'S', value: 'single quoted' },
      { key: 'BARE', value: 'plain' },
      { key: 'MIXED', value: '"unbalanced' },
    ])
  })

  it('reports 1-based line numbers for lines it cannot parse', () => {
    // Multi-line values and stray text are surfaced, never silently mangled.
    const parsed = parseDotenv(['PORT=3000', 'this is not a pair', '9INVALID=x'].join('\n'))
    expect(parsed.entries).toEqual([{ key: 'PORT', value: '3000' }])
    expect(parsed.unparsedLines).toEqual([2, 3])
  })

  it('handles CRLF sources and an empty source', () => {
    expect(parseDotenv('A=1\r\nB=2').entries).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
    ])
    expect(parseDotenv('')).toEqual({ entries: [], unparsedLines: [] })
  })
})

describe('writeDotenv', () => {
  it('rewrites only the touched key and leaves the rest of the block byte-identical', () => {
    const source = ['# app config', '', 'PORT=3000', 'API_URL=http://old', '# trailing note', ''].join('\n')
    const out = writeDotenv(source, [
      { key: 'PORT', value: '3000' },
      { key: 'API_URL', value: 'http://new' },
    ])
    expect(out).toBe(['# app config', '', 'PORT=3000', 'API_URL=http://new', '# trailing note', ''].join('\n'))
  })

  it('drops keys absent from the patch and preserves unparseable lines verbatim', () => {
    const source = ['KEEP=1', 'GONE=2', 'not a pair at all'].join('\n')
    expect(writeDotenv(source, [{ key: 'KEEP', value: '1' }])).toBe(['KEEP=1', 'not a pair at all'].join('\n'))
  })

  it('appends new keys in patch order, separated by one blank line', () => {
    const out = writeDotenv('PORT=3000', [
      { key: 'PORT', value: '3000' },
      { key: 'DB_URL', value: 'postgres://localhost' },
      { key: 'DEBUG', value: 'true' },
    ])
    expect(out).toBe(['PORT=3000', '', 'DB_URL=postgres://localhost', 'DEBUG=true'].join('\n'))
  })

  it('does not add a second blank line when the block already ends blank', () => {
    // Source ends '\n\n', so the preserved trailing blank is the separator —
    // the appender must not add one of its own.
    const out = writeDotenv('PORT=3000\n\n', [
      { key: 'PORT', value: '3000' },
      { key: 'NEW', value: '1' },
    ])
    expect(out).toBe('PORT=3000\n\n\nNEW=1\n')
  })

  it('appends with no separator when every original line was dropped', () => {
    expect(writeDotenv('GONE=1', [{ key: 'NEW', value: '1' }])).toBe('NEW=1')
  })

  it('quotes only values that need it, escaping inner double quotes', () => {
    const out = writeDotenv('A=x\nB=x\nC=x\nD=x', [
      { key: 'A', value: 'two words' },
      { key: 'B', value: 'safe-token_1./:@+' },
      { key: 'C', value: '' },
      { key: 'D', value: 'say "hi"' },
    ])
    expect(out).toBe(['A="two words"', 'B=safe-token_1./:@+', 'C=', 'D="say \\"hi\\""'].join('\n'))
  })

  it('preserves the presence or absence of a trailing newline', () => {
    expect(writeDotenv('PORT=3000\n', [{ key: 'PORT', value: '4000' }])).toBe('PORT=4000\n')
    expect(writeDotenv('PORT=3000', [{ key: 'PORT', value: '4000' }])).toBe('PORT=4000')
  })

  it('treats a quoted old value equal to the new value as untouched', () => {
    // The comparison strips quotes first, so re-saving an unchanged quoted
    // value must not reformat the line.
    expect(writeDotenv('MSG="two words"', [{ key: 'MSG', value: 'two words' }])).toBe('MSG="two words"')
  })
})
