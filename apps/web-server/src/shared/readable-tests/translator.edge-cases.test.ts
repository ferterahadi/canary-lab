import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { ReadableNode } from '../../../../../shared/readable-tests/types'
import { translateReadableTest, translateReadableTestFromAst, type ReadableTestInput } from './translator'

const BASE: ReadableTestInput = {
  file: '/workspace/features/readable/e2e/readable.spec.ts',
  title: 'renders edge cases',
  bodySource: '{}',
}

function translate(bodySource: string, input: Partial<ReadableTestInput> = {}) {
  return translateReadableTest({ ...BASE, ...input, bodySource })
}

function onlyNode(bodySource: string, input: Partial<ReadableTestInput> = {}): ReadableNode {
  const result = translate(bodySource, input)
  expect(result.nodes).toHaveLength(1)
  return result.nodes[0]
}

describe('readable translator parsing edges', () => {
  it('parses JavaScript and JSX variants with or without explicit body braces', () => {
    for (const file of ['scenario.js', 'scenario.jsx', 'scenario.ts', 'scenario.tsx']) {
      expect(translate('await page.reload()', { file })).toEqual(expect.objectContaining({
        completeness: 'complete',
        nodes: [expect.objectContaining({
          role: 'syntax',
          text: 'await:\n    call property `reload` of `page` with no arguments',
        })],
      }))
    }
  })

  it('translates an already-parsed block with absolute source lines', () => {
    const sourceFile = ts.createSourceFile(
      '/workspace/scenario.ts',
      `async function scenario() {
  await page.reload()
}`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const declaration = sourceFile.statements[0]
    if (!ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error('Expected a function body')

    expect(translateReadableTestFromAst({
      file: sourceFile.fileName,
      title: 'from AST',
      sourceFile,
      body: declaration.body,
    })).toEqual(expect.objectContaining({
      title: 'from AST',
      completeness: 'complete',
      nodes: [expect.objectContaining({
        text: 'await:\n    call property `reload` of `page` with no arguments',
        source: expect.objectContaining({ startLine: 2, endLine: 2 }),
      })],
    }))

    const dynamicSource = ts.createSourceFile(
      '/workspace/dynamic.ts',
      'async function scenario() { await page[method](computeTarget()) }',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const dynamicDeclaration = dynamicSource.statements[0] as ts.FunctionDeclaration
    expect(translateReadableTestFromAst({
      file: dynamicSource.fileName,
      title: 'dynamic from AST',
      sourceFile: dynamicSource,
      body: dynamicDeclaration.body as ts.Block,
      helpers: [{ name: 'unused', file: '/workspace/helpers.ts', bodySource: '{}' }],
    })).toEqual(expect.objectContaining({
      completeness: 'complete',
      nodes: [expect.objectContaining({
        fidelity: 'derived',
        text: 'await:\n    call element `method` of `page`\n    with argument:\n        call `computeTarget` with no arguments',
      })],
    }))
  })

  it('rethrows unexpected compiler failures instead of disguising them as source text', () => {
    const sourceFile = ts.createSourceFile(
      '/workspace/broken.ts',
      'x',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const malformedStatement = {
      kind: ts.SyntaxKind.ExpressionStatement,
      getStart: () => 0,
      getEnd: () => 1,
      getText: () => 'x',
      expression: undefined,
    } as unknown as ts.Statement
    const body = { statements: [malformedStatement] } as unknown as ts.Block

    expect(() => translateReadableTestFromAst({
      file: sourceFile.fileName,
      title: 'broken AST',
      sourceFile,
      body,
    })).toThrow(TypeError)
  })

  it('translates expression, return, variable, and malformed step calls without name interpretation', () => {
    const result = translate(`{
  (await firstHelper())
  return secondHelper()
  const result = thirdHelper()
  test.step()
  test.step(label, async () => {})
  test.step('inline callback', callback)
  test.step('expression body', async () => fourthHelper())
  suite.step('wrong receiver', async () => {})
}`)

    expect(result.nodes.slice(0, 3)).toEqual([
      expect.objectContaining({ role: 'syntax', text: 'group of:\n    await:\n        call `firstHelper` with no arguments' }),
      expect.objectContaining({ role: 'syntax', text: 'return:\n    call `secondHelper` with no arguments' }),
      expect.objectContaining({
        role: 'syntax',
        text: 'declare constant `result`\nand initialize it to:\n    call `thirdHelper` with no arguments',
      }),
    ])
    expect(result.nodes.slice(3).every((node) => node.fidelity === 'derived')).toBe(true)
    expect(result.nodes.slice(3).map((node) => node.text).join('\n')).toContain('property `step`')
    expect(result.completeness).toBe('complete')
  })

  it('accepts a function-expression test.step and retains standalone blocks', () => {
    const result = translate(`{
  await test.step('Function callback', async function () {
    await page.reload()
  })
  {
    await page.goBack()
  }
}`)

    expect(result.nodes).toEqual([
      expect.objectContaining({
        kind: 'group',
        text: 'Function callback',
        fidelity: 'exact',
        children: [expect.objectContaining({ text: 'await:\n    call property `reload` of `page` with no arguments' })],
      }),
      expect.objectContaining({
        kind: 'group',
        text: 'block',
        children: [expect.objectContaining({ text: 'await:\n    call property `goBack` of `page` with no arguments' })],
      }),
    ])
  })

  it('groups try, catch, and finally steps explicitly', () => {
    const result = translate(`{
  try {
    await page.reload()
  } catch (error) {
    await page.goBack()
  } finally {
    await page.waitForLoadState()
  }
  try {
    await page.goForward()
  } finally {
    await page.waitForLoadState()
  }
  try {
    await page.getByText('Retry').click()
  } catch (error) {
    await page.getByText('Recover').click()
  }
}`)

    expect(result.nodes[0]).toEqual(expect.objectContaining({
      kind: 'group',
      text: 'try',
      children: [
        expect.objectContaining({ text: 'await:\n    call property `reload` of `page` with no arguments' }),
        expect.objectContaining({ kind: 'group', text: 'on error caught as `error`' }),
        expect.objectContaining({ kind: 'group', text: 'finally' }),
      ],
    }))
    expect(result.nodes[1]).toEqual(expect.objectContaining({
      kind: 'group',
      children: [
        expect.objectContaining({ text: 'await:\n    call property `goForward` of `page` with no arguments' }),
        expect.objectContaining({ kind: 'group', text: 'finally' }),
      ],
    }))
    expect(result.nodes[2]).toEqual(expect.objectContaining({
      kind: 'group',
      children: [
        expect.objectContaining({ text: expect.stringContaining('string "Retry"') }),
        expect.objectContaining({ kind: 'group', text: 'on error caught as `error`' }),
      ],
    }))
  })
})

describe('readable translator loop edges', () => {
  it('describes omitted, expression, declaration, and destructured for-loop parts', () => {
    const result = translate(`{
  for (;;) { break }
  for (attempt = 0; attempt < 2; attempt + 1) { await page.reload() }
  for (attempt; ready; attempt++) { await page.reload() }
  for (let attempt; ready; attempt++) { await page.reload() }
  for (let [attempt] = attempts; ready; attempt++) { await page.reload() }
  for (let attempt = computeStart(); ready; updateAttempt()) { await page.reload() }
  for (let attempt = 0; ready; !attempt) { await page.reload() }
  for (let attempt = 0; ready; ++computeCounter()) { await page.reload() }
  for (let attempt = 0; ready; attempt += computeStep()) { await page.reload() }
  for (let attempt = 3; attempt > 0; --attempt) { await page.reload() }
  for (let attempt = 3; attempt > 0; attempt -= 2) { await page.reload() }
}`)

    expect(result.nodes.map((node) => node.text)).toEqual([
      'for loop',
      'for loop\nsetup:\n    assign `attempt` the value number 0\ncontinue while `attempt` is less than number 2\nafter each pass `attempt` plus number 1',
      'for loop\nsetup:\n    `attempt`\ncontinue while `ready` is truthy\nafter each pass:\n    increment `attempt` and yield the previous value',
      'for loop\nsetup:\n    declare variable `attempt`\ncontinue while `ready` is truthy\nafter each pass:\n    increment `attempt` and yield the previous value',
      'for loop\nsetup:\n    declare variable:\n        an array pattern binding:\n            bind element 0 to `attempt`\n    and initialize it to `attempts`\ncontinue while `ready` is truthy\nafter each pass:\n    increment `attempt` and yield the previous value',
      'for loop\nsetup:\n    declare variable `attempt`\n    and initialize it to:\n        call `computeStart` with no arguments\ncontinue while `ready` is truthy\nafter each pass:\n    call `updateAttempt` with no arguments',
      'for loop\nsetup:\n    declare variable `attempt` and initialize it to number 0\ncontinue while `ready` is truthy\nafter each pass not `attempt`',
      'for loop\nsetup:\n    declare variable `attempt` and initialize it to number 0\ncontinue while `ready` is truthy\nafter each pass:\n    increment call `computeCounter` with no arguments and yield the new value',
      'for loop\nsetup:\n    declare variable `attempt` and initialize it to number 0\ncontinue while `ready` is truthy\nafter each pass:\n    add and assign to `attempt`\n    the value:\n        call `computeStep` with no arguments',
      'for loop\nsetup:\n    declare variable `attempt` and initialize it to number 3\ncontinue while `attempt` is greater than number 0\nafter each pass:\n    decrement `attempt` and yield the new value',
      'for loop\nsetup:\n    declare variable `attempt` and initialize it to number 3\ncontinue while `attempt` is greater than number 0\nafter each pass:\n    subtract and assign to `attempt` the value number 2',
    ])
    expect(result.nodes.every((node) => node.fidelity === 'derived')).toBe(true)
  })

  it('describes expression and destructured for-of targets structurally', () => {
    const result = translate(`{
  for (item of items) { await page.reload() }
  for (const [item] of items) { await page.reload() }
  for (const item of computeItems()) { await page.reload() }
  for (computeItem() of items) { await page.reload() }
}`)

    expect(result.nodes).toEqual([
      expect.objectContaining({ text: 'for each assigning to `item`\nfrom iterable `items`', fidelity: 'derived' }),
      expect.objectContaining({
        text: 'for each constant:\n    an array pattern binding:\n        bind element 0 to `item`\nfrom iterable `items`',
        fidelity: 'derived',
      }),
      expect.objectContaining({
        text: 'for each constant `item`\nfrom iterable call `computeItems` with no arguments',
        fidelity: 'derived',
      }),
      expect.objectContaining({
        text: 'for each assigning to call `computeItem` with no arguments\nfrom iterable `items`',
        fidelity: 'derived',
      }),
    ])
  })

  it('keeps zero, one, inclusive, descending, and stepped bounds as source structure', () => {
    const sources = [
      'for (let i = 0; i < 1; i++) { page.reload() }',
      'for (let i = 2; i < 1; i++) { page.reload() }',
      'for (let i = 0; i <= 2; i += 1) { page.reload() }',
      'for (let i = 3; i <= 2; i++) { page.reload() }',
      'for (let i = 3; i > 0; i--) { page.reload() }',
      'for (let i = 0; i > 1; i--) { page.reload() }',
      'for (let i = 3; i >= 0; i -= 2) { page.reload() }',
      'for (let i = -1; i >= +1; i--) { page.reload() }',
      'for (let i = -2; i < +2; i += 2) { page.reload() }',
    ]

    for (const source of sources) {
      const node = onlyNode(source)
      expect(node).toEqual(expect.objectContaining({ kind: 'loop', fidelity: 'derived' }))
      expect(node).not.toHaveProperty('count')
      expect(node.text).toContain('for loop')
      expect(node.text).not.toContain('Repeat')
    }
  })

  it('never exposes inferred count metadata for dynamic or control-mutating loops', () => {
    const sources = [
      'for (i = 0; i < 3; i++) { page.reload() }',
      'for (let i = 0, j = 0; i < 3; i++) { page.reload() }',
      'for (let [i] = values; i < 3; i++) { page.reload() }',
      'for (let i; i < 3; i++) { page.reload() }',
      'for (let i = 0;; i++) { page.reload() }',
      'for (let i = 0; ready; i++) { page.reload() }',
      'for (let i = 0; j < 3; i++) { page.reload() }',
      'for (let i = 0; i < limit; i++) { page.reload() }',
      'for (let i = 0; i < 3;) { page.reload() }',
      'for (let i = 0; i < 3; j++) { page.reload() }',
      'for (let i = 0; i < 3; i += step) { page.reload() }',
      'for (let i = 0; i < 3; i += 0) { page.reload() }',
      'for (let i = 0; i < 3; i++) { break }',
      'for (let i = 0; i < 3; i++) { return }',
      'for (let i = 0; i < 3; i++) { throw error }',
      'for (let i = 0; i < 3; i++) { i++ }',
      'for (let i = 0; i < 3; i++) { --i }',
      'for (let i = 0; i < 3; i++) { i = 2 }',
      'for (let i = 0; i < 3; i++) { eval(code) }',
      'for (let i = 0; i !== 3; i++) { page.reload() }',
      'for (let i = -9007199254740991; i < 9007199254740991; i++) { page.reload() }',
      'for (let i = 9007199254740992; i < 3; i++) { page.reload() }',
      'for (let i = -9007199254740992; i < 3; i++) { page.reload() }',
      'for (let i = 0; i < 3; !i) { page.reload() }',
    ]

    for (const source of sources) {
      expect(onlyNode(source)).not.toHaveProperty('count')
    }
  })

  it('keeps loop controls and call conditions in canonical syntax', () => {
    const result = translate(`{
  break
  continue
  for (const item of items) {
    continue outer
  }
  while (computeReady()) { await page.reload() }
  do { await page.reload() } while (computeReady())
}`)

    expect(result.completeness).toBe('complete')
    expect(result.nodes[0]).toEqual(expect.objectContaining({ fidelity: 'derived', text: 'break' }))
    expect(result.nodes[1]).toEqual(expect.objectContaining({ fidelity: 'derived', text: 'continue' }))
    expect(result.nodes[2]).toEqual(expect.objectContaining({
      kind: 'loop',
      children: [expect.objectContaining({ fidelity: 'derived', text: 'continue to label `outer`' })],
    }))
    expect(result.nodes[3]).toEqual(expect.objectContaining({
      kind: 'loop',
      fidelity: 'derived',
      text: 'while call `computeReady` with no arguments is truthy',
    }))
    expect(result.nodes[4]).toEqual(expect.objectContaining({
      kind: 'loop',
      fidelity: 'derived',
      text: 'do\nthen repeat while call `computeReady` with no arguments is truthy',
    }))
  })
})

describe('readable translator branch and helper edges', () => {
  it('translates call conditions, subjects, cases, and explicit fallthrough structure', () => {
    const result = translate(`{
  if (computeMode()) await page.reload()
  switch (computeState()) {
    default:
    case computeCase():
      await page.goBack()
    case 'returned':
      return finish()
    case 'thrown':
      throw error
    case 'last':
      await page.reload()
  }
}`)

    expect(result.nodes[0]).toEqual(expect.objectContaining({
      kind: 'branch',
      fidelity: 'derived',
      text: 'if call `computeMode` with no arguments is truthy',
      paths: [expect.objectContaining({ text: 'then' })],
    }))
    expect(result.nodes[1]).toEqual(expect.objectContaining({
      kind: 'branch',
      fidelity: 'derived',
      text: 'switch on call `computeState` with no arguments',
      paths: [
        expect.objectContaining({ text: 'the default case' }),
        expect.objectContaining({ text: 'when case matches call `computeCase` with no arguments', fidelity: 'derived' }),
        expect.objectContaining({ text: 'when case matches string "returned"' }),
        expect.objectContaining({ text: 'when case matches string "thrown"' }),
        expect.objectContaining({ text: 'when case matches string "last"' }),
      ],
    }))
  })

  it('expands every available helper and guards recursive cycles', () => {
    const helpers: NonNullable<ReadableTestInput['helpers']> = [
      {
        name: 'onlyDynamicSource',
        file: '/workspace/helpers.ts',
        bodySource: '{ await page[method](computeTarget()) }',
      },
      {
        name: 'authoredGroup',
        file: '/workspace/helpers.ts',
        bodySource: "{ await test.step('Authored meaning', async () => { await page[method](computeTarget()) }) }",
      },
      {
        name: 'derivedGroup',
        file: '/workspace/helpers.ts',
        bodySource: '{ { await page.reload() } }',
      },
      {
        name: 'translatedLoop',
        file: '/workspace/helpers.ts',
        bodySource: '{ while (computeReady()) { await page.reload() } }',
      },
      {
        name: 'unresolvedBranch',
        file: '/workspace/helpers.ts',
        bodySource: '{ switch (computeState()) { case computeCase(): await page[method](computeTarget()) } }',
      },
      {
        name: 'derivedPath',
        file: '/workspace/helpers.ts',
        bodySource: "{ switch (computeState()) { case 'known': await page[method](computeTarget()) } }",
      },
      {
        name: 'recursiveHelper',
        file: '/workspace/helpers.ts',
        bodySource: '{ await recursiveHelper() }',
      },
    ]
    const result = translate(`{
  await onlyDynamicSource()
  await authoredGroup()
  await derivedGroup()
  await translatedLoop()
  await unresolvedBranch()
  await derivedPath()
  await recursiveHelper()
}`, { helpers })

    expect(result.nodes).toEqual([
      expect.objectContaining({ kind: 'group', text: 'await:\n    call `onlyDynamicSource` with no arguments' }),
      expect.objectContaining({ kind: 'group', text: 'await:\n    call `authoredGroup` with no arguments' }),
      expect.objectContaining({ kind: 'group', text: 'await:\n    call `derivedGroup` with no arguments' }),
      expect.objectContaining({ kind: 'group', text: 'await:\n    call `translatedLoop` with no arguments' }),
      expect.objectContaining({ kind: 'group', text: 'await:\n    call `unresolvedBranch` with no arguments' }),
      expect.objectContaining({ kind: 'group', text: 'await:\n    call `derivedPath` with no arguments' }),
      expect.objectContaining({
        kind: 'group',
        text: 'await:\n    call `recursiveHelper` with no arguments',
        children: [expect.objectContaining({
          kind: 'leaf',
          role: 'syntax',
          text: 'await:\n    call `recursiveHelper` with no arguments',
        })],
      }),
    ])
  })
})
