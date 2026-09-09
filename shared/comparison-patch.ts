export type PatchRow = { kind: 'section'; text: string } | { kind: 'values'; before: string | null; after: string | null }

/** Pair adjacent deletion/addition blocks without crossing context or file
 * boundaries. Hunk counts distinguish source starting with ---/+++ from headers. */
export function comparisonPatchRows(diff: string): PatchRow[] {
  const rows: PatchRow[] = []
  let removed: string[] = []
  let added: string[] = []
  let oldRemaining = 0
  let newRemaining = 0
  const flush = (): void => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ kind: 'values', before: removed[i] ?? null, after: added[i] ?? null })
    }
    removed = []
    added = []
  }
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      flush()
      oldRemaining = Number(hunk[2] ?? 1)
      newRemaining = Number(hunk[4] ?? 1)
      rows.push({ kind: 'section', text: line })
    } else if (line.startsWith('-') && (oldRemaining > 0 || !line.startsWith('--- '))) {
      if (added.length) flush()
      removed.push(line.slice(1))
      oldRemaining = Math.max(0, oldRemaining - 1)
    } else if (line.startsWith('+') && (newRemaining > 0 || !line.startsWith('+++ '))) {
      added.push(line.slice(1))
      newRemaining = Math.max(0, newRemaining - 1)
    } else {
      flush()
      if (line.startsWith(' ') && (oldRemaining > 0 || newRemaining > 0)) {
        rows.push({ kind: 'values', before: line.slice(1), after: line.slice(1) })
        oldRemaining = Math.max(0, oldRemaining - 1)
        newRemaining = Math.max(0, newRemaining - 1)
      } else rows.push({ kind: 'section', text: line })
    }
  }
  flush()
  return rows
}
