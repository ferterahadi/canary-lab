import { describe, it, expect } from 'vitest'
import { compileRequestMatch, parseRequestMatch, requestMatches } from './request-match'

describe('parseRequestMatch', () => {
  it('reads "<METHOD> <path-glob>" into its two halves', () => {
    expect(parseRequestMatch('POST /reserve')).toEqual({ ok: true, match: { method: 'POST', path: '/reserve' } })
  })

  it('accepts the two method wildcards', () => {
    expect(parseRequestMatch('* /**')).toEqual({ ok: true, match: { method: '*', path: '/**' } })
    expect(parseRequestMatch('WRITE /api/**')).toEqual({ ok: true, match: { method: 'WRITE', path: '/api/**' } })
  })

  it('normalises method case and surrounding whitespace', () => {
    expect(parseRequestMatch('  post   /reserve ')).toEqual({ ok: true, match: { method: 'POST', path: '/reserve' } })
  })

  // An agent may hand-edit the envelope, so every malformed form is named
  // rather than silently matching nothing.
  it('names why a malformed match is refused', () => {
    expect(parseRequestMatch('')).toEqual({ ok: false, reason: 'match must be "<METHOD> <path>", e.g. "POST /reserve"' })
    expect(parseRequestMatch('POST')).toEqual({ ok: false, reason: 'match must be "<METHOD> <path>", e.g. "POST /reserve"' })
    expect(parseRequestMatch('FETCH /x')).toEqual({ ok: false, reason: 'unknown method "FETCH"; use an HTTP method, WRITE (any non-GET) or *' })
    expect(parseRequestMatch('POST reserve')).toEqual({ ok: false, reason: 'path must start with "/"' })
    expect(parseRequestMatch('POST /a /b')).toEqual({ ok: false, reason: 'match must be "<METHOD> <path>", e.g. "POST /reserve"' })
  })
})

describe('requestMatches', () => {
  const m = (s: string) => {
    const r = parseRequestMatch(s)
    if (!r.ok) throw new Error(r.reason)
    return r.match
  }

  it('matches an exact method and path', () => {
    expect(requestMatches(m('POST /reserve'), 'POST', '/reserve')).toBe(true)
    expect(requestMatches(m('POST /reserve'), 'GET', '/reserve')).toBe(false)
    expect(requestMatches(m('POST /reserve'), 'POST', '/reserve/1')).toBe(false)
  })

  it('WRITE covers every method except the read-only ones', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(requestMatches(m('WRITE /**'), method, '/x')).toBe(true)
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(requestMatches(m('WRITE /**'), method, '/x')).toBe(false)
  })

  it('* matches every method', () => {
    expect(requestMatches(m('* /x'), 'GET', '/x')).toBe(true)
    expect(requestMatches(m('* /x'), 'DELETE', '/x')).toBe(true)
  })

  it('ignores the query string and compares the method case-insensitively', () => {
    expect(requestMatches(m('GET /items'), 'get', '/items?page=2')).toBe(true)
  })

  it('a single * stays inside one path segment; ** crosses segments', () => {
    expect(requestMatches(m('GET /items/*'), 'GET', '/items/42')).toBe(true)
    expect(requestMatches(m('GET /items/*'), 'GET', '/items/42/notes')).toBe(false)
    expect(requestMatches(m('GET /items/**'), 'GET', '/items/42/notes')).toBe(true)
    expect(requestMatches(m('GET /items/**'), 'GET', '/items')).toBe(true)
    expect(requestMatches(m('GET /**'), 'GET', '/')).toBe(true)
  })

  it('** not preceded by a slash matches the rest of the path from there', () => {
    expect(requestMatches(m('GET /items**'), 'GET', '/items')).toBe(true)
    expect(requestMatches(m('GET /items**'), 'GET', '/items-archive/7')).toBe(true)
    expect(requestMatches(m('GET /items**'), 'GET', '/item')).toBe(false)
  })

  it('escapes regex metacharacters in the glob', () => {
    expect(requestMatches(m('GET /a.b'), 'GET', '/a.b')).toBe(true)
    expect(requestMatches(m('GET /a.b'), 'GET', '/aXb')).toBe(false)
  })
})

describe('compileRequestMatch', () => {
  it('returns a predicate over (method, url) for a valid match', () => {
    const isWrite = compileRequestMatch('WRITE /api/**')
    expect(isWrite('POST', '/api/reserve?x=1')).toBe(true)
    expect(isWrite('GET', '/api/reserve')).toBe(false)
  })

  // The envelope validator already refused this shape, so a throw here means a
  // caller bypassed it — loud is right.
  it('throws with the parse reason on an invalid match', () => {
    expect(() => compileRequestMatch('nope')).toThrow('match must be "<METHOD> <path>", e.g. "POST /reserve"')
  })
})
