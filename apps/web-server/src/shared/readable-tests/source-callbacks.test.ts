import { describe, expect, it } from 'vitest'
import { formatSourceSnippetForDisplay } from '../../../../../shared/code-display-format'
import type { ReadableStoryItem } from '../../../../../shared/readable-tests/types'
import { translateReadableSource } from './translator'

const flatten = (items: ReadableStoryItem[]): ReadableStoryItem[] => items.flatMap((item) => [item, ...(item.kind === 'flow' ? flatten(item.children) : [])])

describe('source-linked callback review', () => {
  it.each(['withStore<any>', 'repository.transaction<Result>', 'runIsolated', 'customHelper<Input, Output>'])(
    'splits nested lambdas for %s without inferring meaning from the helper name', (callee) => {
      // The generic inner call and expression body caused the entire wrapper to
      // become one syntax dump, hiding even the following assertion inside it.
      const source = `test('keeps record state', async () => {
  await isolated(async (context) => {
    const at = timestamp()
    await ${callee}((store) =>
      store.records.update({
        where: { id: context.id },
        data: { updatedAt: at, unreadCount: 1 },
      }),
    )
    expect(context.unreadCount).toBe(1)
  })
})`
      const steps = flatten(translateReadableSource('records.spec.ts', source).steps)
      expect(steps).toHaveLength(6)
      expect(steps[1]).toMatchObject({ kind: 'flow', headerEndLine: 2,
        text: 'Call isolated and wait for it to finish, passing an asynchronous arrow function receiving context. When called, run these statements:',
        source: { startLine: 2, endLine: 11 }, children: [
          { role: 'setup', text: 'Set constant at to the result of timestamp()', source: { startLine: 3, endLine: 3 } },
          { kind: 'flow', headerEndLine: 4, source: { startLine: 4, endLine: 9 }, children: [
            { text: 'Return the result of store.records.update with (an object with where set to (an object with id set to context.id); data set to (an object with updatedAt set to at; unreadCount set to 1))', source: { startLine: 5, endLine: 8 } },
          ] },
          { role: 'check', text: 'Check that context.unreadCount equals 1', source: { startLine: 10, endLine: 10 } },
        ],
      })
      expect(steps[3].text).toContain(`Call ${callee.split('<')[0]}`)
      expect(steps[3].text).toContain('and wait for it to finish, passing an arrow function receiving store. When called:')
      if (callee.includes('<')) expect(steps[3].text).toContain('with type argument')
      expect(steps.map((step) => step.text).join('\n')).not.toMatch(/call property|object literal|returning:|with argument:/)
      for (const [index, step] of steps.entries()) {
        expect(step.spans.map((span) => span.text).join('')).toBe(step.text)
        const snippet = source.split('\n').slice(step.source.startLine - 1, step.source.endLine).join('\n').trim()
        // The expression body ends before the enclosing call's argument comma.
        expect(step.source.snippet).toBe(formatSourceSnippetForDisplay(index === 4 ? snippet.slice(0, -1) : snippet))
      }
      expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length)
      expect(translateReadableSource('records.spec.ts', source).steps).toEqual(translateReadableSource('records.spec.ts', source).steps)
    },
  )

  it('keeps ordinary arguments and multiple callbacks in authored order with separate source links', () => {
    const source = `await custom<Result>(
  "scope",
  async (value: number = 1): Promise<number> => {
    const result = await load(value)
    return result
  },
  (error) => recover(error),
  ...extra
)`
    const [call] = translateReadableSource('callbacks.ts', source).steps
    expect(call).toMatchObject({ kind: 'flow', role: 'action', headerEndLine: 1, children: [
      { text: 'Argument 1: "scope"', source: { startLine: 2, endLine: 2 } },
      { kind: 'flow', headerEndLine: 3, source: { startLine: 3, endLine: 6 }, children: [
        { role: 'setup', text: 'Set constant result to the awaited result of load with value', source: { startLine: 4 } },
        { text: 'Return result', source: { startLine: 5 } },
      ] },
      { kind: 'flow', text: 'Argument 3: an arrow function receiving error. When called:', source: { startLine: 7 }, children: [
        { text: 'Return the result of recover with error', source: { startLine: 7 } },
      ] },
      { text: 'Argument 4: each item from extra as a separate argument', source: { startLine: 8 } },
    ] })
    const text = flatten([call]).map((item) => item.text).join('\n')
    for (const contract of ['Result', 'asynchronous', 'value', 'with default number 1', 'Promise', 'number']) expect(text).toContain(contract)
  })

  it.each(['', 'await '])('separates a callback returning %sa nested callback call', (awaited) => {
    const source = `await waitFor(async () => ${awaited}withSession<Client>(async client => {
  const value = await client.read()
  expect(value.count).toBe(1)
  return value.ready
}), "session ready")`
    const [call] = translateReadableSource('callbacks.ts', source).steps
    expect(call).toMatchObject({ kind: 'flow', children: [
      { kind: 'flow', children: [
        { kind: 'flow', text: `Call withSession with type argument \`Client\`${awaited ? ' and wait for it to finish' : ''} and return its result, passing an asynchronous arrow function receiving client. When called, run these statements:`, children: [
          { role: 'setup', text: 'Set constant value to the awaited result of client.read()', source: { startLine: 2 } },
          { role: 'check', text: 'Check that value.count equals 1', source: { startLine: 3 } },
          { text: 'Return value.ready', source: { startLine: 4 } },
        ] },
      ] },
      { text: 'Argument 2: "session ready"', source: { startLine: 5 } },
    ] })
    expect(flatten([call])).toHaveLength(7)
  })

  it.each([
    ['const result: Result = await collect<Item>(item => item.id)', 'constant result of type `Result`'],
    ['let result = collect(item => item.id)', 'variable result'],
    ['var result = collect(item => item.id)', 'function-scoped variable result'],
    ['return collect(item => item.id)', 'return its result'],
    ['return await collect(item => item.id)', 'wait for it to finish and return its result'],
  ])('preserves the enclosing call result: %s', (source, expected) => {
    const [call] = translateReadableSource('callbacks.ts', source).steps
    expect(call.text).toContain(expected)
    expect(call).toMatchObject({ kind: 'flow', children: [{ text: 'Return item.id' }] })
  })

  it.each([
    ['run(function named(value: number) { return value })', ['function expression', 'named', 'number']],
    ['run(async function* named<T extends Item = Item>(...values: T[]) { yield values })', ['async', 'generator', 'named', 'constrained to', 'with default', 'rest parameter', 'When the returned generator is advanced']],
    ['run(<const T extends Item = Item>(value: T): T => value)', ['arrow function', 'const type parameter', 'constrained to', 'with default', 'return type']],
  ])('retains full callback signatures without flattening the body: %s', (source, contract) => {
    const [call] = translateReadableSource('callbacks.ts', source).steps
    expect(call.kind).toBe('flow')
    expect(call.text).not.toMatch(/body:|returning:|yield:/)
    for (const part of contract) expect(call.text).toContain(part)
    expect(flatten([call])).toHaveLength(2)
  })

  it('distinguishes implicit returns, explicit returns, and calls without a return', () => {
    const sources = ['run(() => work())', 'run(() => { return work() })', 'run(() => { work() })']
    const stories = sources.map((source) => flatten(translateReadableSource('callbacks.ts', source).steps).map((step) => step.text))
    expect(stories[0][1]).toBe('Return the result of work()')
    expect(stories[1][1]).toBe('Return the result of work()')
    expect(stories[2][1]).toBe('Call work with no arguments')
    expect(new Set(stories.map((story) => story.join('\n'))).size).toBe(3)
  })

  it.each([
    'const { value } = run(() => work())', 'let value!: Result = run(() => work())',
    'using value = run(() => work())', 'export const value = run(() => work())',
    'run?.(() => work())', 'const value = (run(() => work()) as Result)',
    'run((() => work()) satisfies Callback)',
  ])('retains the complete expression for unsupported surrounding syntax: %s', (source) => {
    const [item] = translateReadableSource('callbacks.ts', source).steps
    expect(item.kind).not.toBe('flow')
    expect(item.text).toContain('run')
    expect(item.text).toContain('work')
    expect(item.source.snippet).toBe(source)
  })

  it.each(['function () { return work() }', '<T>(value: T) => value'])(
    'preserves callbacks inside collections without treating the collection as a callback: %s', (callback) => {
      const [item] = translateReadableSource('callbacks.ts', `run([${callback}])`).steps
      expect(item.kind).not.toBe('flow')
      expect(item.text).toContain('array literal')
      expect(item.text).toContain(callback.startsWith('function') ? 'function expression' : 'type parameter')
    },
  )

  it('retains complete inline callback behavior where the surrounding expression is not split', () => {
    const source = `const callbacks = [() => {}, async () => {
  if (!ready) return
  if (ready) { await run<Item>(value => value) } else return false
  debugger
}]`
    const [item] = translateReadableSource('callbacks.ts', source).steps
    expect(item.text).toContain('Do nothing.')
    expect(item.text).toContain('If ready is falsy:\n    Return without a value')
    expect(item.text).toContain('Call run with type argument `Item` and wait for it to finish. Pass these arguments in order:')
    expect(item.text).toContain('1. an arrow function receiving value that returns value')
    expect(item.text).toContain('Else:\n    Return false')
    expect(item.text).toContain('debugger')
  })

  it('keeps an inline predicate as a boolean return when stored in a callback collection', () => {
    const [item] = translateReadableSource('callbacks.ts', 'const predicates = [value => value.id === expectedId]').steps
    expect(item.text).toBe('Set constant predicates to a list containing (an arrow function receiving value that returns whether value.id is strictly equal to expectedId)')
  })

  it('keeps an authored step label when its callback is a function expression', () => {
    const [step] = translateReadableSource('callbacks.ts', `await test.step('Check state', function () { expect(ready).toBe(true) })`).steps
    expect(step).toMatchObject({ kind: 'flow', text: 'Check state', children: [{ role: 'check', text: 'Check that ready equals true' }] })
  })

  it('keeps typed parameterized group callbacks on their registration path', () => {
    const [group] = translateReadableSource('callbacks.ts', `describe.each([1])('group', async (value: number): Promise<void> => { expect(value).toBe(1) })`).steps
    expect(group).toMatchObject({ kind: 'flow', role: 'setup', children: [{ role: 'check', text: 'Check that value equals 1' }] })
    for (const detail of ['Test group: "group"', 'for each case in a list containing 1', 'with an asynchronous callback', 'receiving value of type number', 'returning type']) expect(group.text).toContain(detail)
  })
})
