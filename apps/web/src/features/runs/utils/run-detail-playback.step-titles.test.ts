import { describe, expect, it } from 'vitest'

import type { PlaywrightPlaybackEvent } from '@shared/run-detail'
import { compactPlaybackSteps, playbackTests, type CompactStep } from './run-detail-playback'

// Step-title compaction, reached through `playbackTests` because that is the only
// way in — `compactStepTitle`, `harnessStepLabel` and `matcherPhrase` are module
// -private, and exporting them just to test them would widen the surface for the
// convenience of the test rather than of a caller.
//
// This file exists because these paths were the last thing keeping
// `features/runs/utils/**` out of the coverage gate. The matcher-phrase table and
// the harness-verb switch are pure lookups, so they are cheap to pin — and worth
// pinning, since a wrong phrase here silently reports the OPPOSITE of what a test
// asserted, in a pane whose whole job is to be evidence.

function stepsFor(titles: Array<{ title: string; category?: string }>): string[] {
  const events: PlaywrightPlaybackEvent[] = [
    {
      type: 'test-begin',
      time: '2026-01-01T00:00:00.000Z',
      test: { name: 'a.spec.ts:t', title: 't', location: 'a.spec.ts:1' },
    },
    ...titles.map((step, i): PlaywrightPlaybackEvent => ({
      type: 'step-begin',
      time: `2026-01-01T00:00:${String(i + 1).padStart(2, '0')}.000Z`,
      test: { name: 'a.spec.ts:t', title: 't' },
      step: { title: step.title, category: step.category ?? 'pw:api' },
    })),
  ]
  return playbackTests(events)[0].steps.map((s) => s.title)
}

describe('step-title compaction', () => {
  it('drops harness plumbing and bare screenshots entirely', () => {
    expect(stepsFor([
      { title: 'Launch browser' },
      { title: 'Create context' },
      { title: 'Dispose request context' },
      { title: 'screenshot' },
    ])).toEqual([])
  })

  it('renders an API request as method + path', () => {
    expect(stepsFor([{ title: 'GET "/api/orders/42"' }])).toEqual(['GET /api/orders/42'])
  })

  it('maps the harness\'s own page.* verbs, and drops the ones with nothing to say', () => {
    expect(stepsFor([
      { title: 'page.goto' },
      { title: 'page.click' },
      { title: 'page.fill' },
      // `screenshot` and `_expect` are deliberately unlabelled: neither describes
      // anything the reader of a trace can act on.
      { title: 'page.screenshot' },
      { title: 'page._expect' },
      // An unknown harness verb takes the same silent path rather than printing
      // a raw method name.
      { title: 'page.waitForTimeout' },
    ])).toEqual(['Opened page', 'Clicked page element', 'Filled field'])
  })

  it('phrases each known matcher, and negates it without flipping the meaning', () => {
    expect(stepsFor([
      { title: 'Expect "toBeVisible" getByRole(\'button\', { name: \'Pay\' })', category: 'expect' },
      { title: 'Expect "toBeHidden" getByTestId(\'spinner\')', category: 'expect' },
      { title: 'Expect "toBeEnabled" getByRole(\'button\', { name: \'Save\' })', category: 'expect' },
      { title: 'Expect "toBeDisabled" getByRole(\'button\', { name: \'Save\' })', category: 'expect' },
      { title: 'Expect "toBeChecked" getByLabel(\'Remember me\')', category: 'expect' },
      { title: 'Expect "toHaveText" getByTestId(\'total\')', category: 'expect' },
      { title: 'Expect "toHaveValue" getByLabel(\'Email\')', category: 'expect' },
      { title: 'Expect "toHaveURL" getByTestId(\'frame\')', category: 'expect' },
      { title: 'Expect "toContainText" getByTestId(\'summary\')', category: 'expect' },
    ])).toEqual([
      'Verified Pay is visible',
      // `getByTestId` targets read as "<id> control" — the id is not a name a
      // person chose, so the noun keeps the row honest about what it is.
      'Verified spinner control is hidden',
      'Verified Save is enabled',
      'Verified Save is disabled',
      'Verified Remember me is checked',
      'Verified total control has the expected text',
      'Verified Email has the expected value',
      'Verified frame control has the expected URL',
      'Verified summary control contains the expected text',
    ])
  })

  it('negates each phrase shape, and names the matcher when it has no phrase', () => {
    expect(stepsFor([
      { title: 'Expect "not.toBeVisible" getByTestId(\'error\')', category: 'expect' },
      { title: 'Expect "not.toHaveText" getByTestId(\'total\')', category: 'expect' },
      { title: 'Expect "not.toContainText" getByTestId(\'summary\')', category: 'expect' },
      // Unknown matcher: the phrase is empty, so a NEGATED one must still say so
      // — dropping the negation would assert the opposite of the test.
      { title: 'Expect "not.toBeFocused" getByTestId(\'input\')', category: 'expect' },
      { title: 'Expect "toBeFocused" getByTestId(\'input\')', category: 'expect' },
    ])).toEqual([
      'Verified error control is not visible',
      'Verified total control does not have the expected text',
      'Verified summary control does not contain the expected text',
      'Verified input control does not match toBeFocused',
      'Verified input control',
    ])
  })

  it('drops an assertion whose locator names nothing, leaving only the tally', () => {
    // The matcher parses, but what follows it is not a locator form the reader
    // could be shown — so the row is dropped and collapsed into the running
    // "Verified N assertions" tally instead of printing a half-sentence.
    expect(stepsFor([
      { title: 'Expect "toBeVisible" somethingUnrecognised()', category: 'expect' },
      { title: 'Expect "toBeVisible" alsoUnrecognised()', category: 'expect' },
    ])).toEqual(['Verified 2 assertions'])
  })

  it('falls back to counting the assertion when the matcher names no target', () => {
    // `Expect "toBe"` has nothing after the matcher, so `describeActionTarget`
    // finds no element. The row is kept and generic rather than dropped: the
    // reader still learns an assertion ran at this point in the trace.
    expect(stepsFor([{ title: 'Expect "toBe"', category: 'expect' }])).toEqual(['Verified 1 assertion'])
  })
})

