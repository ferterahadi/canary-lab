// How a repair's changed-file list is read on a card: which edits deserve to be
// above the fold, and how to say "40 files" without printing 40 lines.

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

/** One directory's share of a repair, for the rollup that replaces a long list. */
export interface RepairDirGroup {
  dir: string
  count: number
}

/** Label for a file that sits directly in the repo root — `''` would render as
 *  an empty row, and `.` reads like a hidden directory. */
export const REPO_ROOT_DIR_LABEL = 'repo root'

/**
 * Changed files rolled up per directory, heaviest first (ties alphabetical).
 *
 * Past a handful of files the individual paths stop being a legend you can scan
 * against your editor; which *areas* the agent touched is the question that
 * survives at that size.
 */
export function groupByDirectory(files: string[]): RepairDirGroup[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const cut = file.lastIndexOf('/')
    const dir = cut <= 0 ? REPO_ROOT_DIR_LABEL : file.slice(0, cut)
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  return [...counts]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
}

/** `1 file` / `12 files` — the count voice shared by the card header, the
 *  rollup's overflow row, and the patch dialog. */
export function fileCountLabel(n: number): string {
  return n === 1 ? '1 file' : `${n} files`
}
