import { describe, expect, it } from 'vitest'
import type { ReadableStoryItem } from '../../../../../shared/readable-tests/types'
import { translateReadableTest } from './translator'

const INPUT = {
  file: '/workspace/features/flow/e2e/flow.spec.ts',
  title: 'preserves nested flow',
  startLine: 10,
}

function translate(bodySource: string) {
  return translateReadableTest({ ...INPUT, bodySource })
}

function storyItems(items: ReadableStoryItem[] | undefined): ReadableStoryItem[] {
  return (items ?? []).flatMap((item) => [
    item,
    ...(item.kind === 'flow' ? storyItems(item.children) : []),
  ])
}

describe('readable test story flow edge cases', () => {
  it('keeps a bare Promise sleep as a numbered action at its authored source line', () => {
    const translated = translate(`{
  const before = readBefore()
  await new Promise((r) => setTimeout(r, 10_000))
  const after = readAfter()
}`)

    const delay = storyItems(translated.story?.steps).find((item) => item.text === 'Delay for 10000 ms')
    expect(delay).toMatchObject({
      role: 'action',
      source: { startLine: 12, endLine: 12 },
    })
  })

  it('names map, forEach, function callbacks, and their nested work by purpose', () => {
    const translated = translate(`{
  const mapped = values.map((value) => {
    const request = makeRequest(value)
    return request
  })
  await items.forEach(async (item) => {
    await sendItem(item)
    expect(item.ready).toBe(true)
  })
  items.forEach((item) => sendSync(item))
  await withContext(async function (ctx) {
    while (ctx.ready) {
      await useContext(ctx)
      break
    }
  })
  await wrap(async () => sendWrapped())
  await wrap(async () => page[method]())
  await values.forEach(async () => sendWithoutParameter())
  await page[method]().forEach(async (item) => sendComputed(item))
  const spreadMapped = [...values].map((value) => value)
  const unresolvedMapped = [page[method]()].map((value) => value)
  const missingSource = page[method]().map((value) => value)
  values.map((value) => sendMapped(value))
  const noParameter = values.map(() => makeValue())
  const fallbackValues = [1, 2].map((value) => compute(value))
  const fallbackSpread = [...values].map((value) => compute(value))
  const unresolvedValues = [compute()].map((value) => compute(value))
  await test.step('Keep only the authored step', async () => {
    for (;;) { submitHiddenAction(); Promise.all([submitHiddenPromise()]); break; continue }
  })
}`)

    const items = storyItems(translated.story?.steps)
    expect(items.filter((item) => item.kind === 'flow').map((item) => `${item.flowKind}: ${item.text}`))
      .toEqual(expect.arrayContaining([
        'scope: Create mapped by transforming each value in values',
        'loop: For each item in items; asynchronous work may overlap',
        'loop: For each item in items',
        'scope: Using context as ctx',
        'loop: While ctx ready is true; this may run zero times',
      ]))
    expect(items.map((item) => item.text)).toEqual(expect.arrayContaining([
      'Create fallbackValues by transforming each value in the values 1 and 2',
      'Create fallbackSpread by transforming each value in a list containing all items of values',
      'Create variable request using value',
      'Return request',
      'Send item using item',
      'Check that item.ready equals true',
      'Use context using ctx',
      'Stop this loop',
      'Wrap',
      'Keep only the authored step',
    ]))
    expect(items.map((item) => item.text).join('\n')).not.toMatch(/\blambda\b|=>|`/)
  })

  it('describes retry callbacks, explicit timing, predicate forms, and safe fallbacks', () => {
    const translated = translate(`{
  const first = await pollUntil(
    async function () { return queryFirst() },
    { predicate: function (value) { return value?.ready === true }, timeoutMs: 1_000, pollMs: 250 },
  )
  const second = await pollUntil(
    () => querySecond(),
    {
      predicate: (value) => { const seen = value; return seen.ready },
      timeoutMs: page[timeoutMethod](),
      pollMs: pollIntervalMs,
    },
  )
  const predicate = (value) => value.ready
  await pollUntil(() => queryThird(), { predicate, [timeoutKey]: 250 })
  const fourth = await pollUntil(
    () => queryFourth(),
    { predicate: function (value) { value.ready } },
  )
  await pollUntil(() => queryTiny(), { 'timeoutMs': 10 })
  await pollUntil(() => expectedValue, { timeoutMs: 10 })
  await waitUntil(result)
  const genericWait = await waitUntil(result)
  const empty = createThing()
  await sendBatch((await buildRequest()), first, second, third)
  await sendBatch(page[method]())
}`)

    const items = storyItems(translated.story?.steps)
    const retries = items.filter((item) => item.kind === 'flow' && item.flowKind === 'retry')
    expect(retries.map((item) => item.text)).toEqual([
      'For up to 1 second, until the result ready equals true when available, retrying every 250 milliseconds, saving the matching result as first',
      'Until the expected result is ready, retrying every poll interval ms, saving the matching result as second',
      'Until the expected result is ready',
      'Until the expected result is ready, saving the matching result as fourth',
      'For up to 10 milliseconds, until the expected result is ready',
    ])
    expect(items.map((item) => item.text)).toEqual(expect.arrayContaining([
      'Read first',
      'Read second',
      'Read third',
      'Read fourth',
      'Wait for the expected result using result',
      'Wait for genericWait using result',
      'Create variable empty',
      'Send batch using build request result, first, second, and third',
    ]))
    expect(items.some((item) => item.text.includes('timeoutMethod'))).toBe(false)
  })

  it('keeps branch, try/catch/finally, and every loop form structurally honest', () => {
    const translated = translate(`{
  if (enabled) { submitEnabled() } else { submitDisabled() }
  if (page[method]()) { submitComputed() }
  switch (mode) {
    case 'primary': submitPrimary(); break
    default: submitDefault()
  }
  switch (page[method]()) {
    case page[caseMethod](): submitComputedCase()
  }
  try { submitTry() } catch (error) { logError(error) } finally { closeConnection() }
  try { submitTryAgain() } catch { recoverWithoutError() }
  try {} catch { /* exercises an empty catch path */ } finally {}
  for (let attempt = 0; attempt < limit; attempt += 1) { submitAttempt(attempt) }
  for (let pending; ; pending = nextPending()) { if (stop) break; continue }
  for (cursor = start; ready; cursor += step) { submitCursor() }
  for await (const event of stream) { submitEvent(event) }
  for (const item of page[method]()) { submitUnknownSource(item) }
  for (let { value } = source; ready; update()) { submitDestructured(value) }
  while (ready) { break }
  do { continue } while (ready)
  if (ignored) { debugger }
  switch (ignoredMode) { case 'ignored': debugger }
  outer: while (ready) { if (done) break outer; continue outer }
}`)

    const items = storyItems(translated.story?.steps)
    const flows = items.filter((item) => item.kind === 'flow')
    expect(flows.map((item) => `${item.flowKind}: ${item.text}`)).toEqual(expect.arrayContaining([
      'condition: If enabled is true',
      'condition: If the condition is true',
      'switch: Choose a path based on mode',
      'switch: Choose the first matching path',
      'case: When “primary” matches',
      'case: When no earlier value matches',
      'try: Attempt these steps',
      'catch: If the attempt fails, save the error as error',
      'catch: If the attempt fails',
      'finally: Whether the attempt succeeds or fails',
      'loop: Repeat, with attempt starts at 0, while attempt is less than limit, updating the loop value after each pass',
      'loop: Repeat, with start pending, until a step stops the loop, updating the loop value after each pass',
      'loop: Repeat, with the loop starting assignment, while ready is true, updating the loop value after each pass',
      'loop: Sequentially, asynchronously for each event in stream',
      'loop: Sequentially, for each item in the available values',
      'loop: Repeat, with the loop starting values, while ready is true, updating the loop value after each pass',
      'loop: While ready is true; this may run zero times',
      'loop: Run once, then repeat while ready is true',
    ]))
    expect(items.map((item) => item.text)).toEqual(expect.arrayContaining([
      'Stop this loop',
      'Leave this switch',
      'Skip to the next iteration',
      'Log error using error',
      'Close connection',
      'Leave outer',
      'Continue with the next iteration of outer',
    ]))
    expect(items.map((item) => item.text).join('\n')).not.toContain('`')
  })

  it('keeps legacy scope, comma sequences, debugger, and bare returns explicit', () => {
    const translated = translate(`{
  with (account) { submit(account) }
  with (computeAccount()) { submit(account) }
  with (account) {}
  prepare(), execute(), verify()
  debugger
  const first = 1, second = 2
  return
}`)

    const items = storyItems(translated.story?.steps)
    expect(items.map((item) => item.text)).toEqual([
      'Run these steps with account as the active scope',
      'Send the request using account',
      'Run these steps with the authored object as the active scope',
      'Send the request using account',
      'Run these steps in sequence',
      'Prepare test data',
      'Execute',
      'Check the expected outcome',
      'Pause at the debugger statement',
      'Set first to 1 and second to 2',
      'Return without a value',
    ])
    expect(items.map((item) => item.source)).toEqual([
      expect.objectContaining({ startLine: 11, endLine: 11 }),
      expect.objectContaining({ startLine: 11, endLine: 11 }),
      expect.objectContaining({ startLine: 12, endLine: 12 }),
      expect.objectContaining({ startLine: 12, endLine: 12 }),
      expect.objectContaining({ startLine: 14, endLine: 14 }),
      expect.objectContaining({ startLine: 14, endLine: 14 }),
      expect.objectContaining({ startLine: 14, endLine: 14 }),
      expect.objectContaining({ startLine: 14, endLine: 14 }),
      expect.objectContaining({ startLine: 15, endLine: 15 }),
      expect.objectContaining({ startLine: 16, endLine: 16 }),
      expect.objectContaining({ startLine: 17, endLine: 17 }),
    ])
  })

  it('keeps safe values inside an otherwise unresolved array argument', () => {
    const translated = translate(`{
  submit([computeValue(), ...extraValues])
  submit([computeValue(), ...((value) => extraValues)])
  submit({ regular: computeValue(), [field]: computeValue() })
  const missing = computeItems().find(predicate)
  const hiddenProperty = ((value) => value).result
  const hiddenElementOwner = ((value) => value)[key]
  const hiddenElementKey = account[(value) => value]
  if (ready) {}
  switch (mode) {}
  expect(total).toBe()
}`)

    expect(storyItems(translated.story?.steps).map((item) => item.text)).toEqual([
      'Send the request using a list containing compute value result, all items of extraValues',
      'Send the request',
      'Send the request using an object with regular set to compute value result and property named by field set to compute value result',
      'Set missing to find result from compute items result using predicate',
    ])
  })

  it('covers mutation variants and conservative destructuring fallbacks', () => {
    const translated = translate(`{
  const tail = rows.pop()
  rows.pop()
  const head = rows.shift()
  rows.shift()
  const length = rows.unshift(first, second)
  rows.unshift(first)
  const reversed = rows.reverse()
  rows.splice(1)
  rows.splice(1, 0, replacement)
  const sorted = rows.sort()
  rows.sort((left, right) => left.rank - right.rank)
  rows.push()
  rows.sort(compare)
  page[method]().push(row)
  rows.push(() => row)
  const { data } = await request.get('/orders')
  const {} = response
  const { [computeKey()]: computed } = response
  const { nested: [] } = response
  const [[]] = rows
  const { value = page[method]() } = response
  const { missing } = page[method]()
  const unresolved = page[method]() ? value : other
}`)

    const texts = storyItems(translated.story?.steps).map((item) => item.text)
    expect(texts).toEqual(expect.arrayContaining([
      'Remove the last item from rows, saving the removed item as tail',
      'Remove the last item from rows',
      'Remove the first item from rows, saving the removed item as head',
      'Remove the first item from rows',
      'Prepend first and second to rows, saving the new length as length',
      'Prepend first to rows',
      'Reverse rows, saving the result as reversed',
      'Modify rows starting at index 1',
      'Modify rows starting at index 1, removing 0 items, inserting replacement',
      'Sort rows using default ordering, saving the result as sorted',
      'Sort rows by comparing left item rank minus right item rank',
      'Send a GET request to “/orders”, extracting properties data',
    ]))
    expect(texts.join('\n')).not.toMatch(/compute key|nested|push|compare/)
  })

  it('covers Promise and shorthand-control variants without hiding sequence', () => {
    const translated = translate(`{
  Promise.all([singleTask()])
  Promise.all([])
  Promise.allSettled([taskPromise])
  const raced = await Promise.race([readPrimary(), readSecondary()])
  const accepted = await Promise.any([readFirst(), readSecond()])
  Promise.all([taskPromise, 42, ...extraTasks])
  Promise.all([taskPromise, ...page[method](), page[method](), service[method](() => submitNested())])
  Promise.all(tasks, options)
  Promise.all(() => taskPromise)
  ready && value
  computeReady() && recoverComputed()
  ready && ((recoverSatisfied()) satisfies Promise<void>)
  ready && items.forEach((item) => submitItem(item))
  computeReady() || recover()
  record.ready || recoverRecord()
  const selected = ready ? 'primary' : fallback
  const response = ready ? request.get('/primary') : request.get('/fallback')
  const configured = ready ? page.setViewportSize(primarySize) : page.setViewportSize(fallbackSize)
  const optionalResult = handler?.()
  ready ? page.goto('/ready') : count++
  ready ? withContext(async () => submitInside()) : submitOutside()
}`)

    const texts = storyItems(translated.story?.steps).map((item) => item.text)
    expect(texts).toEqual(expect.arrayContaining([
      'Start 1 operation together and combine their completion',
      'Start 0 operations together and combine their completion',
      'Start 1 operation together and collect every outcome',
      'Run 2 operations together and use the first one to settle, saving the result as raced',
      'Run 2 operations together and use the first successful result, saving the result as accepted',
      'Start these operations together and combine their completion',
      'Use taskPromise',
      'Use 42',
      'Include every operation in extraTasks',
      'Send nested',
      'If the left condition is true',
      'Recover computed',
      'Recover satisfied',
      'For each item in items',
      'Send item using item',
      'If it is false that the left condition',
      'Recover',
      'If record ready is false',
      'Recover record',
      'Use “primary” as selected',
      'Use fallback as selected',
      'Send a GET request to “/primary”, saving the result as response',
      'Send a GET request to “/fallback”, saving the result as response',
      'Set the browser viewport to primary size',
      'Set the browser viewport to fallback size',
      'Call handler when available, saving the result as optionalResult',
      'Open “/ready”',
      'Increase count by 1',
      'Using context',
      'Send inside',
      'Send outside',
    ]))
  })
})
