import { describe, expect, it } from 'vitest'
import { asJsonResult, asToonResult, errorResult, failureResult, hasText, isToolErrorPayload, summarizeUnifiedDiff } from './tool-support'

// The small result-shaping helpers every tool group returns through. They earn
// their own suite because each one is used at a dozen call sites: proving the
// shape once here is what lets those sites assert their own behaviour instead of
// re-asserting the envelope.

describe('errorResult', () => {
  it('marks the result as an error so the client does not read it as data', () => {
    expect(errorResult('feature not found: ghost')).toEqual({
      content: [{ type: 'text', text: 'feature not found: ghost' }],
      isError: true,
    })
  })
})

describe('failureResult', () => {
  it('reports a thrown Error by its message', () => {
    expect(failureResult(new Error('worktree is dirty'))).toEqual({
      content: [{ type: 'text', text: 'worktree is dirty' }],
      isError: true,
    })
  })

  it('reports a non-Error throw by stringifying it', () => {
    // Any single catch site is unlikely to see this; the surface as a whole does
    // (a rejected promise carrying a string, a thrown object from a dependency),
    // and `err.message` on one of those would render an empty error.
    expect(failureResult('at capacity')).toMatchObject({
      content: [{ type: 'text', text: 'at capacity' }],
      isError: true,
    })
    expect(failureResult({ code: 429 })).toMatchObject({
      content: [{ type: 'text', text: '[object Object]' }],
    })
    expect(failureResult(undefined)).toMatchObject({
      content: [{ type: 'text', text: 'undefined' }],
    })
  })

  it('keeps the message of an Error subclass carrying a statusCode', () => {
    // The repo's HTTP-facing failures are `Object.assign(new Error(msg), {statusCode})`,
    // which is what most of these catches actually receive.
    const err = Object.assign(new Error('workflow is not ready-to-save'), { statusCode: 409 })

    expect(failureResult(err)).toMatchObject({
      content: [{ type: 'text', text: 'workflow is not ready-to-save' }],
    })
  })
})

describe('asJsonResult', () => {
  it('renders a value as COMPACT JSON — the whitespace is tokens on every result', () => {
    const out = asJsonResult({ runId: 'r1', counts: { passed: 2 } })

    expect(out.isError).toBeUndefined()
    const text = (out.content as Array<{ text: string }>)[0].text
    // Asserted as an exact string, not via JSON.parse: a parse-and-compare is
    // blind to formatting, so it would pass just as happily with the 2-space
    // pretty-print this helper deliberately dropped — which was pure whitespace
    // tokens on every tool result of every profile.
    expect(text).toBe('{"runId":"r1","counts":{"passed":2}}')
    expect(text).not.toContain('\n')
  })
})

describe('asToonResult', () => {
  function textOf(out: ReturnType<typeof asToonResult>): string {
    return (out.content as Array<{ text: string }>)[0].text
  }

  it('emits the field names once for a list instead of once per row', () => {
    // This is the entire reason list tools use TOON over JSON: the header row is
    // where the ~half-the-tokens saving comes from. Asserting the count, not just
    // that the ids are present, is what would catch a silent fall back to JSON.
    const text = textOf(asToonResult([
      { runId: 'run-1', status: 'passed' },
      { runId: 'run-2', status: 'failed' },
    ]))

    expect(text.match(/runId/g)).toHaveLength(1)
    expect(text).toContain('[2]{runId,status}:')
    expect(text).toContain('run-2,failed')
  })

  it('is not an error result, so the client reads a list as data', () => {
    expect(asToonResult([{ feature: 'checkout' }]).isError).toBeUndefined()
  })

  it('falls back to compact JSON for anything not a table of rows', () => {
    // Pointing this at a non-tabular result is safe by design — an empty list and
    // a plain object both come back as parseable JSON rather than a broken table.
    expect(JSON.parse(textOf(asToonResult([])))).toEqual([])
    expect(JSON.parse(textOf(asToonResult({ runId: 'run-1' })))).toEqual({ runId: 'run-1' })
  })
})

describe('isToolErrorPayload', () => {
  it('recognizes the shared writers\' error payload so a tool reports it instead of returning it as data', () => {
    // The authoring writers return `{ error }` rather than throwing; a tool that
    // failed this check would hand the agent a success-shaped result whose body
    // happens to say the write failed.
    expect(isToolErrorPayload({ error: 'feature not found: ghost' })).toBe(true)
    expect(isToolErrorPayload({ error: 'name already taken', statusCode: 409 })).toBe(true)
  })

  it('rejects a successful result, a non-object, and an error field that is not a message', () => {
    expect(isToolErrorPayload({ ok: true, written: ['e2e/checkout.spec.ts'] })).toBe(false)
    expect(isToolErrorPayload(null)).toBe(false)
    expect(isToolErrorPayload(undefined)).toBe(false)
    expect(isToolErrorPayload('feature not found')).toBe(false)
    // An `error: false`/`error: {…}` payload would render as the string "false"
    // or "[object Object]" if it were treated as a message.
    expect(isToolErrorPayload({ error: false })).toBe(false)
    expect(isToolErrorPayload({ error: { message: 'boom' } })).toBe(false)
  })
})

describe('hasText', () => {
  it('accepts only a string with something in it', () => {
    expect(hasText('checkout')).toBe(true)
    expect(hasText('   ')).toBe(false)
    expect(hasText('')).toBe(false)
    expect(hasText(undefined)).toBe(false)
    expect(hasText(null)).toBe(false)
    expect(hasText(42)).toBe(false)
  })
})

describe('summarizeUnifiedDiff', () => {
  it('counts files and changed lines without the hunk headers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      '-const port = 4000',
      '+const port = Number(process.env.PORT)',
      ' unchanged',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1,2 @@',
      '+added',
    ].join('\n')

    // The `---`/`+++` header lines start with - and + too; counting them would
    // report two extra changes per file.
    expect(summarizeUnifiedDiff(diff)).toEqual({ files: 2, additions: 2, deletions: 1 })
  })

  it('summarizes an empty diff as no change at all', () => {
    expect(summarizeUnifiedDiff('')).toEqual({ files: 0, additions: 0, deletions: 0 })
  })
})
