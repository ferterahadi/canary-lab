/**
 * A Playwright `expect` failure, split into the parts the playback card lays out.
 *
 * Playwright prints a matcher failure as a headline, then one `Expected:` and
 * one `Received:` line (`Expected pattern:`, `Received string:` and the other
 * qualified forms included), then whatever context follows — a call log, a
 * timeout note. The card shows the pair as a two-row table so the mismatch is
 * the first thing read, not the fourth line of a red block.
 *
 * Anything else — a thrown error, a multi-line `toEqual` diff, a message with
 * only one side — returns `null`, and the card keeps the verbatim message. This
 * is layout over the message Playwright wrote, never a rewrite of it: every
 * line the split does not place lands in `rest`, in order.
 */
export interface AssertionParts {
  headline: string
  expected: { label: string; value: string }
  received: { label: string; value: string }
  rest: string
}

const SIDE_LINE = /^\s*((Expected|Received)(?: [a-z]+)?):\s*(.*)$/

export function parseAssertionError(message: string): AssertionParts | null {
  const lines = message.split(/\r?\n/)
  let expected: AssertionParts['expected'] | null = null
  let received: AssertionParts['received'] | null = null
  const others: string[] = []
  for (const line of lines) {
    const match = SIDE_LINE.exec(line)
    if (match?.[2] === 'Expected' && !expected) {
      expected = { label: match[1], value: match[3] }
    } else if (match?.[2] === 'Received' && !received) {
      received = { label: match[1], value: match[3] }
    } else {
      others.push(line)
    }
  }
  const first = others.findIndex((line) => line.trim() !== '')
  if (!expected || !received || first < 0) return null
  return {
    headline: others[first].trim(),
    expected,
    received,
    rest: others.slice(first + 1).join('\n').trim(),
  }
}
