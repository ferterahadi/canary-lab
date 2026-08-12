import { describe, expect, it } from 'vitest'

import type { PlaywrightPlaybackEvent } from '@/shared/api/types'
import { playbackTests } from './run-detail-playback'

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
