// How a repair's changed files are read on a card: which edits deserve to stay
// in view, and how the card counts them.

/**
 * A test file, by filename suffix only.
 *
 * The run loop's load-bearing rule is that a repair agent fixes the app, not
 * the test — so a captured repair that touched a spec is the one thing on the
 * card a reviewer must not scroll past. Matching on the suffix (rather than an
 * `e2e/` or `tests/` path segment) keeps a fixture directory inside the product
 * from being flagged as a rule breach.
 */
export function isTestPath(file: string): boolean {
  return /\.(spec|test)\.[cm]?[jt]sx?$/.test(file)
}

/** `1 file` / `12 files` — the count voice of the repo card's header. */
export function fileCountLabel(n: number): string {
  return n === 1 ? '1 file' : `${n} files`
}
