/** `plural(3, 'repo')` → `"3 repos"`. One home for count-noun copy on both
 *  sides, so server messages never ship the `${n} file(s)` form the UI's own
 *  strings avoid. Regular plurals only — a caller with an irregular noun writes
 *  the sentence itself. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${pluralSuffix(n)}`
}

/** The `s` a regular noun takes for count `n` — for copy where the count is not
 *  printed beside the noun (`<strong>3</strong> runs`, "the paths"). */
export function pluralSuffix(n: number): string {
  return n === 1 ? '' : 's'
}