describe('step rows', () => {
  const spec = '/repo/e2e/ledger.spec.ts'
  const check = (title: string, line: number, over: Partial<CompactStep> = {}): CompactStep => ({ title, category: 'expect', ended: true, location: `${spec}:${line}`, ...over })

  it('folds a loop’s labelled checks from one line into one row that keeps each label', () => {
    const rows = compactPlaybackSteps([check('run-a', 77), check('run-b', 77), check('run-c', 77, { ended: false }), check('after', 84)])
    expect(rows).toEqual([
      { title: 'Verified the same check 3 times', category: 'expect', ended: false, location: `${spec}:77`, count: 3, labels: ['run-a', 'run-b', 'run-c'] },
      { title: 'after', category: 'expect', ended: true, location: `${spec}:84` },
    ])
  })

  it('keeps the title of a repeat whose passes all read the same, and names a repeated action', () => {
    const click = (title: string): CompactStep => ({ title, category: 'pw:api', ended: true, location: `${spec}:9` })
    expect(compactPlaybackSteps([click('Click "Next"'), click('Click "Next"')])).toEqual([{ title: 'Clicked Next', category: 'pw:api', ended: true, location: `${spec}:9`, count: 2 }])
    expect(compactPlaybackSteps([click('Click "A"'), click('Click "B"')])[0]).toMatchObject({ title: 'Ran the same step 2 times', labels: ['Clicked A', 'Clicked B'] })
  })

  it('never folds steps from different lines, or steps with no recorded line', () => {
    expect(compactPlaybackSteps([check('a', 1), check('b', 2)]).map((r) => r.title)).toEqual(['a', 'b'])
    const bare = (title: string): CompactStep => ({ title, category: 'expect', ended: true })
    expect(compactPlaybackSteps([bare('a'), bare('b')]).map((r) => r.count)).toEqual([undefined, undefined])
  })

  it('folds a loop whose body runs several lines into one row per body line', () => {
    const rows = compactPlaybackSteps([
      check('before', 90),
      check('hour 1 count', 94), check('hour 1 minute', 98),
      check('hour 2 count', 94), check('hour 2 minute', 98, { ended: false }),
      check('hour 3 count', 94),
      check('after', 112),
    ])
    expect(rows.map(({ title, location, count, labels, ended }) => ({ title, line: location?.split(':').at(-1), count, labels, ended }))).toEqual([
      { title: 'before', line: '90', count: undefined, labels: undefined, ended: true },
      { title: 'Verified the same check 2 times', line: '94', count: 2, labels: ['hour 1 count', 'hour 2 count'], ended: true },
      { title: 'Verified the same check 2 times', line: '98', count: 2, labels: ['hour 1 minute', 'hour 2 minute'], ended: false },
      // A pass the run cut short stays as its own row rather than half-folding.
      { title: 'hour 3 count', line: '94', count: undefined, labels: undefined, ended: true },
      { title: 'after', line: '112', count: undefined, labels: undefined, ended: true },
    ])
  })

  it('folds no loop from a single pass, a body that repeats a line, or a body with a tally in it', () => {
    expect(compactPlaybackSteps([check('a', 1), check('b', 2)]).map((r) => r.title)).toEqual(['a', 'b'])
    expect(compactPlaybackSteps([check('a', 1), check('b', 2), check('c', 1), check('d', 3)]).map((r) => r.title)).toEqual(['a', 'b', 'c', 'd'])
    const bare = check('Expect "toBe"', 2)
    expect(compactPlaybackSteps([check('a', 1), bare, check('b', 1), bare]).map((r) => r.title)).toEqual(['a', 'Verified 1 assertion', 'b', 'Verified 1 assertion'])
  })

  it('spans a tally from its first assertion to its last in the same file', () => {
    const bare = (line: number, file = spec): CompactStep => ({ title: 'Expect "toBe"', category: 'expect', ended: true, location: `${file}:${line}` })
    expect(compactPlaybackSteps([bare(50), bare(99, '/repo/e2e/support/helper.ts'), bare(65)])).toEqual([
      { title: 'Verified 3 assertions', category: 'expect', ended: true, location: `${spec}:50`, toLine: 65 },
    ])
    expect(compactPlaybackSteps([bare(50)])[0]).toEqual({ title: 'Verified 1 assertion', category: 'expect', ended: true, location: `${spec}:50` })
    expect(compactPlaybackSteps([{ title: 'Expect "toBe"', category: 'expect', ended: true }])[0].location).toBeUndefined()
    expect(compactPlaybackSteps([{ title: 'Expect "toBe"', category: 'expect', ended: true, location: spec }])[0]).toEqual({ title: 'Verified 1 assertion', category: 'expect', ended: true, location: spec })
  })
})
