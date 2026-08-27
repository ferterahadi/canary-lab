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

  it('returns exact source ranges with translated and explicit unresolved steps', () => {
    expect(translateReadableTest(INPUT)).toEqual({
      version: READABLE_TEST_VERSION,
      title: 'submits checkout',
      completeness: 'complete',
      nodes: [
        {
          id: expect.stringMatching(/^rt_[a-f0-9]{12}$/),
          kind: 'leaf',
          role: 'action',
          text: 'Open “/checkout”',
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
          role: 'helper',
          text: 'Run selected action',
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
            text: 'Enter “ada@example.com” in the control labelled “Email”',
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
                text: 'Click the “Sign in” button',
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

  it('expands supplied project-local helper bodies and humanizes unavailable helpers', () => {
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
        text: 'Login as',
        fidelity: 'derived',
        source: expect.objectContaining({ file: INPUT.file, startLine: 21 }),
        children: [
          expect.objectContaining({
            kind: 'leaf',
            text: 'Enter email in the control labelled “Email”',
            source: expect.objectContaining({ file: '/workspace/features/account/support/auth.ts', startLine: 9 }),
          }),
          expect.objectContaining({
            kind: 'leaf',
            text: 'Check that the “Sign in” button is visible',
            source: expect.objectContaining({ file: '/workspace/features/account/support/auth.ts', startLine: 10 }),
          }),
        ],
      }),
      expect.objectContaining({
        kind: 'leaf',
        role: 'helper',
        text: 'Seed account',
        fidelity: 'derived',
      }),
    ])
  })

  it('keeps computed calls unresolved because no stable helper name exists', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: '{ await page[method](targetFromEnvironment()) }',
    })
    expect(translated.completeness).toBe('partial')
    expect(translated.nodes[0]).toEqual(expect.objectContaining({
      kind: 'leaf',
      role: 'unknown',
      text: 'Review this source step',
      fidelity: 'unresolved',
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
      text: 'If mode equals “manual”',
      fidelity: 'derived',
      paths: [
        expect.objectContaining({
          text: 'Then',
          children: [expect.objectContaining({ text: 'Click the text “Continue”' })],
        }),
        expect.objectContaining({
          text: 'Otherwise',
          children: [expect.objectContaining({ text: 'Click the text “Start”' })],
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
      text: 'Choose based on state',
      paths: [
        expect.objectContaining({
          text: 'When “ready”',
          children: [
            expect.objectContaining({ text: 'Click the “Run” button' }),
            expect.objectContaining({ text: 'Leave this decision', fidelity: 'derived' }),
          ],
        }),
        expect.objectContaining({
          text: 'Otherwise',
          children: [expect.objectContaining({ text: 'Reload the page' })],
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
        text: 'For attempt starts at 0; while attempt is less than limit; increase attempt by 1',
        children: [expect.objectContaining({ text: 'Click the text “Retry”' })],
      }),
      expect.objectContaining({
        kind: 'loop',
        loopKind: 'for-of',
        text: 'For each item in items',
        children: [expect.objectContaining({ text: 'Click the text item label' })],
      }),
      expect.objectContaining({
        kind: 'loop',
        loopKind: 'for-await-of',
        text: 'For each event received from stream',
        children: [expect.objectContaining({ text: 'Click the text event message' })],
      }),
      expect.objectContaining({
        kind: 'loop',
        loopKind: 'while',
        text: 'While ready is true',
        children: [expect.objectContaining({ text: 'Reload the page' })],
      }),
      expect.objectContaining({
        kind: 'loop',
        loopKind: 'do-while',
        text: 'Run once, then repeat while stale is true',
        children: [expect.objectContaining({ text: 'Click the text “Refresh”' })],
      }),
    ])
  })

  it('derives loop counts only from statically safe integer bounds', () => {
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
        text: 'Repeat 3 times',
        count: 3,
      }),
      expect.objectContaining({
        kind: 'loop',
        text: 'For retry starts at start; while retry is less than limit; increase retry by step',
      }),
      expect.not.objectContaining({ count: expect.anything() }),
    ])
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
          paths: [expect.objectContaining({ children: [expect.objectContaining({ text: 'Skip to the next item' })] })],
        }),
        expect.objectContaining({
          kind: 'branch',
          paths: [expect.objectContaining({ children: [expect.objectContaining({ text: 'Stop repeating' })] })],
        }),
      ],
    }))
    expect(decision).toEqual(expect.objectContaining({
      kind: 'branch',
      paths: [expect.objectContaining({ children: [expect.objectContaining({ text: 'Leave this decision' })] })],
    }))
  })

  it('retains exact snippets and ranges for every unresolved source shape', () => {
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
    expect(translated.completeness).toBe('partial')
    expect(translated.nodes).toEqual([
      expect.objectContaining({
        fidelity: 'unresolved',
        source: {
          file: '/workspace/features/dynamic/e2e/dynamic.spec.js',
          startLine: 41,
          endLine: 41,
          snippet: 'const method = methods[index++]',
        },
      }),
      expect.objectContaining({
        fidelity: 'unresolved',
        source: {
          file: '/workspace/features/dynamic/e2e/dynamic.spec.js',
          startLine: 42,
          endLine: 42,
          snippet: 'await page[method](targetFromEnvironment())',
        },
      }),
      expect.objectContaining({
        role: 'check',
        text: 'expect(order).toSatisfyBusinessRule(rule)',
        fidelity: 'unresolved',
        source: {
          file: '/workspace/features/dynamic/e2e/dynamic.spec.js',
          startLine: 43,
          endLine: 43,
          snippet: 'expect(order).toSatisfyBusinessRule(rule)',
        },
      }),
    ])
  })
})
