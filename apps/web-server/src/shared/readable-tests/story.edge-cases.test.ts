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
  await test.step('Keep only the authored step', async () => {
    for (;;) { submitHiddenAction(); break; continue }
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
      'Create variable request using value',
      'Return request',
      'Send item using item',
      'Check that item ready equals true',
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
      'Skip to the next iteration',
      'Log error using error',
      'Close connection',
    ]))
    expect(items.map((item) => item.text).join('\n')).not.toContain('`')
  })
})
