import { describe, expect, it } from 'vitest'
import {
  formatCodeForDisplay,
  formatCodeForDisplayWithLineMap,
  formatSourceSnippetForDisplay,
} from './code-display-format'

describe('formatCodeForDisplay', () => {
  it('formats compressed Playwright body snippets for display', () => {
    expect(formatCodeForDisplay("{ await stepLoginOnMain(ctx!) await stepReachPaymentPage(ctx!) await stepPaymentBranch(ctx!, 'decline') }")).toBe(`{
    await stepLoginOnMain(ctx!);
    await stepReachPaymentPage(ctx!);
    await stepPaymentBranch(ctx!, 'decline');
}`)
  })

  it('normalizes complete TypeScript snippets used in reports', () => {
    expect(formatCodeForDisplay("import { test } from '@playwright/test'\n\ntest('x', async ({ page }) => { await page.goto('/') })")).toBe(`import { test } from '@playwright/test';
test('x', async ({ page }) => { await page.goto('/'); });`)
  })

  it('returns an empty string for blank source', () => {
    expect(formatCodeForDisplay('   \n\t\n  ')).toBe('')
    expect(formatCodeForDisplayWithLineMap('   \n\t\n  ', 50)).toEqual({
      code: '',
      lineMap: [],
    })
  })

  it('falls back to the raw source when the printer emits nothing', () => {
    // A comment-only snippet parses to zero statements, so `printList` has
    // nothing to print and returns ''. Handing back the empty string would
    // silently blank the snippet in the report, so the raw source wins.
    const commentOnly = '// only a comment, no statements'
    expect(formatCodeForDisplay(commentOnly)).toBe(commentOnly)
  })

  it('maps every expanded display row back to a compressed source row', () => {
    const display = formatCodeForDisplayWithLineMap(
      '{ const payload={kind:\'order\',items:[1,2]}; await send(payload) }',
      40,
    )

    expect(display.code).toBe(`{
    const payload = { kind: 'order', items: [1, 2] };
    await send(payload);
}`)
    expect(display.lineMap).toEqual([
      { sourceLine: 40, sourceLines: [40] },
      { sourceLine: 40, sourceLines: [40] },
      { sourceLine: 40, sourceLines: [40] },
      { sourceLine: 40, sourceLines: [40] },
    ])
  })

  it('retains every origin row when multiline TypeScript is compacted', () => {
    const display = formatCodeForDisplayWithLineMap(
      [
        "const message = msgs.find((item) => item.kind === 'SEND') as",
        '  | SendMessage',
        '  | undefined',
      ].join('\n'),
      70,
    )

    expect(display.code).toBe(
      "const message = msgs.find((item) => item.kind === 'SEND') as SendMessage | undefined;",
    )
    expect(display.lineMap).toEqual([{
      sourceLine: 70,
      sourceLines: [70, 71, 72],
    }])
  })

  it('preserves comments and maps their formatted rows independently', () => {
    const display = formatCodeForDisplayWithLineMap([
      '{',
      '  // The comment explains why this request is intentionally repeated.',
      "  const payload={kind:'retry',attempt:2}",
      '  await send(payload)',
      '}',
    ].join('\n'), 100)

    expect(display.code).toContain('// The comment explains why this request is intentionally repeated.')
    expect(display.code).toContain("const payload = { kind: 'retry', attempt: 2 };")
    expect(display.lineMap.map((line) => line.sourceLine)).toEqual([100, 101, 102, 103, 104])
  })

  it('keeps statement rows aligned after a template interpolation', () => {
    const display = formatCodeForDisplayWithLineMap([
      '{',
      '  const txId = `batch_17_${nowId()}`',
      '',
      '  // 3 + 5 + 9 = 17 emails, all < 50 per call → batch-processor.',
      '  // Delay queue (x-max-length=1) accepts the first trigger; subsequent ones are rejected.',
      '  // After 20s TTL the single TRIGGER_EMAIL_BATCH dead-letters to NOTIFIER_QUEUE.',
      "  await sendSeparateCalls(request, txId, [3, 5, 9], 'batch-17')",
      '',
      '  const msgs = await drainNotifierQueue(txId, 1, 60_000)',
      '',
      '  expect(msgs).toHaveLength(1)',
      "  expect(msgs[0].pattern).toBe('TRIGGER_EMAIL_BATCH')",
      '  expect((msgs[0] as TriggerBatchMessage).data.emailInfo.transactionId).toBe(txId)',
      '}',
    ].join('\n'), 22)

    expect(display.lineMap.map((line) => line.sourceLine)).toEqual([
      22,
      23,
      25,
      26,
      27,
      28,
      30,
      32,
      33,
      34,
      35,
    ])
  })

  it('keeps mapping through each interpolation in one template', () => {
    const display = formatCodeForDisplayWithLineMap([
      '{',
      '  const label = `${prefix}-${id}`',
      '',
      '  await send(label)',
      '}',
    ].join('\n'), 50)

    expect(display.lineMap.map((line) => line.sourceLine)).toEqual([50, 51, 53, 54])
  })

  it('gives token-free and recovered syntax a stable original source row', () => {
    const followingStatement = formatCodeForDisplayWithLineMap('const ready=true;\n;', 20)
    const onlyStatement = formatCodeForDisplayWithLineMap(';', 30)
    const recoveredSyntax = formatCodeForDisplayWithLineMap('{ const ready=true;', 40)

    expect(followingStatement.code).toBe('const ready = true;\n;')
    expect(followingStatement.lineMap).toEqual([
      { sourceLine: 20, sourceLines: [20] },
      { sourceLine: 21, sourceLines: [21] },
    ])
    expect(onlyStatement.lineMap).toEqual([{ sourceLine: 30, sourceLines: [30] }])
    expect(recoveredSyntax.lineMap).toEqual([
      { sourceLine: 40, sourceLines: [40] },
      { sourceLine: 40, sourceLines: [40] },
      { sourceLine: 40, sourceLines: [40] },
    ])
  })
})

describe('formatSourceSnippetForDisplay', () => {
  it('preserves blank lines and line count so lines map 1:1', () => {
    const body = ['{', '  const a = 1', '', '  expect(a).toBe(1)', '}'].join('\n')
    expect(formatSourceSnippetForDisplay(body)).toBe(body)
  })

  it('dedents nested bodies without adding or removing lines', () => {
    const input = ['{', '      const payload = build()', '', '      await send(payload)', '    }'].join('\n')
    const output = formatSourceSnippetForDisplay(input)
    expect(output.split('\n')).toHaveLength(input.split('\n').length)
    expect(output).toBe(['{', '  const payload = build()', '', '  await send(payload)', '}'].join('\n'))
  })

  it('leaves a single-line body untouched', () => {
    expect(formatSourceSnippetForDisplay('{ const x = 1; expect(x).toBe(1) }')).toBe('{ const x = 1; expect(x).toBe(1) }')
  })

})
