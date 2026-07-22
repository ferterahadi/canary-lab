import { describe, it, expect } from 'vitest'
import { extractJsonCandidates } from './agent-json'

describe('extractJsonCandidates', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonCandidates('{"a": 1}')).toEqual([{ a: 1 }])
  })

  it('parses a fenced JSON object with surrounding prose', () => {
    const text = 'Here is the answer:\n```json\n{"a": 1}\n```\nDone.'
    expect(extractJsonCandidates(text)[0]).toEqual({ a: 1 })
  })

  // Regression: flight fl_4e775ccc6c15 specs-coverage — claude's valid unfenced
  // answer opened with prose containing inline code (`async () => {}`), so the
  // old first-`{`→last-`}` slice started inside the prose and JSON.parse threw,
  // discarding a perfectly good answer.
  it('recovers a bare JSON object preceded by prose containing braces', () => {
    const text =
      'The skips have empty bodies (`async () => {}`) so I omit them.\n\n' +
      '{\n  "mappings": [{ "testName": "t1", "requirements": ["R1"] }]\n}'
    const candidates = extractJsonCandidates(text)
    expect(candidates).toContainEqual({ mappings: [{ testName: 't1', requirements: ['R1'] }] })
    // The real (last) object outranks the inline-code `{}` from the prose.
    expect(candidates[0]).toEqual({ mappings: [{ testName: 't1', requirements: ['R1'] }] })
  })

  it('recovers a bare JSON object followed by trailing prose containing braces', () => {
    const text = '{"mappings": []}\n\nNote: skips use `async () => {}` bodies.'
    expect(extractJsonCandidates(text)[0]).toEqual({ mappings: [] })
  })

  it('prefers the LAST fence when a transcript carries several', () => {
    const text =
      'Example first:\n```json\n{"draft": true}\n```\n' +
      'Final answer:\n```json\n{"final": true}\n```'
    expect(extractJsonCandidates(text)[0]).toEqual({ final: true })
  })

  it('tolerates braces inside JSON string values', () => {
    const text = 'prose\n{"rationale": "covers the {phone} placeholder", "ok": true}'
    expect(extractJsonCandidates(text)[0]).toEqual({ rationale: 'covers the {phone} placeholder', ok: true })
  })

  it('tolerates escaped quotes inside JSON string values', () => {
    const text = '{"msg": "she said \\"hi\\" {once}"}'
    expect(extractJsonCandidates(text)[0]).toEqual({ msg: 'she said "hi" {once}' })
  })

  it('skips an unterminated object and still finds a complete one', () => {
    const text = 'broken { "a": 1 ... \n {"b": 2}'
    // The unterminated `{` swallows the rest of the text, so scanning must not
    // stop there — the complete object is found by a later start position.
    expect(extractJsonCandidates(text)).toContainEqual({ b: 2 })
  })

  it('returns [] when nothing parses', () => {
    expect(extractJsonCandidates('no json here')).toEqual([])
    expect(extractJsonCandidates('')).toEqual([])
  })

  it('ignores a fence whose body is not JSON but still scans the rest', () => {
    const text = '```\nnot json\n```\n{"a": 1}'
    expect(extractJsonCandidates(text)).toContainEqual({ a: 1 })
  })
})
