import { describe, expect, it } from 'vitest'
import { READABLE_TEST_VERSION } from '../../../../../shared/readable-tests/types'
import { translateReadableTest } from './translator'

const INPUT = {
  file: '/workspace/features/checkout/e2e/checkout.spec.ts',
  title: 'submits checkout',
  startLine: 20,
  bodySource: `{
  await page.goto('/checkout')
  await runSelectedAction(page)
}`,
}

describe('translateReadableTest structure', () => {
  it('returns deterministic opaque ids and the same tree for identical source', () => {
    const first = translateReadableTest(INPUT)
    const second = translateReadableTest(INPUT)

    expect(second).toEqual(first)
    expect(first.nodes.map((node) => node.id)).toEqual(second.nodes.map((node) => node.id))
    expect(first.nodes.map((node) => node.id)).toEqual([
      expect.stringMatching(/^rt_[a-f0-9]{12}$/),
      expect.stringMatching(/^rt_[a-f0-9]{12}$/),
    ])
  })

  it('returns exact source ranges with controlled-English statements', () => {
    expect(translateReadableTest(INPUT)).toEqual({
      version: READABLE_TEST_VERSION,
      title: 'submits checkout',
      completeness: 'complete',
      story: {
        steps: [
          {
            id: expect.stringMatching(/^rt_[a-f0-9]{12}$/),
            role: 'action',
            text: 'Open “/checkout”',
            spans: [
              { text: 'Open', kind: 'verb' },
              { text: ' ' },
              { text: '“/checkout”', kind: 'literal' },
            ],
            fidelity: 'derived',
            source: {
              file: '/workspace/features/checkout/e2e/checkout.spec.ts',
              startLine: 21,
              endLine: 21,
              snippet: "await page.goto('/checkout')",
            },
          },
          {
            id: expect.stringMatching(/^rt_[a-f0-9]{12}$/),
            role: 'action',
            text: 'Run selected action using page',
            spans: [
              { text: 'Run', kind: 'verb' },
              { text: ' selected action ' },
              { text: 'using', kind: 'keyword' },
              { text: ' ' },
              { text: 'page', kind: 'variable' },
            ],
            fidelity: 'derived',
            source: {
              file: '/workspace/features/checkout/e2e/checkout.spec.ts',
              startLine: 22,
              endLine: 22,
              snippet: 'await runSelectedAction(page)',
            },
          },
        ],
      },
      nodes: [
        {
          id: expect.stringMatching(/^rt_[a-f0-9]{12}$/),
          kind: 'leaf',
          role: 'syntax',
          text: 'await:\n    call property `goto` of `page`\n    with argument string "/checkout"',
          english: expect.objectContaining({
            text: "Await `page.goto('/checkout')`.",
            semanticCategories: ['async', 'function-call'],
          }),
          fidelity: 'derived',
          source: {
            file: '/workspace/features/checkout/e2e/checkout.spec.ts',
            startLine: 21,
            endLine: 21,
            snippet: "await page.goto('/checkout')",
          },
        },
        {
          id: expect.stringMatching(/^rt_[a-f0-9]{12}$/),
          kind: 'leaf',
          role: 'syntax',
          text: 'await:\n    call `runSelectedAction`\n    with argument `page`',
          english: expect.objectContaining({
            text: 'Await `runSelectedAction(page)`.',
            semanticCategories: ['async', 'function-call'],
          }),
          fidelity: 'derived',
          source: {
            file: '/workspace/features/checkout/e2e/checkout.spec.ts',
            startLine: 22,
            endLine: 22,
            snippet: 'await runSelectedAction(page)',
          },
        },
      ],
    })
  })

  it('marks an empty test complete because no source was left unexplained', () => {
    expect(translateReadableTest({ ...INPUT, bodySource: '{}'})).toEqual({
      version: READABLE_TEST_VERSION,
      title: 'submits checkout',
      completeness: 'complete',
      nodes: [],
    })
  })

  it('preserves literal and nested test.step labels with translated children', () => {
    const translated = translateReadableTest({
      ...INPUT,
      startLine: 10,
      bodySource: `{
  await test.step('Sign in as the account owner', async () => {
    await page.getByLabel('Email').fill('ada@example.com')
    await test.step('Submit the form', async () => {
      await page.getByRole('button', { name: 'Sign in' }).click()
    })
  })
}`,
    })

    expect(translated.completeness).toBe('complete')
    expect(translated.nodes).toEqual([
      expect.objectContaining({
        kind: 'group',
        text: 'Sign in as the account owner',
        fidelity: 'exact',
        source: expect.objectContaining({ startLine: 11, endLine: 16 }),
        children: [
          expect.objectContaining({
            kind: 'leaf',
            text:
              'await:\n    call:\n        property `fill`\n        of:\n            call property `getByLabel` of `page`\n            with argument string "Email"\n    with argument string "ada@example.com"',
            fidelity: 'derived',
            source: expect.objectContaining({ startLine: 12, endLine: 12 }),
          }),
          expect.objectContaining({
            kind: 'group',
            text: 'Submit the form',
            fidelity: 'exact',
            source: expect.objectContaining({ startLine: 13, endLine: 15 }),
            children: [
              expect.objectContaining({
                kind: 'leaf',
                text:
                  'await:\n    call:\n        property `click`\n        of:\n            call property `getByRole` of `page`\n            with arguments:\n                string "button"\n                an object literal with:\n                    property `name` set to string "Sign in"\n    with no arguments',
                source: expect.objectContaining({ startLine: 14, endLine: 14 }),
              }),
            ],
          }),
        ],
      }),
    ])
    // Authored `test.step` groups are not helper expansions — the UI keeps
    // showing their children.
    expect(translated.nodes[0]).not.toHaveProperty('origin')
  })

  it('expands supplied project-local helper bodies without interpreting helper names', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  await loginAs(page, email)
  await seedAccount(email)
}`,
      helpers: [{
        name: 'loginAs',
        file: '/workspace/features/account/support/auth.ts',
        startLine: 8,
        bodySource: `{
  await page.getByLabel('Email').fill(email)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
}`,
      }],
    })

    expect(translated.completeness).toBe('complete')
    expect(translated.nodes).toEqual([
      expect.objectContaining({
        kind: 'group',
        // Marked so the web UI can show just the call as one line while the
        // evaluation flowchart still descends into the children.
        origin: 'helper',
        text: 'await:\n    call `loginAs`\n    with arguments:\n        `page`\n        `email`',
        fidelity: 'derived',
        source: expect.objectContaining({ file: INPUT.file, startLine: 21 }),
        children: [
          expect.objectContaining({
            kind: 'leaf',
            text:
              'await:\n    call:\n        property `fill`\n        of:\n            call property `getByLabel` of `page`\n            with argument string "Email"\n    with argument `email`',
            source: expect.objectContaining({ file: '/workspace/features/account/support/auth.ts', startLine: 9 }),
          }),
          expect.objectContaining({
            kind: 'leaf',
            text:
              'await:\n    call:\n        property `toBeVisible`\n        of:\n            call `expect`\n            with argument:\n                call property `getByRole` of `page`\n                with arguments:\n                    string "button"\n                    an object literal with:\n                        property `name` set to string "Sign in"\n    with no arguments',
            source: expect.objectContaining({ file: '/workspace/features/account/support/auth.ts', startLine: 10 }),
          }),
        ],
      }),
      expect.objectContaining({
        kind: 'leaf',
        role: 'syntax',
        text: 'await:\n    call `seedAccount`\n    with argument `email`',
        fidelity: 'derived',
      }),
    ])
  })

  it('compiles same-file helper bodies together and preserves each source line', () => {
    const helperFile = '/workspace/features/account/support/helpers.ts'
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: '{ await outer() }',
      helpers: [
        {
          name: 'outer',
          file: helperFile,
          bodySource: 'await inner()',
        },
        {
          name: 'inner',
          file: helperFile,
          startLine: 40,
          bodySource: `{
  return true
}`,
        },
      ],
    })

    expect(translated.nodes[0]).toEqual(expect.objectContaining({
      origin: 'helper',
      children: [expect.objectContaining({
        origin: 'helper',
        source: expect.objectContaining({ file: helperFile, startLine: 1 }),
        children: [expect.objectContaining({
          source: expect.objectContaining({ file: helperFile, startLine: 41 }),
        })],
      })],
    }))
  })

  it('translates computed calls structurally instead of falling back to source', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: '{ await page[method](targetFromEnvironment()) }',
    })
    expect(translated.completeness).toBe('complete')
    expect(translated.nodes[0]).toEqual(expect.objectContaining({
      kind: 'leaf',
      role: 'syntax',
      text: 'await:\n    call element `method` of `page`\n    with argument:\n        call `targetFromEnvironment` with no arguments',
      fidelity: 'derived',
    }))
  })

  it('preserves if and else children as separate branch paths', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  if (mode === 'manual') {
    await page.getByText('Continue').click()
  } else {
    await page.getByText('Start').click()
  }
}`,
    })
    expect(translated.completeness).toBe('complete')
    expect(translated.nodes[0]).toEqual(expect.objectContaining({
      kind: 'branch',
      text: 'if `mode` is strictly equal to string "manual"',
      fidelity: 'derived',
      paths: [
        expect.objectContaining({
          text: 'then',
          children: [expect.objectContaining({ text: expect.stringContaining('string "Continue"') })],
        }),
        expect.objectContaining({
          text: 'otherwise',
          children: [expect.objectContaining({ text: expect.stringContaining('string "Start"') })],
        }),
      ],
    }))
  })

  it('preserves switch cases and their nested actions without flattening', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  switch (state) {
    case 'ready':
      await page.getByRole('button', { name: 'Run' }).click()
      break
    default:
      await page.reload()
  }
}`,
    })
    expect(translated.nodes[0]).toEqual(expect.objectContaining({
      kind: 'branch',
      text: 'switch on `state`',
      paths: [
        expect.objectContaining({
          text: 'when case matches string "ready"',
          children: [
            expect.objectContaining({ text: expect.stringContaining('string "Run"') }),
            expect.objectContaining({ text: 'break', fidelity: 'derived' }),
          ],
        }),
        expect.objectContaining({
          text: 'the default case',
          children: [expect.objectContaining({ text: 'await:\n    call property `reload` of `page` with no arguments' })],
        }),
      ],
    }))
  })

  it('renders every supported loop as one node with a nested body', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  for (let attempt = 0; attempt < limit; attempt += 1) {
    await page.getByText('Retry').click()
  }
  for (const item of items) {
    await page.getByText(item.label).click()
  }
  for (const key in record) {
    visit(key)
  }
  for await (const event of stream) {
    await page.getByText(event.message).click()
  }
  while (ready) {
    await page.reload()
  }
  do {
    await page.getByText('Refresh').click()
  } while (stale)
}`,
    })

    expect(translated.completeness).toBe('complete')
    expect(translated.nodes).toEqual([
      expect.objectContaining({
        kind: 'loop',
        loopKind: 'for',
        text:
          'for loop\nsetup:\n    declare variable `attempt` and initialize it to number 0\ncontinue while `attempt` is less than `limit`\nafter each pass:\n    add and assign to `attempt` the value number 1',
        children: [expect.objectContaining({ text: expect.stringContaining('string "Retry"') })],
      }),
      expect.objectContaining({
        kind: 'loop',
        loopKind: 'for-of',
        text: 'for each constant `item`\nfrom iterable `items`',
        children: [expect.objectContaining({ text: expect.stringContaining('property `label` of `item`') })],
      }),
      expect.objectContaining({
        kind: 'loop',
        loopKind: 'for-in',
        text: 'for each constant `key`\nfrom the enumerable keys of `record`',
        children: [expect.objectContaining({ text: 'call `visit`\nwith argument `key`' })],
      }),
      expect.objectContaining({
        kind: 'loop',
        loopKind: 'for-await-of',
        text: 'for await each constant `event`\nfrom iterable `stream`',
        children: [expect.objectContaining({ text: expect.stringContaining('property `message` of `event`') })],
      }),
      expect.objectContaining({
        kind: 'loop',
        loopKind: 'while',
        text: 'while `ready` is truthy',
        children: [expect.objectContaining({ text: 'await:\n    call property `reload` of `page` with no arguments' })],
      }),
      expect.objectContaining({
        kind: 'loop',
        loopKind: 'do-while',
        text: 'do\nthen repeat while `stale` is truthy',
        children: [expect.objectContaining({ text: expect.stringContaining('string "Refresh"') })],
      }),
    ])
  })

  it('preserves loop syntax instead of replacing it with an inferred count', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.reload()
  }
  for (let retry = start; retry < limit; retry += step) {
    await page.reload()
  }
  for (let guarded = 0; guarded < 3; guarded += 1) {
    if (stop) break
    await page.reload()
  }
}`,
    })
    expect(translated.nodes).toEqual([
      expect.objectContaining({
        kind: 'loop',
        text:
          'for loop\nsetup:\n    declare variable `attempt` and initialize it to number 0\ncontinue while `attempt` is less than number 3\nafter each pass:\n    add and assign to `attempt` the value number 1',
      }),
      expect.objectContaining({
        kind: 'loop',
        text:
          'for loop\nsetup:\n    declare variable `retry` and initialize it to `start`\ncontinue while `retry` is less than `limit`\nafter each pass:\n    add and assign to `retry` the value `step`',
      }),
      expect.objectContaining({
        kind: 'loop',
        text:
          'for loop\nsetup:\n    declare variable `guarded` and initialize it to number 0\ncontinue while `guarded` is less than number 3\nafter each pass:\n    add and assign to `guarded` the value number 1',
      }),
    ])
    expect(translated.nodes.every((node) => !('count' in node))).toBe(true)
  })

  it('renders break and continue according to their nearest control target', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  for (const item of items) {
    if (!item.enabled) continue
    if (item.done) break
  }
  switch (state) {
    case 'ready':
      break
  }
}`,
    })
    const loop = translated.nodes[0]
    const decision = translated.nodes[1]
    expect(loop).toEqual(expect.objectContaining({
      kind: 'loop',
      children: [
        expect.objectContaining({
          kind: 'branch',
          paths: [expect.objectContaining({ children: [expect.objectContaining({ text: 'continue' })] })],
        }),
        expect.objectContaining({
          kind: 'branch',
          paths: [expect.objectContaining({ children: [expect.objectContaining({ text: 'break' })] })],
        }),
      ],
    }))
    expect(decision).toEqual(expect.objectContaining({
      kind: 'branch',
      paths: [expect.objectContaining({ children: [expect.objectContaining({ text: 'break' })] })],
    }))
  })

  it('translates dynamic source shapes without rendering their source as English', () => {
    const translated = translateReadableTest({
      file: '/workspace/features/dynamic/e2e/dynamic.spec.js',
      title: 'uses runtime-selected behavior',
      startLine: 40,
      bodySource: `{
  const method = methods[index++]
  await page[method](targetFromEnvironment())
  expect(order).toSatisfyBusinessRule(rule)
}`,
    })
    expect(translated.completeness).toBe('complete')
    expect(translated.nodes).toEqual([
      expect.objectContaining({
        role: 'syntax',
        fidelity: 'derived',
        text: 'declare constant `method` and initialize it to element increment `index` and yield the previous value of `methods`',
        source: {
          file: '/workspace/features/dynamic/e2e/dynamic.spec.js',
          startLine: 41,
          endLine: 41,
          snippet: 'const method = methods[index++]',
        },
      }),
      expect.objectContaining({
        role: 'syntax',
        fidelity: 'derived',
        text: 'await:\n    call element `method` of `page`\n    with argument:\n        call `targetFromEnvironment` with no arguments',
        source: {
          file: '/workspace/features/dynamic/e2e/dynamic.spec.js',
          startLine: 42,
          endLine: 42,
          snippet: 'await page[method](targetFromEnvironment())',
        },
      }),
      expect.objectContaining({
        role: 'syntax',
        text: 'call:\n    property `toSatisfyBusinessRule`\n    of:\n        call `expect`\n        with argument `order`\nwith argument `rule`',
        fidelity: 'derived',
        source: {
          file: '/workspace/features/dynamic/e2e/dynamic.spec.js',
          startLine: 43,
          endLine: 43,
          snippet: 'expect(order).toSatisfyBusinessRule(rule)',
        },
      }),
    ])
  })

  it('translates the graceful-shutdown body without exposing source lines as English', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const { exit, elapsedMs } = await consumer.sigterm()
  expect(isCleanExit(exit)).toBe(true)
  expect(consumer.logs()).toContain(DRAIN_COMPLETE_MARKER)
}`,
    })

    expect(translated.completeness).toBe('complete')
    expect(translated.nodes).toHaveLength(3)
    expect(translated.nodes).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('an object pattern binding'),
        fidelity: 'derived',
      }),
      expect.objectContaining({
        text: expect.stringContaining('property `toBe`'),
        fidelity: 'derived',
      }),
      expect.objectContaining({
        text: expect.stringContaining('property `toContain`'),
        fidelity: 'derived',
      }),
    ])
    for (const node of translated.nodes) {
      expect(node.text).not.toBe(node.source.snippet)
      expect(node.fidelity).not.toBe('unresolved')
      expect(node.fidelity).not.toBe('unsupported')
    }
  })
})
