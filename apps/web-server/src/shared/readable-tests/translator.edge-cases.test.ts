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
        nodes: [expect.objectContaining({ text: 'Reload the page' })],
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
        text: 'Reload the page',
        source: expect.objectContaining({ startLine: 2, endLine: 2 }),
      })],
    }))

    const unresolvedSource = ts.createSourceFile(
      '/workspace/unresolved.ts',
      'async function scenario() { await page[method](computeTarget()) }',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const unresolvedDeclaration = unresolvedSource.statements[0] as ts.FunctionDeclaration
    expect(translateReadableTestFromAst({
      file: unresolvedSource.fileName,
      title: 'partial from AST',
      sourceFile: unresolvedSource,
      body: unresolvedDeclaration.body as ts.Block,
      helpers: [{ name: 'unused', file: '/workspace/helpers.ts', bodySource: '{}' }],
    }).completeness).toBe('partial')
  })

  it('recognizes expression, return, and variable helper calls but not malformed authored steps', () => {
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
      expect.objectContaining({ role: 'helper', text: 'First helper' }),
      expect.objectContaining({ role: 'helper', text: 'Second helper' }),
      expect.objectContaining({ role: 'helper', text: 'Third helper' }),
    ])
    expect(result.nodes.slice(3)).toEqual(expect.arrayContaining([
      expect.objectContaining({ fidelity: 'unresolved' }),
    ]))
    expect(result.completeness).toBe('partial')
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
        children: [expect.objectContaining({ text: 'Reload the page' })],
      }),
      expect.objectContaining({
        kind: 'group',
        text: 'Grouped steps',
        children: [expect.objectContaining({ text: 'Go back to the previous page' })],
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
      text: 'Try these steps',
      children: [
        expect.objectContaining({ text: 'Reload the page' }),
        expect.objectContaining({ kind: 'group', text: 'If an error occurs' }),
        expect.objectContaining({ kind: 'group', text: 'Always afterward' }),
      ],
    }))
    expect(result.nodes[1]).toEqual(expect.objectContaining({
      kind: 'group',
      children: [
        expect.objectContaining({ text: 'Go forward to the next page' }),
        expect.objectContaining({ kind: 'group', text: 'Always afterward' }),
      ],
    }))
    expect(result.nodes[2]).toEqual(expect.objectContaining({
      kind: 'group',
      children: [
        expect.objectContaining({ text: 'Click the text “Retry”' }),
        expect.objectContaining({ kind: 'group', text: 'If an error occurs' }),
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
      'For use no initializer; while no source condition; use no update',
      'For attempt = 0; while attempt is less than 2; attempt plus 1',
      'For attempt; while ready; increase attempt by 1',
      'For use attempt; while ready; increase attempt by 1',
      'For [attempt] = attempts; while ready; increase attempt by 1',
      'For attempt starts at computeStart(); while ready; updateAttempt()',
      'For attempt starts at 0; while ready; not attempt',
      'For attempt starts at 0; while ready; ++computeCounter()',
      'For attempt starts at 0; while ready; attempt += computeStep()',
      'Repeat 3 times',
      'Repeat 2 times',
    ])
    expect(result.nodes.slice(1, 9).map((node) => node.fidelity)).toEqual([
      'unresolved',
      'derived',
      'derived',
      'unresolved',
      'unresolved',
      'derived',
      'unresolved',
      'unresolved',
    ])
  })

  it('describes expression and destructured for-of variables conservatively', () => {
    const result = translate(`{
  for (item of items) { await page.reload() }
  for (const [item] of items) { await page.reload() }
  for (const item of computeItems()) { await page.reload() }
  for (computeItem() of items) { await page.reload() }
}`)

    expect(result.nodes).toEqual([
      expect.objectContaining({ text: 'For each item in items', fidelity: 'derived' }),
      expect.objectContaining({ text: 'For each const [item] in items', fidelity: 'unresolved' }),
      expect.objectContaining({ text: 'For each item in computeItems()', fidelity: 'unresolved' }),
      expect.objectContaining({ text: 'For each computeItem() in items', fidelity: 'unresolved' }),
    ])
  })

  it('derives zero, one, inclusive, descending, and stepped loop counts', () => {
    const cases: Array<[string, number, string]> = [
      ['for (let i = 0; i < 1; i++) { page.reload() }', 1, 'Repeat 1 time'],
      ['for (let i = 2; i < 1; i++) { page.reload() }', 0, 'Repeat 0 times'],
      ['for (let i = 0; i <= 2; i += 1) { page.reload() }', 3, 'Repeat 3 times'],
      ['for (let i = 3; i <= 2; i++) { page.reload() }', 0, 'Repeat 0 times'],
      ['for (let i = 3; i > 0; i--) { page.reload() }', 3, 'Repeat 3 times'],
      ['for (let i = 0; i > 1; i--) { page.reload() }', 0, 'Repeat 0 times'],
      ['for (let i = 3; i >= 0; i -= 2) { page.reload() }', 2, 'Repeat 2 times'],
      ['for (let i = -1; i >= +1; i--) { page.reload() }', 0, 'Repeat 0 times'],
      ['for (let i = -2; i < +2; i += 2) { page.reload() }', 2, 'Repeat 2 times'],
    ]

    for (const [source, count, text] of cases) {
      expect(onlyNode(source)).toEqual(expect.objectContaining({ count, text }))
    }
  })

  it('does not claim a count unless every counter assumption is statically safe', () => {
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

  it('keeps unresolved loop controls and conditions visible', () => {
    const result = translate(`{
  break
  continue
  for (const item of items) {
    continue outer
  }
  while (computeReady()) { await page.reload() }
  do { await page.reload() } while (computeReady())
}`)

    expect(result.completeness).toBe('partial')
    expect(result.nodes[0]).toEqual(expect.objectContaining({ fidelity: 'unresolved' }))
    expect(result.nodes[1]).toEqual(expect.objectContaining({ fidelity: 'unresolved' }))
    expect(result.nodes[2]).toEqual(expect.objectContaining({
      kind: 'loop',
      children: [expect.objectContaining({ fidelity: 'unresolved' })],
    }))
    expect(result.nodes[3]).toEqual(expect.objectContaining({ kind: 'loop', fidelity: 'unresolved' }))
    expect(result.nodes[4]).toEqual(expect.objectContaining({ kind: 'loop', fidelity: 'unresolved' }))
  })
})

