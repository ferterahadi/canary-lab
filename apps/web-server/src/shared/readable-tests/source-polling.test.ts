import { describe, expect, it } from 'vitest'
import type { ReadableStoryItem } from '../../../../../shared/readable-tests/types'
import { translateReadableSource } from './translator'

function rows(source: string, file = 'review.spec.ts'): ReadableStoryItem[] {
  const flatten = (items: ReadableStoryItem[]): ReadableStoryItem[] => items.flatMap((item) => [item, ...(item.kind === 'flow' ? flatten(item.children) : [])])
  return flatten(translateReadableSource(file, source).steps)
}

const english = (source: string): string => rows(source).map((item) => item.text).join('\n')

describe('polling checks in source review', () => {
  it('renders the reported sender check as a check with three readable lines and an exact source link', () => {
    const source = `await expect.poll(async()=>(await cns('/v4/whatsapp/senders/'+encodeURIComponent(senderBody.senderName))).data?.status,{timeout:180000,intervals:[1000,3000]}).toBe('VERIFIED');`
    const [check] = rows(source)
    expect(check.role).toBe('check')
    expect(check.text).toBe([
      'Poll until the returned value equals "VERIFIED"; wait for the check to finish',
      'On each attempt: read optional property status from (data from (the awaited result of cns with ("/v4/whatsapp/senders/" plus (the result of encodeURIComponent with senderBody.senderName)))), using an asynchronous callback',
      'Polling options: timeout set to 180000 milliseconds; retry intervals in milliseconds set to a list containing 1000, 3000',
    ].join('\n'))
    expect(check.source).toMatchObject({ file: 'review.spec.ts', startLine: 1, endLine: 1, snippet: source })
    expect(check.spans.map((span) => span.text).join('')).toBe(check.text)
    expect(check.text).not.toMatch(/of:\n|await:|call:|group of:/)
  })

  it.each(['@playwright/test', 'vitest'])(
    'preserves polling semantics in JavaScript and TypeScript using %s', (framework) => {
      const source = `import { expect } from '${framework}';\nawait expect.poll(readStatus, { timeout: limit, interval: delay, message: 'ready' }).not.toBe('PENDING')`
      for (const file of ['review.spec.js', 'review.spec.ts']) {
        const check = rows(source, file)[1]
        expect(check.role).toBe('check')
        expect(check.text).toBe([
          'Poll until the returned value does not equal "PENDING"; wait for the check to finish',
          'On each attempt: call readStatus',
          'Polling options: timeout set to limit milliseconds; retry interval set to delay milliseconds; failure message set to "ready"',
        ].join('\n'))
      }
    },
  )

  it.each([
    ['expect.poll(() => ready).toBeTruthy()', 'On each attempt: read ready'],
    ['expect.poll(read).toBeTruthy()', 'without awaiting the check'],
    ['await expect.poll(read).toBeTruthy()', 'wait for the check to finish'],
    ['expect.poll(read, "ready").toBeTruthy()', 'Failure message: "ready"'],
    ['expect.poll(read, options).toBeTruthy()', 'Polling options: options'],
    ['expect.poll(read, { ...options, timeout: 0 }).toBeTruthy()', 'all properties copied from options; timeout set to 0'],
    ['expect.poll(read, { timeout }).toBeTruthy()', 'shorthand property timeout'],
    ['expect.poll(read, {}).toBeTruthy()', 'Polling options: an empty object'],
    ['expect.poll(read, { "timeout": 20, [key]: value, custom: value }).toBeTruthy()', 'timeout set to 20 milliseconds; [key] set to value; custom set to value'],
    ['expect.poll(read).not.toHaveProperty("token", undefined)', 'does not have property "token" equal to undefined'],
    ['expect.poll(read).toBe(1, extra)', 'with matcher arguments extra'],
    ['expect.poll(async () => { const data = await read(); return data?.ready }).toBe(true)', 'runs these statements when called:\n  Set constant data to the awaited result of read()\n  Return optional property ready from data'],
    ['expect.poll((context) => context.ready).toBe(true)', 'an arrow function receiving context'],
    ['expect.poll((): boolean => ready).toBe(true)', 'with return type boolean'],
    ['expect.poll(<T>() => read<T>()).toBe(true)', 'type parameter'],
    ['expect.poll(function named() { return ready }).toBe(true)', 'named'],
  ])('preserves the callback, options and modifiers: %s', (source, expected) => {
    const [check] = rows(source)
    expect(check.role).toBe('check')
    expect(check.text).toContain(expected)
    expect(check.source.snippet).toBe(source)
    expect(check.spans.map((span) => span.text).join('')).toBe(check.text)
  })

  it.each([
    'expect.poll?.(read).toBe(1)', 'expect?.poll(read).toBe(1)', 'expect.poll<number>(read).toBe(1)',
    'expect.poll(read, options, extra).toBe(1)', 'expect.poll(read).resolves.toBe(1)',
    'expect.poll(read).toBe()', 'expect.poll(read).toCustomMatcher(1)',
  ])('retains the full call for unsupported polling forms: %s', (source) => {
    expect(english(source)).not.toContain('Poll until')
    expect(rows(source)[0].source.snippet).toBe(source)
  })

  it('does not interpret a generic poll helper as expect.poll', () => {
    expect(english('await poll(read, options)')).toBe('Call poll with read, options and wait for it to finish')
  })
})

describe('compact nested source expressions', () => {
  it.each([
    ['const value = response?.data?.status', 'optional property status from (optional property data from response)'],
    ['const value = rows[index + 1]?.status', 'optional property status from (item at (index plus 1) from rows)'],
    ['const value = rows?.[key()]', 'optional item at (the result of key()) from rows'],
    ['const value = status ?? fallback()', 'status, falling back to (the result of fallback()) only when the left value is null or undefined'],
    ['const value = (await load()) as Result', '(the awaited result of load()) asserted as type'],
    ['const value = <Result>load()', '(the result of load()) asserted with a prefix type assertion as'],
    ['const value = load() satisfies Result', '(the result of load()) checked against type'],
    ['const value = response!.status', 'status from (response asserted to be non-null)'],
  ])('keeps related expression families in prose: %s', (source, expected) => {
    const [item] = rows(source)
    expect(item.text).toContain(expected)
    expect(item.text).not.toContain('\n')
    expect(item.source.snippet).toBe(source)
  })

  it.each([
    ['a?.b.c', '(a?.b).c'], ['a?.[key].value', '(a?.[key]).value'],
    ['a?.b', 'a.b'], ['a?.[key]', 'a[key]'],
    ['a ?? b', 'a || b'], ['a ?? (b ?? c)', '(a ?? b) ?? c'],
    ['value as Result', 'value satisfies Result'], ['value!', 'value'],
    ['rows[first][second]', 'rows[second][first]'],
  ])('keeps semantically distinct expressions distinguishable: %s versus %s', (left, right) => {
    expect(english(`const value = ${left}`)).not.toBe(english(`const value = ${right}`))
  })
})
