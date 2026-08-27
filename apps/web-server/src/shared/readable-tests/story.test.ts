import { describe, expect, it } from 'vitest'
import type { ReadableStoryItem } from '../../../../../shared/readable-tests/types'
import { translateReadableTest } from './translator'

const INPUT = {
  file: '/workspace/features/cns/e2e/fallback.spec.ts',
  title: 'completed call does not fall back',
  startLine: 50,
}

function textsFor(
  translated: ReturnType<typeof translateReadableTest>,
  role: 'setup' | 'action' | 'check',
): string[] {
  return storyItems(translated).filter((step) => step.role === role).map((step) => step.text)
}

function storyItems(translated: ReturnType<typeof translateReadableTest>): ReadableStoryItem[] {
  const descend = (items: ReadableStoryItem[]): ReadableStoryItem[] => items.flatMap((item) => [
    item,
    ...(item.kind === 'flow' ? descend(item.children) : []),
  ])
  return descend(translated.story?.steps ?? [])
}

describe('readable test story', () => {
  it('summarizes a CNS scenario as setup, actions, and checks without source-code fallbacks', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  test.skip(!isSyncSqlConfigured(), 'sync sql not configured')
  const ids = makeIds('fallback-A')
  const res = await postSendCall(ids, { callStatusOverride: 'COMPLETED' })
  expect(res.status).toBeLessThan(300)
  await withSyncSqlConnection(async (conn) => {
    const callRow = await pollUntil(
      () => queryCallOutbound(conn, ids.messageId),
      { predicate: (row) => row?.status === 'COMPLETED' },
    )
    expect(callRow?.status).toBe('COMPLETED')
    const wa = await queryWhatsAppOutbound(conn, ids.messageId)
    expect(wa).toBeNull()
  })
}`,
    })

    expect(textsFor(translated, 'setup')).toEqual([
      'Skip this scenario — “sync SQL not configured”',
      'Create variable ids using “fallback-A”',
      'Using sync SQL connection as conn',
    ])
    expect(textsFor(translated, 'action')).toEqual([
      'Send call using ids and an object with call status override set to “COMPLETED”, saving the result as res',
      'Until the result status equals “COMPLETED” when available, saving the matching result as callRow',
      'Read call outbound using conn and ids.messageId',
      'Read WhatsApp outbound using conn and ids.messageId, saving the result as wa',
    ])
    expect(textsFor(translated, 'check')).toEqual([
      'Check that response status is less than 300',
      'Check that call row status, if available equals “COMPLETED”',
      'Check that WhatsApp outbound is null',
    ])
    expect(storyItems(translated).map((step) => `${step.role}: ${step.text}`)).toEqual([
      'setup: Skip this scenario — “sync SQL not configured”',
      'setup: Create variable ids using “fallback-A”',
      'action: Send call using ids and an object with call status override set to “COMPLETED”, saving the result as res',
      'check: Check that response status is less than 300',
      'setup: Using sync SQL connection as conn',
      'action: Until the result status equals “COMPLETED” when available, saving the matching result as callRow',
      'action: Read call outbound using conn and ids.messageId',
      'check: Check that call row status, if available equals “COMPLETED”',
      'action: Read WhatsApp outbound using conn and ids.messageId, saving the result as wa',
      'check: Check that WhatsApp outbound is null',
    ])
    const text = storyItems(translated).map((item) => item.text).join('\n')
    expect(text).not.toMatch(/\b(?:await|const|expect)\b|=>|[{}`]/)
    expect(storyItems(translated).flatMap((step) => (
      step.spans.filter((span) => span.kind === 'variable').map((span) => span.text)
    ))).toEqual(expect.arrayContaining([
      'ids',
      'res',
      'response',
      'connection',
      'call row',
      'WhatsApp outbound',
    ]))
    expect(translated.nodes).not.toHaveLength(0)
  })

  it('uses an authored test.step label as the concise action and keeps its checks', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  await test.step('Submit the checkout form', async () => {
    await page.getByRole('button', { name: 'Submit' }).click()
    expect(page.getByText('Order confirmed')).toBeVisible()
  })
}`,
    })

    expect(textsFor(translated, 'action')).toEqual(['Submit the checkout form'])
    expect(storyItems(translated).find((step) => step.role === 'action')?.fidelity).toBe('exact')
    expect(textsFor(translated, 'check')).toEqual([
      'Check that the text “Order confirmed” is visible',
    ])
  })

  it('keeps an unproven computed call out of the story while retaining its internal mapping', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: '{ await page[method](targetFromEnvironment()) }',
    })

    expect(translated.story).toBeUndefined()
    expect(translated.nodes).toHaveLength(1)
  })

  it('keeps proven checks inside an unproven callback wrapper', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  await page[method](targetFromEnvironment(), async () => {
    expect(result).toBe(true)
  })
}`,
    })

    expect(textsFor(translated, 'action')).toEqual([])
    expect(textsFor(translated, 'check')).toEqual([
      'Check that result equals true',
    ])
  })

  it('derives concise wording for generic helpers and aliases the matching saved record', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const response = await get()
  const wa = await queryWhatsAppOutbound()
  const sms = await querySmsOutbound()
  verifyDelivery()
  ensure()
  with_()
  await waitUntil()
  await _()
  expect(sms).toBeNull()
  return pollUntil()
}`,
    })

    expect(textsFor(translated, 'setup')).toContain('Use the required test context')
    expect(textsFor(translated, 'action')).toEqual(expect.arrayContaining([
      'Read the saved record, saving the result as response',
      'Wait for the expected result',
    ]))
    expect(textsFor(translated, 'check')).toEqual([
      'Check delivery',
      'Check the expected outcome',
      'Check that SMS outbound is null',
    ])
    expect(textsFor(translated, 'action')).not.toContain('Run the next step')
  })

  it('keeps valid function-style steps and treats malformed step calls as ordinary helpers', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  await test.step('Not an authored step', callback)
  await test.step('Confirm the order', async function () {
    submitOrder()
    ensureOrder()
  })
}`,
    })

    expect(textsFor(translated, 'action')).toEqual([
      'Step using “Not an authored step”',
      'Confirm the order',
    ])
    expect(textsFor(translated, 'check')).toEqual(['Check order'])
  })

  it('declares shared inputs once and keeps every safe argument in later actions', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const txId = createTxId('tx-42')
  const request = makeRequest(txId)
  await sendBatch(request, txId, 5, 'internal label')
}`,
    })

    expect(storyItems(translated).map((step) => step.text)).toEqual([
      'Create variable txId using “tx-42”',
      'Create variable request using txId',
      'Send batch using request, txId, 5, and “internal label”',
    ])
    expect(storyItems(translated).flatMap((step) => (
      step.spans.filter((span) => span.kind === 'variable').map((span) => span.text)
    ))).toEqual(expect.arrayContaining(['txId', 'request']))
  })

  it('keeps partially renderable template declarations as explicit setup', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const txId = \`bypass_multi_\${nowId()}\`
  const sharedTxn = \`eo-B-txn-\${Date.now()}-\${Math.random().toString(16).slice(2, 8)}\`
  const current = (\`\${now()}\`)
  const unsupported = \`\${() => { submit() }}\`
  await sendSeparateCalls(request, txId, [51, 52], 'bypass-multi')
  const res = await postSendCall(ids, {
    callStatusOverride: 'REJECTED',
    whatsappStatusOverride: 'FAILED',
  })
}`,
    })

    expect(storyItems(translated).map((step) => step.text)).toEqual([
      'Set txId to text made from “bypass_multi_” and the current-time identifier',
      'Set sharedTxn to text made from “eo-B-txn-”, the current time, “-”, and a random number as base 16 text sliced from 2 to 8',
      'Set current to text made from the current time',
      'Send separate calls using request, txId, a list containing 51, 52, and “bypass-multi”',
      'Send call using ids and an object with call status override set to “REJECTED”, WhatsApp status override set to “FAILED”, saving the result as res',
    ])
    expect(storyItems(translated).some((step) => step.text.includes('unsupported'))).toBe(false)
  })

  it('keeps every collection predicate assertion in the concise story', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const msgs = await drainQueue(txId)
  expect(msgs).toHaveLength(2)
  expect(msgs.every((m) => m.pattern === 'TRIGGER_EMAIL_BATCH')).toBe(true)
  expect(
    msgs.every((m) => (m as TriggerBatchMessage).data.emailInfo.transactionId === txId),
  ).toBe(true)
}`,
    })

    expect(textsFor(translated, 'check')).toEqual([
      'Check that msgs has length 2',
      'Check that for every item in msgs, item pattern equals “TRIGGER_EMAIL_BATCH”',
      'Check that for every item in msgs, item data email info transaction identifier equals txId',
    ])
  })

  it('highlights generic English grammar without product-specific vocabulary', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const request = buildInvoiceRequest(customerId)
  const response = await submitInvoice(request)
  expect(response.status).toBeGreaterThanOrEqual(200)
  expect(response.state).toBe('PAID')
  await page.waitForTimeout(10_000)
}`,
    })

    const items = storyItems(translated)
    const highlighted = new Set(items.flatMap((item) => item.spans.flatMap((span) => span.kind ?? [])))
    expect(highlighted).toEqual(new Set(['verb', 'variable', 'keyword', 'operator', 'number', 'literal']))
    expect(items.find((item) => item.text.includes('at least'))?.spans).toEqual(expect.arrayContaining([
      { text: 'response', kind: 'variable' },
      { text: 'is at least', kind: 'operator' },
      { text: '200', kind: 'number' },
    ]))
    expect(items.find((item) => item.text.includes('“PAID”'))?.spans).toEqual(expect.arrayContaining([
      { text: 'equals', kind: 'operator' },
      { text: '“PAID”', kind: 'literal' },
    ]))
    expect(items.find((item) => item.text.includes('10000'))?.spans)
      .toContainEqual({ text: '10000 milliseconds', kind: 'number' })
  })

  it('keeps mapping, callback, loop, and retry execution nested in the concise story', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const attempts = ['a', 'b'].map((suf) => ({ messageId: suf, transactionId: sharedTxn }))
  await withSyncSqlConnection(async (conn) => {
    for (const ids of attempts) {
      const res = await postSendCall(ids)
      expect(res.status).toBeLessThan(300)
      const callRow = await pollUntil(
        () => queryCallOutbound(conn, ids.messageId),
        { predicate: (row) => row?.status === 'REJECTED', timeoutMs: 60_000 },
      )
      expect(callRow?.status).toBe('REJECTED')
    }
  })
}`,
    })

    expect(translated.story?.steps[0]).toEqual(expect.objectContaining({
      role: 'setup',
      text: 'Create attempts by transforming each suf in the values “a” and “b”',
    }))
    const scope = translated.story?.steps[1]
    expect(scope).toEqual(expect.objectContaining({
      kind: 'flow',
      flowKind: 'scope',
      text: 'Using sync SQL connection as conn',
    }))
    if (scope?.kind !== 'flow') throw new Error('Expected the connection callback to be a story flow')
    const loop = scope.children[0]
    expect(loop).toEqual(expect.objectContaining({
      kind: 'flow',
      flowKind: 'loop',
      text: 'Sequentially, for each ids in attempts',
    }))
    if (loop?.kind !== 'flow') throw new Error('Expected the for-of statement to be a story flow')
    const retry = loop.children.find((item) => item.kind === 'flow' && item.flowKind === 'retry')
    expect(retry).toEqual(expect.objectContaining({
      text: 'For up to 60 seconds, until the result status equals “REJECTED” when available, saving the matching result as callRow',
      children: [expect.objectContaining({ text: 'Read call outbound using conn and ids.messageId' })],
    }))
    expect(loop.children.at(-1)).toEqual(expect.objectContaining({
      role: 'check',
      text: 'Check that call row status, if available equals “REJECTED”',
    }))
  })

  it('walks control-flow bodies while omitting nested declarations', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  function hiddenHelper() { submitHiddenFunction() }
  class HiddenHelper { run() { submitHiddenClass() } }
  { prepareBlock() }
  if (enabled) { submitIfBranch() } else { submitElseBranch() }
  switch (mode) {
    case 'primary': submitPrimaryCase(); break
    default: submitDefaultCase()
  }
  try { submitTryBody() } catch { submitCatchBody() }
  try { submitSecondTryBody() } finally { submitFinallyBody() }
  for (;;) { submitForBody(); break }
  for (const key in values) { submitForInBody(key) }
  for (const value of values) { submitForOfBody(value) }
  while (ready) { submitWhileBody(); break }
  do { submitDoBody() } while (ready)
}`,
    })

    const storyText = storyItems(translated).map((item) => item.text).join('\n')
    expect(storyText).toContain('Prepare block')
    expect(storyText).toContain('Send if branch')
    expect(storyText).toContain('Send catch body')
    expect(storyText).toContain('Send finally body')
    expect(storyText).toContain('Send for in body')
    expect(storyText).toContain('Send do body')
    expect(storyText).not.toContain('hidden')
    expect(storyText).toContain('While ready is true; this may run zero times')
    expect(storyText).toContain('Run once, then repeat while ready is true')
    expect(storyItems(translated).filter((item) => item.kind === 'flow').map((item) => item.flowKind))
      .toEqual(expect.arrayContaining([
        'condition',
        'then',
        'otherwise',
        'switch',
        'case',
        'try',
        'catch',
        'finally',
        'loop',
      ]))
    expect(storyText).toContain('Stop this loop')
    expect(storyText).not.toContain('`')
  })

  it('keeps sequence and variable spans deterministic across uncommon statement shapes', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const { destructured } = get()
  const stored = factory
  withContext({ method() { return stored } }, async () => {
    function localHelper() {}
  })
  if (enabled) { submitOnlyThen() }
  await test.step('order is submitted', async () => {
    expect(order).toBeDefined()
  })
  expect(line.entityId).toBe(ids.entityId)
  expect(foo).toBe(bar)
  expect(result).toUnknownMatcher()
}`,
    })

    expect(storyItems(translated).map((step) => step.text)).toEqual(expect.arrayContaining([
      'Read the saved record',
      'Use context',
      'Send only then',
      'order is submitted',
      'Check that line entity identifier equals identifiers entity identifier',
      'Check that foo equals bar',
    ]))
    const comparison = storyItems(translated).find((step) => step.text.includes('line entity'))
    expect(comparison?.spans.filter((span) => span.kind === 'variable').map((span) => span.text))
      .toEqual(['line', 'identifiers'])
    expect(storyItems(translated).find((step) => step.text === 'order is submitted')?.spans[0])
      .toEqual({ text: 'order', kind: 'variable' })
    expect(storyItems(translated).some((step) => step.text.includes('UnknownMatcher'))).toBe(false)
  })
})