describe('readable translator branch and helper edges', () => {
  it('marks unresolved conditions, subjects, cases, and switch fallthrough', () => {
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
      fidelity: 'unresolved',
      paths: [expect.objectContaining({ text: 'Then' })],
    }))
    expect(result.nodes[1]).toEqual(expect.objectContaining({
      kind: 'branch',
      fidelity: 'unresolved',
      paths: [
        expect.objectContaining({ text: 'Otherwise, then continue to the next case' }),
        expect.objectContaining({ text: 'When computeCase(), then continue to the next case', fidelity: 'unresolved' }),
        expect.objectContaining({ text: 'When “returned”' }),
        expect.objectContaining({ text: 'When “thrown”' }),
        expect.objectContaining({ text: 'When “last”' }),
      ],
    }))
  })

  it('expands only helpers with at least one meaningful translation and guards cycles', () => {
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
      expect.objectContaining({ kind: 'leaf', role: 'helper', text: 'Only dynamic source' }),
      expect.objectContaining({ kind: 'group', text: 'Authored group' }),
      expect.objectContaining({ kind: 'group', text: 'Derived group' }),
      expect.objectContaining({ kind: 'group', text: 'Translated loop' }),
      expect.objectContaining({ kind: 'leaf', role: 'helper', text: 'Unresolved branch' }),
      expect.objectContaining({ kind: 'group', text: 'Derived path' }),
      expect.objectContaining({
        kind: 'group',
        text: 'Recursive helper',
        children: [expect.objectContaining({ kind: 'leaf', role: 'helper', text: 'Recursive helper' })],
      }),
    ])
  })
})
