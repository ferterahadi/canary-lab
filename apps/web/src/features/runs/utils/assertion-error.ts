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

/** Playwright's matcher line — `expect(received).toBe(expected) // Object.is
 *  equality` — names how the values were compared, not what failed. The card
 *  carries it as a caption in its title strip (`toBe · Object.is equality`). */
const MATCHER_LINE = /^(?:Error:\s*)?expect\(.*?\)(?:\.not)?\.(\w+)\(.*?\)\s*(?:\/\/\s*(.+))?$/

export function matcherCaption(line: string): string | null {
  const match = MATCHER_LINE.exec(line.trim())
  return match ? [match[1], match[2]?.trim()].filter(Boolean).join(' · ') : null
}

/** The parts the error card lays out: the failure in words, the matcher as a
 *  caption, and whatever else Playwright printed. A headline that IS the
 *  matcher line leaves no sentence of its own, so `message` is empty. The
 *  `Error: ` prefix goes, because the card's title already says Error. */
export function errorLayout(parts: AssertionParts): { message: string; caption: string | null; rest: string } {
  const restLines = parts.rest ? parts.rest.split('\n') : []
  const headlineCaption = matcherCaption(parts.headline)
  const restIndex = headlineCaption ? -1 : restLines.findIndex((line) => line.trim() !== '')
  const restCaption = restIndex >= 0 ? matcherCaption(restLines[restIndex]) : null
  return {
    message: headlineCaption ? '' : parts.headline.replace(/^Error:\s*/, ''),
    caption: headlineCaption ?? restCaption,
    rest: (restCaption ? restLines.filter((_, i) => i !== restIndex) : restLines).join('\n').trim(),
  }
}

/** One line of Playwright's code frame. */
export interface CodeFrameLine {
  line: number
  text: string
  failing: boolean
}

// `>  98 |   ).toBe('0')` — the `>` marks the failing line. The frame's caret
// row (`     |     ^`) only points at that line, so the tint replaces it.
const FRAME_LINE = /^(>?)\s*(\d+) \|(.*)$/
const CARET_LINE = /^\s*\|\s*\^+\s*$/

/** The frame as numbered lines, or null when any line is not in Playwright's
 *  shape — the card then shows the snippet verbatim. */
export function parseCodeFrame(snippet: string): CodeFrameLine[] | null {
  const out: CodeFrameLine[] = []
  for (const raw of snippet.split(/\r?\n/)) {
    if (raw.trim() === '' || CARET_LINE.test(raw)) continue
    const match = FRAME_LINE.exec(raw.trimStart())
    if (!match) return null
    out.push({ line: Number(match[2]), text: match[3].replace(/^ /, ''), failing: match[1] === '>' })
  }
  return out.length > 0 ? out : null
}
