export interface UnifiedDiffLine {
  kind: 'file' | 'old-file' | 'new-file' | 'hunk' | 'addition' | 'deletion' | 'context' | 'metadata'
  text: string
}

export interface HunkRange { oldStart: number; oldCount: number; newStart: number; newCount: number }

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** A hunk header's ranges; an omitted count means one line. */
export function hunkRange(text: string): HunkRange | null {
  const hunk = HUNK.exec(text)
  return hunk && { oldStart: Number(hunk[1]), oldCount: Number(hunk[2] ?? 1), newStart: Number(hunk[3]), newCount: Number(hunk[4] ?? 1) }
}

/** Hunk counts distinguish changed source beginning with ---/+++ from headers.
 * Headerless fragments remain useful, even when a captured patch is incomplete. */
export function unifiedDiffLines(diff: string): UnifiedDiffLine[] {
  let oldRemaining = 0
  let newRemaining = 0
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((text): UnifiedDiffLine => {
    const hunk = hunkRange(text)
    if (text.startsWith('diff --git ') || /^# (repo|feature config): /.test(text)) {
      oldRemaining = newRemaining = 0
      return { kind: text.startsWith('diff --git ') ? 'file' : 'metadata', text }
    }
    if (hunk) {
      oldRemaining = hunk.oldCount
      newRemaining = hunk.newCount
      return { kind: 'hunk', text }
    }
    if (text.startsWith('-') && (oldRemaining > 0 || !text.startsWith('--- '))) {
      oldRemaining = Math.max(0, oldRemaining - 1)
      return { kind: 'deletion', text }
    }
    if (text.startsWith('+') && (newRemaining > 0 || !text.startsWith('+++ '))) {
      newRemaining = Math.max(0, newRemaining - 1)
      return { kind: 'addition', text }
    }
    if (text.startsWith(' ') && (oldRemaining > 0 || newRemaining > 0)) {
      oldRemaining = Math.max(0, oldRemaining - 1)
      newRemaining = Math.max(0, newRemaining - 1)
      return { kind: 'context', text }
    }
    if (text.startsWith('--- ')) return { kind: 'old-file', text }
    if (text.startsWith('+++ ')) return { kind: 'new-file', text }
    return { kind: 'metadata', text }
  })
}
