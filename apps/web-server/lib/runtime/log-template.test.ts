import { describe, it, expect } from 'vitest'
import { lineTemplate, compressLogByTemplate } from './log-template'

describe('lineTemplate', () => {
  it('masks timestamps, durations, and bare numbers', () => {
    expect(lineTemplate('2026-06-16T12:00:01.123Z connect')).toBe('<ts> connect')
    expect(lineTemplate('done in 1.5s')).toBe('done in <dur>')
    expect(lineTemplate('retry attempt 312')).toBe('retry attempt <n>')
  })

  it('PROTECTS identity tokens (uuid, ip, hex) — kept verbatim so distinct ones never merge', () => {
    expect(lineTemplate('id=550e8400-e29b-41d4-a716-446655440000'))
      .toBe('id=550e8400-e29b-41d4-a716-446655440000')
    // The generic number mask must NOT shred the IP octets.
    expect(lineTemplate('peer 10.0.0.1:5432 up')).toBe('peer 10.0.0.1:5432 up')
    expect(lineTemplate('addr 0xdeadbeef freed')).toBe('addr 0xdeadbeef freed')
  })

  it('masks metadata while leaving an adjacent protected id intact', () => {
    expect(lineTemplate('req 550e8400-e29b-41d4-a716-446655440000 took 12ms'))
      .toBe('req 550e8400-e29b-41d4-a716-446655440000 took <dur>')
  })

  it('leaves lines with no volatile tokens unchanged', () => {
    expect(lineTemplate('waiting for db')).toBe('waiting for db')
  })
})

describe('compressLogByTemplate', () => {
  it('collapses non-consecutive lines that share a template, preserving order', () => {
    const log = [
      'GET /a took 12ms',
      'cache warm',
      'GET /a took 5ms',
      'GET /a took 9ms',
    ].join('\n')
    const { text, collapsedLines } = compressLogByTemplate(log)
    // The three "GET /a took <dur>" lines collapse to the first + a count, even
    // though one is interleaved with "cache warm" — and the duration range is
    // surfaced so the slow one (12ms) isn't hidden behind the count.
    expect(text).toBe(['GET /a took 12ms  (×3; 5ms–12ms)', 'cache warm'].join('\n'))
    expect(collapsedLines).toBe(2)
  })

  it('does not collapse templates seen fewer than minRepeat times', () => {
    const log = 'line one\nline two'
    expect(compressLogByTemplate(log).text).toBe(log)
    expect(compressLogByTemplate(log).collapsedLines).toBe(0)
  })

  it('respects an explicit minRepeat and shows the number range', () => {
    const log = 'tick 1\ntick 2'
    // Both share template "tick <n>"; with minRepeat 2 they collapse, and the
    // value range (1–2) is surfaced.
    expect(compressLogByTemplate(log, 2).text).toBe('tick 1  (×2; 1–2)')
  })

  it('does not collapse lines that differ by a PROTECTED identity (distinct IPs)', () => {
    const log = [
      'conn from 10.0.0.1 ok',
      'conn from 10.0.0.2 ok',
      'conn from 10.0.0.3 ok',
    ].join('\n')
    // IPs are protected, so these are three distinct templates — nothing
    // collapses and every address is preserved for tracing.
    const { text, collapsedLines } = compressLogByTemplate(log)
    expect(text).toBe(log)
    expect(collapsedLines).toBe(0)
  })

  it('passes blank lines through and never merges them', () => {
    const log = 'a\n\nb\n\nc'
    expect(compressLogByTemplate(log).text).toBe(log)
  })

  it('never merges error-keyword lines that differ only in a masked token', () => {
    const log = [
      'ERROR upstream returned 500',
      'ERROR upstream returned 404',
      'ERROR upstream returned 500',
      'ERROR upstream returned 500',
    ].join('\n')
    const { text } = compressLogByTemplate(log)
    // Both contain "ERROR" → templated by raw text, so the 404 is NOT swallowed
    // by the 500s' `<n>` mask. The three identical 500s still collapse.
    expect(text).toContain('ERROR upstream returned 404')
    expect(text).toContain('ERROR upstream returned 500  (×3)')
  })

  it('collapses high-frequency retry spam to a single representative + count', () => {
    const lines = []
    for (let i = 1; i <= 200; i++) lines.push(`waiting for db (attempt ${i})`)
    lines.push('connected')
    const { text, collapsedLines } = compressLogByTemplate(lines.join('\n'))
    // Representative is the first occurrence's RAW line + the total count + the
    // attempt-number range.
    expect(text).toBe(['waiting for db (attempt 1)  (×200; 1–200)', 'connected'].join('\n'))
    expect(collapsedLines).toBe(199)
  })
})
