import { unifiedDiffLines } from './lib/unified-diff'

export type PatchRow = { kind: 'section'; text: string } | { kind: 'values'; before: string | null; after: string | null }

/** Pair adjacent deletion/addition blocks without crossing context or file
 * boundaries. Hunk counts distinguish source starting with ---/+++ from headers. */
export function comparisonPatchRows(diff: string): PatchRow[] {
  const rows: PatchRow[] = []
  let removed: string[] = []
  let added: string[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ kind: 'values', before: removed[i] ?? null, after: added[i] ?? null })
    }
    removed = []
    added = []
  }
  for (const { kind, text } of unifiedDiffLines(diff)) {
    if (kind === 'deletion') {
      if (added.length) flush()
      removed.push(text.slice(1))
    } else if (kind === 'addition') {
      added.push(text.slice(1))
    } else {
      flush()
      if (kind === 'context') rows.push({ kind: 'values', before: text.slice(1), after: text.slice(1) })
      else rows.push({ kind: 'section', text })
    }
  }
  flush()
  return rows
}
