import { describe, expect, it } from 'vitest'
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
  return translated.story?.steps.filter((step) => step.role === role).map((step) => step.text) ?? []
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
      'Prepare unique identifiers',
      'Use sync SQL connection',
    ])
    expect(textsFor(translated, 'action')).toEqual([
      'Send call',
      'Wait for call row',
      'Read WhatsApp outbound',
    ])
    expect(textsFor(translated, 'check')).toEqual([
      'Check that response status is less than 300',
      'Check that call row status, if available equals “COMPLETED”',
      'Check that WhatsApp outbound is null',
    ])
    expect(translated.story?.steps.map((step) => `${step.role}: ${step.text}`)).toEqual([
      'setup: Skip this scenario — “sync SQL not configured”',
      'setup: Prepare unique identifiers',
      'action: Send call',
      'check: Check that response status is less than 300',
      'setup: Use sync SQL connection',
      'action: Wait for call row',
      'check: Check that call row status, if available equals “COMPLETED”',
      'action: Read WhatsApp outbound',
      'check: Check that WhatsApp outbound is null',
    ])
    const text = translated.story?.steps.map((item) => item.text).join('\n') ?? ''
    expect(text).not.toMatch(/\b(?:await|const|expect)\b|=>|[{}`]/)
    expect(translated.story?.steps.flatMap((step) => (
      step.spans.filter((span) => span.kind === 'variable').map((span) => span.text)
    ))).toEqual(expect.arrayContaining([
      'identifiers',
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
    expect(translated.story?.steps.find((step) => step.role === 'action')?.fidelity).toBe('exact')
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
      'Read the saved record',
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
      'Step',
      'Confirm the order',
    ])
    expect(textsFor(translated, 'check')).toEqual(['Check order'])
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

    const storyText = translated.story?.steps.map((item) => item.text).join('\n') ?? ''
    expect(storyText).toContain('Prepare block')
    expect(storyText).toContain('Send if branch')
    expect(storyText).toContain('Send catch body')
    expect(storyText).toContain('Send finally body')
    expect(storyText).toContain('Send for in body')
    expect(storyText).toContain('Send do body')
    expect(storyText).not.toContain('hidden')
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

    expect(translated.story?.steps.map((step) => step.text)).toEqual(expect.arrayContaining([
      'Read the saved record',
      'Use context',
      'Send only then',
      'order is submitted',
      'Check that line entity identifier equals identifiers entity identifier',
      'Check that foo equals bar',
    ]))
    const comparison = translated.story?.steps.find((step) => step.text.includes('line entity'))
    expect(comparison?.spans.filter((span) => span.kind === 'variable').map((span) => span.text))
      .toEqual(['line', 'identifiers'])
    expect(translated.story?.steps.find((step) => step.text === 'order is submitted')?.spans[0])
      .toEqual({ text: 'order', kind: 'variable' })
    expect(translated.story?.steps.some((step) => step.text.includes('UnknownMatcher'))).toBe(false)
  })
})
