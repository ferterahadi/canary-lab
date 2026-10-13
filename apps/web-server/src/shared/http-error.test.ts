import { describe, expect, it } from 'vitest'
import type { FastifyReply } from 'fastify'
import { httpFailure, notFound, replyFailure, statusCodeOf } from './http-error'

// One suite for the wrapper that every route-layer rethrow goes through. The
// non-Error arm is the reason this module exists: it was previously re-typed at
// five call sites, none of which could provoke it on their own.

describe('httpFailure', () => {
  it('keeps the original error, its message and its stack', () => {
    const original = new Error('envset apply failed')
    const stack = original.stack

    const failure = httpFailure(original, 500)

    // The SAME object, not a copy: a rewrap would lose the stack that says where
    // the failure actually came from.
    expect(failure).toBe(original)
    expect(failure.message).toBe('envset apply failed')
    expect(failure.stack).toBe(stack)
    expect(failure.statusCode).toBe(500)
  })

  it('preserves an Error subclass rather than flattening it', () => {
    class GitError extends Error {}
    const original = new GitError('detached HEAD')

    const failure = httpFailure(original, 409)

    expect(failure).toBeInstanceOf(GitError)
    expect(failure.statusCode).toBe(409)
  })

  it('gives a non-Error throw a readable message instead of an empty one', () => {
    // `.message` on a bare string is undefined, which is how a thrown string
    // used to reach a client as an empty error.
    expect(httpFailure('at capacity', 429)).toMatchObject({ message: 'at capacity', statusCode: 429 })
    expect(httpFailure({ code: 'EBUSY' }, 503)).toMatchObject({ message: '[object Object]', statusCode: 503 })
    expect(httpFailure(undefined, 500)).toMatchObject({ message: 'undefined', statusCode: 500 })
  })

  it('overwrites a statusCode the caught error already carried', () => {
    // An inner layer's status must not outrank the boundary that is answering:
    // the outer handler knows what this failure means to the client.
    const inner = Object.assign(new Error('conflict'), { statusCode: 409 })

    expect(httpFailure(inner, 500).statusCode).toBe(500)
  })
})

describe('notFound', () => {
  it('sets 404 and returns the exact body clients match on', () => {
    const codes: number[] = []
    const reply = { code: (status: number) => { codes.push(status); return reply } } as unknown as FastifyReply

    // Route tests assert these bodies verbatim, and the helper builds them from
    // a noun, so a multi-word noun must come through unchanged.
    expect(notFound(reply, 'run')).toEqual({ error: 'run not found' })
    expect(notFound(reply, 'evaluation export task')).toEqual({ error: 'evaluation export task not found' })
    expect(codes).toEqual([404, 404])
  })
})

describe('statusCodeOf', () => {
  it('passes through the status a producer stamped', () => {
    expect(statusCodeOf(Object.assign(new Error('conflict'), { statusCode: 409 }))).toBe(409)
    expect(statusCodeOf(httpFailure('busy', 429))).toBe(429)
    expect(statusCodeOf({ statusCode: 100 })).toBe(100)
    expect(statusCodeOf({ statusCode: 599 })).toBe(599)
  })

  it('answers 500 for anything that is not a real HTTP status', () => {
    expect(statusCodeOf(new Error('plain'))).toBe(500)
    expect(statusCodeOf(null)).toBe(500)
    expect(statusCodeOf(undefined)).toBe(500)
    expect(statusCodeOf('thrown string')).toBe(500)
    expect(statusCodeOf({ statusCode: '404' })).toBe(500)
    expect(statusCodeOf({ statusCode: Number.NaN })).toBe(500)
    expect(statusCodeOf({ statusCode: 404.5 })).toBe(500)
    expect(statusCodeOf({ statusCode: 99 })).toBe(500)
    expect(statusCodeOf({ statusCode: 600 })).toBe(500)
  })
})

describe('replyFailure', () => {
  it('sets the caught status and returns the { error } body', () => {
    const codes: number[] = []
    const reply = { code: (status: number) => { codes.push(status); return reply } } as unknown as FastifyReply

    expect(replyFailure(reply, Object.assign(new Error('flight not found'), { statusCode: 404 }))).toEqual({ error: 'flight not found' })
    expect(replyFailure(reply, 'raw')).toEqual({ error: 'raw' })
    expect(replyFailure(reply, { code: 'EBUSY' }, 'Save failed')).toEqual({ error: 'Save failed' })
    expect(codes).toEqual([404, 500, 500])
  })
})
