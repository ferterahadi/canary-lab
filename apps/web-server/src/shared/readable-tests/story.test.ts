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
      'Check that res.status is less than 300',
      'Check that call row status, if available equals “COMPLETED”',
      'Check that WhatsApp outbound is null',
    ])
    expect(storyItems(translated).map((step) => `${step.role}: ${step.text}`)).toEqual([
      'setup: Skip this scenario — “sync SQL not configured”',
      'setup: Create variable ids using “fallback-A”',
      'action: Send call using ids and an object with call status override set to “COMPLETED”, saving the result as res',
      'check: Check that res.status is less than 300',
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
      'res.status',
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

  it('keeps a zero-argument computed assertion visible without claiming its implementation', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: '{ expect(computeTotal()).toBe(2) }',
    })

    expect(textsFor(translated, 'check')).toEqual(['Check that compute total result equals 2'])
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
  expect(Array.isArray(payload.redirect_uris)).toBe(true)
}`,
    })

    expect(textsFor(translated, 'check')).toEqual([
      'Check that msgs has length 2',
      'Check that for every item in msgs, item pattern equals “TRIGGER_EMAIL_BATCH”',
      'Check that for every item in msgs, item data email info transaction identifier equals txId',
      'Check that payload.redirect_uris is a list',
    ])
  })

  it('keeps named helper and receiver-call assertions in the concise story', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  expect(isCleanExit(exit)).toBe(true)
  expect(consumer.logs()).toContain(DRAIN_COMPLETE_MARKER)
}`,
    })

    expect(textsFor(translated, 'check')).toEqual([
      'Check that is clean exit result using exit equals true',
      'Check that logs result from consumer contains drain complete marker',
    ])
  })

  it('keeps a list-membership check whose expected value is a call result', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  expect([401, 403]).not.toContain(res.status())
}`,
    })

    expect(textsFor(translated, 'check')).toEqual([
      'Check that a list containing 401, 403 does not contain response status',
    ])
    expect(storyItems(translated)[0].source).toEqual(
      expect.objectContaining({ startLine: 51, endLine: 51 }),
    )
  })

  it('keeps nested helper arguments in a saved HTTP request action', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const direct = await request.get('/health')
  const res = await request.get(v4Read(OWNED_TXN), { headers: headers(AUTH_A) })
  expect(res.status(), await res.text()).toBe(200)
}`,
    })

    expect(storyItems(translated).map((step) => step.text)).toEqual([
      'Send a GET request to “/health”, saving the result as direct',
      'Send a GET request to v4 read result using OWNED_TXN with an object with headers set to headers result using AUTH_A, saving the result as res',
      'Check that response status equals 200',
    ])
  })

  it('keeps URI-encoded template values inside a saved HTTP request action', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const res = await request.get(
    \`\${GATEWAY_URL}/v2/senders/\${encodeURIComponent(OWNED_SENDER)}\`,
    { headers: headers(AUTH_B) },
  )
  expect(res.status(), await res.text()).toBe(200)
}`,
    })

    expect(storyItems(translated).map((step) => step.text)).toEqual([
      'Send a GET request to “{gateway URL}/v2/senders/{owned sender encoded for a URL component}” with an object with headers set to headers result using AUTH_B, saving the result as res',
      'Check that response status equals 200',
    ])
    expect(storyItems(translated).map((step) => step.source)).toEqual([
      expect.objectContaining({ startLine: 51, endLine: 54 }),
      expect.objectContaining({ startLine: 55, endLine: 55 }),
    ])
  })

  it('keeps nested call results inside variables, properties, and request URLs', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const params = { from: formatDate(day), signature: sign(raw) }
  const audience = decodeToken(accessToken).aud
  const claim = decodeToken(accessToken)[claimName]
  const token = (await (await request.post(url, { data: payload })).json()).accessToken
  await request.get(\`/links/nonexistent-\${crypto.randomBytes(8).toString('hex')}\`)
}`,
    })

    expect(storyItems(translated).map((step) => step.text)).toEqual([
      'Set params to an object with from set to format date result using day and signature set to sign result using raw',
      'Set audience to decode token result using accessToken aud',
      'Set claim to decode token result using accessToken at claimName',
      'Set token to JSON result from post result from request using url and an object with data set to payload access token',
      'Send a GET request to “/links/nonexistent-{to string result from random bytes result from crypto using 8 using \\“hex\\”}”',
    ])
  })

  it('keeps a nested URL builder and the following UI helper in authored order', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  await page.goto(
    buildAuthorizeUrl({
      client,
      state,
      codeChallenge: challenge,
      redirectUri: callbackServer.redirectUri,
      resource: resourceUri,
    }),
  )
  await loginViaDashboardUi(page, client)
}`,
    })
    const steps = storyItems(translated)

    expect(steps.map((step) => step.text)).toEqual([
      'Open build authorize URL result using an object with client, state, code challenge set to challenge, redirect URI set to callback server redirect URI, resource set to resource URI',
      'Login via dashboard UI using page and client',
    ])
    expect(steps.map((step) => step.source)).toEqual([
      expect.objectContaining({ startLine: 51, endLine: 59 }),
      expect.objectContaining({ startLine: 60, endLine: 60 }),
    ])
  })

  it('preserves safe nested and computed request options while omitting executable object forms', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const response = await request.post(buildUrl(ENTITY_ID), {
    headers: buildHeaders(AUTH_TOKEN),
    'x-header': buildHeader(AUTH_TOKEN),
    retryCount,
    ...extraOptions,
  })
  await request.get(buildUrl(ENTITY_ID), { headers: () => submit() })
  await request.get(buildUrl(ENTITY_ID), { [headerName]: headerValue })
  await request.get(buildUrl(ENTITY_ID), { ...page[method]() })
  await request.get(buildUrl(ENTITY_ID), { configure() {} })
}`,
    })

    expect(storyItems(translated).map((step) => step.text)).toEqual([
      'Send a POST request to build URL result using ENTITY_ID with an object with headers set to build headers result using AUTH_TOKEN, x-header set to build header result using AUTH_TOKEN, retryCount, and everything in extraOptions, saving the result as response',
      'Send a GET request to build URL result using entity identifier using an object with property named by header name set to header value',
    ])
  })

  it('keeps typed collection lookups that feed later checks', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const sendMultiple = msgs.find((m) => m.pattern === 'SEND_MULTIPLE_EMAIL') as
    | SendMultipleMessage
    | undefined
  const triggerBatch = msgs.find((m) => m.pattern === 'TRIGGER_EMAIL_BATCH') as
    | TriggerBatchMessage
    | undefined
  const unsafe = msgs.find(predicate) as Message | undefined
  msgs.find((m) => m.ready)
  expect(sendMultiple).toBeDefined()
  expect(triggerBatch).toBeDefined()
}`,
    })

    expect(storyItems(translated).map((step) => step.text)).toEqual([
      'Find the first item in msgs where item pattern equals “SEND_MULTIPLE_EMAIL”, saving the result as sendMultiple',
      'Find the first item in msgs where item pattern equals “TRIGGER_EMAIL_BATCH”, saving the result as triggerBatch',
      'Find the first item in msgs matching predicate, saving the result as unsafe',
      'Check that send multiple is defined',
      'Check that trigger batch is defined',
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
      { text: 'response.status', kind: 'variable' },
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

  it('keeps a nested collection path exact and highlights it as one variable', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  expect(Array.isArray(res.data.data)).toBe(true)
}`,
    })

    const check = storyItems(translated).find((item) => item.role === 'check')
    expect(check?.text).toBe('Check that res.data.data is a list')
    expect(check?.spans).toContainEqual({ text: 'res.data.data', kind: 'variable' })
  })

  it('keeps a direct property assertion path exact and highlights it as one variable', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  expect(payload.contacts).toContain('ops@example.com')
}`,
    })

    const check = storyItems(translated).find((item) => item.role === 'check')
    expect(check?.text).toBe('Check that payload.contacts contains “ops@example.com”')
    expect(check?.spans).toContainEqual({ text: 'payload.contacts', kind: 'variable' })
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
      text: 'Create attempts as a list containing “a”, “b” transformed so each item becomes an object with message identifier set to item, transaction identifier set to sharedTxn',
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
      'Read the saved record, extracting properties destructured',
      'Use context',
      'Send only then',
      'order is submitted',
      'Check that line.entityId equals ids.entityId',
      'Check that foo equals bar',
      'Check that result passes the “unknown matcher” check',
    ]))
    const comparison = storyItems(translated).find((step) => step.text.includes('line.entityId'))
    expect(comparison?.spans.filter((span) => span.kind === 'variable').map((span) => span.text))
      .toEqual(['line.entityId', 'ids.entityId'])
    expect(storyItems(translated).find((step) => step.text === 'order is submitted')?.spans[0])
      .toEqual({ text: 'order', kind: 'variable' })
    expect(storyItems(translated).some((step) => step.text.includes('UnknownMatcher'))).toBe(false)
  })

  it('keeps property and thrown-error assertions in the concise story', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  expect(account).toHaveProperty('id')
  expect(() => parse(payload)).toThrow(TypeError)
}`,
    })

    expect(textsFor(translated, 'check')).toEqual([
      'Check that account has property “id”',
      'Check that calling parse using payload throws an error of type TypeError',
    ])
  })

  it('describes receiver-aware collection and string operations', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const ready = rows.filter((row) => row.enabled)
  const totalCount = records.reduce((s, r) => s + r.count, 0)
  const ordered = rows.toSorted((left, right) => left.rank - right.rank)
  const label = names.join(', ')
  const pieces = label.split(':', 2)
  const normalized = label.replaceAll('-', '_')
  const length = rows.push(nextRow)
  const removed = rows.splice(1, 2, replacement)
  rows.reverse()
}`,
    })

    expect(storyItems(translated).map((step) => step.text)).toEqual([
      'Set ready to rows filtered to keep each item where item enabled',
      "Set total count to the sum of each item's count in records",
      'Set ordered to rows sorted by comparing left item rank minus right item rank',
      'Set label to names joined with “, ”',
      'Set pieces to label split using “:”, limited to 2 items',
      'Set normalized to label with every match for “-” replaced by “_”',
      'Append nextRow to rows, saving the new length as length',
      'Modify rows starting at index 1, removing 2 items, inserting replacement, saving the removed items as removed',
      'Reverse rows',
    ])
  })

  it('preserves object and array destructuring details', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const { status: state = 'PENDING', meta: { id }, ...rest } = response
  const [, second = fallback, ...remaining] = values
  const { body, headers: responseHeaders } = await readResponse(request)
}`,
    })

    expect(storyItems(translated).map((step) => step.text)).toEqual([
      'Extract properties status as state, defaulting to “PENDING”, meta as a nested value with properties id, and remaining properties as rest from response',
      'Extract item 2 as second, defaulting to fallback and remaining items as remaining from values',
      'Read response using request, extracting properties body and headers as responseHeaders',
    ])
  })

  it('models each Promise combinator and keeps its operations nested', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  const all = await Promise.all([loadPrimary(), loadFallback()])
  const outcomes = await Promise.allSettled(tasks)
  Promise.race([readCache(), readNetwork()])
  const first = Promise.any([readReplica(), ...extraReads])
}`,
    })

    const items = storyItems(translated)
    expect(items.map((step) => step.text)).toEqual(expect.arrayContaining([
      'Run 2 operations together and wait for every one to finish, saving the result as all',
      'Load primary',
      'Load fallback',
      'Run the operations in tasks together and wait for every outcome, saving the result as outcomes',
      'Start 2 operations together and use the first one to settle',
      'Read cache',
      'Read network',
      'Start these operations together and use the first successful result, saving the combined promise as first',
      'Read replica',
      'Include every operation in extraReads',
    ]))
    expect(translated.story?.steps.map((step) => step.kind === 'flow' ? step.flowKind : 'step'))
      .toEqual(['scope', 'step', 'scope', 'scope'])
  })

  it('explains shorthand control and mutation without leaking operators', () => {
    const translated = translateReadableTest({
      ...INPUT,
      bodySource: `{
  ready && submitReady()
  cached || loadFallback()
  value ?? loadDefault()
  const selected = primary ? readPrimary() : readFallback()
  ready ? submitPreferred() : submitAlternate()
  handler?.()
  service?.flush(batch)
  count++
  --remaining
  retries *= 2
  result ??= fallback
  delete payload[key]
}`,
    })

    expect(storyItems(translated).map((step) => step.text)).toEqual([
      'If ready is true',
      'Send ready',
      'If cached is false',
      'Load fallback',
      'If value is null or undefined',
      'Load default',
      'If primary is true',
      'When the condition is true',
      'Read primary, saving the result as selected',
      'When the condition is false',
      'Read fallback, saving the result as selected',
      'If ready is true',
      'When the condition is true',
      'Send preferred',
      'When the condition is false',
      'Send alternate',
      'Call handler when available',
      'Flush on service using batch when available',
      'Increase count by 1',
      'Decrease remaining by 1',
      'Multiply retries by 2',
      'Conditionally set result to fallback when its current value is null or undefined',
      'Remove the property at key from payload',
    ])
  })
})
