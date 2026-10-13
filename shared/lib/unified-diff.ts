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

export interface PatchHunkLine { kind: 'context' | 'deletion' | 'addition'; text: string }

/** One hunk as a patch recorded it. `lines` hold the text without its `+`, `-`
 * or space prefix and without a trailing `\r`. */
export interface PatchHunk extends HunkRange {
  lines: PatchHunkLine[]
  noNewlineAtEnd: { before: boolean; after: boolean }
}

export type ApplyHunksResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'context-mismatch' | 'out-of-range' | 'truncated'; line?: number }

const reverseHunk = (hunk: PatchHunk): PatchHunk => ({
  oldStart: hunk.newStart, oldCount: hunk.newCount, newStart: hunk.oldStart, newCount: hunk.oldCount,
  lines: hunk.lines.map((line) => line.kind === 'context' ? line : { kind: line.kind === 'addition' ? 'deletion' : 'addition', text: line.text }),
  noNewlineAtEnd: { before: hunk.noNewlineAtEnd.after, after: hunk.noNewlineAtEnd.before },
})

/** Apply a file's hunks to its text, or undo them with `reverse`. Every
 * context and removed line must match exactly where its hunk says: there is
 * no fuzz and no search for a moved hunk, because a near miss would be a
 * guessed file. The file keeps its line ending when every line shares one; a
 * file mixing endings comes back with `\n`, which a caller's content hash then
 * refuses. */
export function applyHunks(text: string, hunks: readonly PatchHunk[], direction: 'forward' | 'reverse'): ApplyHunksResult {
  const endedWithNewline = text === '' || text.endsWith('\n')
  const raw = text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
  const crlf = raw.length > 0 && raw.every((line) => line.endsWith('\r'))
  const lines = raw.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
  const out: string[] = []
  let cursor = 0
  let newline = endedWithNewline
  for (const recorded of hunks) {
    const hunk = direction === 'forward' ? recorded : reverseHunk(recorded)
    const oldLines = hunk.lines.filter((line) => line.kind !== 'addition').length
    const newLines = hunk.lines.filter((line) => line.kind !== 'deletion').length
    if (oldLines !== hunk.oldCount || newLines !== hunk.newCount) return { ok: false, reason: 'truncated' }
    // A zero-count old side inserts after its start line instead of at it.
    const start = hunk.oldCount ? hunk.oldStart - 1 : hunk.oldStart
    if (start < cursor || start > lines.length) return { ok: false, reason: 'out-of-range', line: hunk.oldStart }
    out.push(...lines.slice(cursor, start))
    cursor = start
    for (const line of hunk.lines) {
      if (line.kind === 'addition') { out.push(line.text); continue }
      if (lines[cursor] !== line.text) return { ok: false, reason: 'context-mismatch', line: cursor + 1 }
      if (line.kind === 'context') out.push(line.text)
      cursor++
    }
    if (cursor === lines.length) newline = !hunk.noNewlineAtEnd.after
  }
  out.push(...lines.slice(cursor))
  if (!out.length) return { ok: true, text: '' }
  const ending = crlf ? '\r\n' : '\n'
  return { ok: true, text: out.join(ending) + (newline ? ending : '') }
}
