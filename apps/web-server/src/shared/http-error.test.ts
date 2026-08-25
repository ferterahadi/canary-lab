import { describe, expect, it } from 'vitest'
import { httpFailure } from './http-error'

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
