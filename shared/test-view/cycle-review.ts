// One repair cycle's edits, per file, read from `diffs/iteration-<n>.patch`
// alone. The patch holds only the hunks, so every row carries the line numbers
// its hunk header gives and the lines it leaves out are counted as gaps, never
// guessed. Full sources are a later recovery step; nothing here reads a repo.
import { hunkRange, unifiedDiffLines } from '../lib/unified-diff'
import type { ContextRow } from '../test-source-diff'

export type CycleFileChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary'

/** One file touched by one journaled repair cycle. */
export interface CycleReviewFile {
  /** Path as the patch names it; a deletion's two sides name the same path. */
  path: string
  /** The path a rename moved the file from. */
  previousPath?: string
  /** The `# repo:` or `# feature config:` snapshot key above this file's diff. */
  repo?: string
  change: CycleFileChange
  /** The `index <before>..<after>` blob ids. All zeroes means that side did
   * not exist. */
  blobs?: { before: string; after: string }
  /** Row text has its trailing `\r` removed; this records that it was there. */
  lineEnding: 'lf' | 'crlf' | 'mixed'
  noNewlineAtEnd?: { before: boolean; after: boolean }
  /** Empty for a binary file or a rename with no edits. */
  rows: ContextRow[]
}

export interface RunCycleReview {
  iteration: number
  patchPath: string
  files: CycleReviewFile[]
}

interface FileDraft {
  file: CycleReviewFile
  hunks: number
  /** The last line each side's previous hunk covered. */
  end: { before: number; after: number }
  line: { before: number; after: number }
  gap?: { before: number; after: number }
  removed: Array<{ text: string; line: number }>
  added: Array<{ text: string; line: number }>
  edits: number
  wasChanged: boolean
  endings: { crlf: number; lf: number }
  last?: 'deletion' | 'addition' | 'context'
}

const patchPath = (text: string): string | null => {
  const path = text.replace(/\t.*$/, '')
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '')
}

/** Files and aligned rows of one cycle's patch, in patch order. Deletions and
 * additions pair index-wise within a block, as the patch view always paired
 * them; context and hunk boundaries are never crossed. */
export function cycleReviewFromPatch(diff: string): CycleReviewFile[] {
  const files: CycleReviewFile[] = []
  let repo: string | undefined
  let draft: FileDraft | undefined
  // A fragment without `diff --git` names its file in the `---` line first.
  let headerless: { before: string | null } | undefined

  const content = (text: string): string => {
    const body = text.slice(1)
    if (body.endsWith('\r')) { draft!.endings.crlf++; return body.slice(0, -1) }
    draft!.endings.lf++
    return body
  }
  const push = (row: Omit<ContextRow, 'id'>): void => {
    const d = draft!
    const changed = row.before !== row.after
    if (changed && !d.wasChanged) d.edits++
    d.wasChanged = changed
    d.file.rows.push({
      id: `cycle-${files.length}-${d.file.rows.length}`,
      ...row,
      ...(changed ? { change: d.edits } : {}),
      ...(d.gap ? { gap: d.gap } : {}),
    })
    d.gap = undefined
  }
  const flush = (): void => {
    const d = draft!
    for (let i = 0; i < Math.max(d.removed.length, d.added.length); i++) {
      const before = d.removed[i]
      const after = d.added[i]
      push({
        before: before?.text ?? null,
        after: after?.text ?? null,
        ...(before ? { beforeLine: before.line } : {}),
        ...(after ? { afterLine: after.line } : {}),
      })
    }
    d.removed = []
    d.added = []
  }
  const close = (): void => {
    if (!draft) return
    flush()
    const { crlf, lf } = draft.endings
    draft.file.lineEnding = crlf && lf ? 'mixed' : crlf ? 'crlf' : 'lf'
    files.push(draft.file)
    draft = undefined
  }
  const open = (path: string, change: CycleFileChange = 'modified'): void => {
    close()
    draft = {
      file: { path, ...(repo ? { repo } : {}), change, lineEnding: 'lf', rows: [] },
      hunks: 0,
      end: { before: 0, after: 0 },
      line: { before: 0, after: 0 },
      removed: [],
      added: [],
      edits: 0,
      wasChanged: false,
      endings: { crlf: 0, lf: 0 },
    }
  }

  for (const { kind, text } of unifiedDiffLines(diff)) {
    if (kind === 'file') {
      // Git quotes a path holding unusual characters; that header is kept whole.
      open(/^diff --git a\/.* b\/(.*)$/.exec(text)?.[1] ?? text.slice('diff --git '.length))
      headerless = undefined
      continue
    }
    if (kind === 'metadata' && /^# (repo|feature config): /.test(text)) {
      close()
      repo = text.slice(text.indexOf(': ') + 2)
      continue
    }
    if (kind === 'old-file') {
      if (!draft || draft.hunks) headerless = { before: patchPath(text.slice(4)) }
      continue
    }
    if (kind === 'new-file') {
      if (headerless) {
        const after = patchPath(text.slice(4))
        const before = headerless.before
        headerless = undefined
        open((after ?? before)!, before === null ? 'added' : after === null ? 'deleted' : 'modified')
      }
      continue
    }
    if (!draft) continue
    const { file } = draft
    if (kind === 'metadata') {
      if (text.startsWith('\\')) {
        const ends = file.noNewlineAtEnd ?? { before: false, after: false }
        if (draft.last !== 'addition') ends.before = true
        if (draft.last !== 'deletion') ends.after = true
        file.noNewlineAtEnd = ends
      } else if (draft.hunks === 0) {
        const index = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(text)
        if (text.startsWith('new file mode')) file.change = 'added'
        else if (text.startsWith('deleted file mode')) file.change = 'deleted'
        else if (text.startsWith('rename from ')) { file.change = 'renamed'; file.previousPath = text.slice('rename from '.length) }
        else if (text.startsWith('rename to ')) file.path = text.slice('rename to '.length)
        else if (text.startsWith('Binary files ') || text === 'GIT binary patch') file.change = 'binary'
        else if (index) file.blobs = { before: index[1], after: index[2] }
      }
      continue
    }
    if (file.change === 'binary') continue
    if (kind === 'hunk') {
      flush()
      const range = hunkRange(text)!
      // A zero-count side sits after its start line instead of on it.
      const hidden = {
        before: (range.oldCount ? range.oldStart - 1 : range.oldStart) - draft.end.before,
        after: (range.newCount ? range.newStart - 1 : range.newStart) - draft.end.after,
      }
      if (hidden.before > 0 || hidden.after > 0) draft.gap = { before: Math.max(0, hidden.before), after: Math.max(0, hidden.after) }
      draft.line = { before: range.oldCount ? range.oldStart : range.oldStart + 1, after: range.newCount ? range.newStart : range.newStart + 1 }
      draft.end = { before: draft.line.before + range.oldCount - 1, after: draft.line.after + range.newCount - 1 }
      draft.hunks++
      continue
    }
    draft.last = kind
    if (kind === 'deletion') {
      if (draft.added.length) flush()
      draft.removed.push({ text: content(text), line: draft.line.before++ })
    } else if (kind === 'addition') {
      draft.added.push({ text: content(text), line: draft.line.after++ })
    } else {
      flush()
      const line = content(text)
      push({ before: line, after: line, beforeLine: draft.line.before++, afterLine: draft.line.after++ })
    }
  }
  close()
  return files
}
