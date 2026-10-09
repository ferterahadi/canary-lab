// One repair cycle's edits, per file, read from its recorded diff alone. The
// diff holds only the hunks, so every row carries the line numbers its hunk
// header gives and the lines it leaves out are counted as gaps, never guessed.
// Recovering the full files is the server's job; nothing here reads a repo.
import { hunkRange, unifiedDiffLines, type PatchHunk } from '../lib/unified-diff'
import type { ReviewSource } from '../test-review'
import type { ContextRow } from '../test-source-diff'
import type { AlignedReview, TestViewSideLabels } from './render-model'

export type CycleFileChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary'

/** The grammars the code view can colour a file with. */
export type CycleFileLanguage = 'typescript' | 'tsx' | 'json' | 'markdown' | 'yaml'

/** Which tree the file lives in, decided from the run's own records, never
 * from the diff text. App code is shown as code only: English is for tests. */
export type CycleFileRole = 'spec' | 'support' | 'app'

/** How the file's full before and after were obtained. */
export type CycleFileRecovery =
  /** Replayed from the run's suite copy through the recorded cycles. */
  | { kind: 'reconstructed'; verified: 'blob' | 'context' }
  /** Read from a git blob the diff names, then the cycle applied to it. */
  | { kind: 'exact'; from: 'before-blob' | 'after-blob'; repo: string }
  | { kind: 'patch-only'; reason: CyclePatchOnlyReason }

export type CyclePatchOnlyReason = 'truncated' | 'no-tree' | 'repo-missing' | 'blob-missing' | 'chain-broken' | 'apply-failed' | 'binary' | 'mismatch'

/** Whether the run executed a suite file's edit. */
export type CycleFileExecution =
  /** The run had no suite copy, so later reruns ran the live suite and the edit with it. */
  | { kind: 'live' }
  /** The edit was copied into the run's suite and rerun. */
  | { kind: 'adopted'; by: 'human' | 'test-heal'; at: string }
  /** Playwright ran the run's suite copy; this edit stayed in the live suite. */
  | { kind: 'inert' }

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
  /** The journal cut this file's diff at its size cap. */
  truncated?: boolean
  language: CycleFileLanguage
  role: CycleFileRole
  recovery: CycleFileRecovery
  /** Both full versions, and their full-context diff, unless the file is
   * shown from the diff alone. */
  sources?: { before: ReviewSource; after: ReviewSource; patch: string }
  /** Suite files only. */
  executed?: CycleFileExecution
}

/** A parsed file with the hunks a recovery replays. Never sent to the page. */
export interface ParsedCycleFile extends CycleReviewFile { hunks: PatchHunk[] }

/** One repair cycle's files, as the route serves them. */
export interface RunCycleReview {
  iteration: number
  /** The persisted patch file, or the journal entry's inline diff for runs
   * recorded before every cycle was persisted. */
  source: 'patch' | 'journal'
  /** Null when the diff came from the journal. */
  patchPath: string | null
  /** The journal cut the inline diff at its size cap. */
  truncated: boolean
  /** What the run's repairs were told to edit: app code, or with no app repos
   * the tests themselves. */
  healMode: 'service' | 'test'
  files: CycleReviewFile[]
}

/** The grammar for a path; JavaScript reads with the TypeScript grammar. */
export function cycleFileLanguage(path: string): CycleFileLanguage {
  if (/\.[jt]sx$/.test(path)) return 'tsx'
  if (/\.json$/.test(path)) return 'json'
  if (/\.(md|markdown)$/.test(path)) return 'markdown'
  if (/\.ya?ml$/.test(path)) return 'yaml'
  return 'typescript'
}

const TRUNCATED = /^\.\.\. \(truncated, \d+ more bytes\)$/

interface FileDraft {
  file: ParsedCycleFile
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

/** Files, aligned rows and hunks of one cycle's diff, in diff order.
 * Deletions and additions pair index-wise within a block, as the patch view
 * always paired them; context and hunk boundaries are never crossed. A
 * journal's truncation marker ends the diff: the file it cut is flagged and
 * nothing after it exists. */
export function parseCyclePatch(diff: string): ParsedCycleFile[] {
  const files: ParsedCycleFile[] = []
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
    draft.file.language = cycleFileLanguage(draft.file.path)
    files.push(draft.file)
    draft = undefined
  }
  const open = (path: string, change: CycleFileChange = 'modified'): void => {
    close()
    draft = {
      file: { path, ...(repo ? { repo } : {}), change, lineEnding: 'lf', rows: [], hunks: [],
        language: 'typescript', role: 'app', recovery: { kind: 'patch-only', reason: 'no-tree' } },
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
      if (!draft || draft.file.hunks.length) headerless = { before: patchPath(text.slice(4)) }
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
      if (TRUNCATED.test(text)) {
        file.truncated = true
        break
      }
      if (text.startsWith('\\')) {
        // The marker speaks of the line before it; with no hunk there is none.
        const hunk = file.hunks.at(-1)
        if (hunk) {
          const ends = file.noNewlineAtEnd ?? { before: false, after: false }
          for (const target of [ends, hunk.noNewlineAtEnd]) {
            if (draft.last !== 'addition') target.before = true
            if (draft.last !== 'deletion') target.after = true
          }
          file.noNewlineAtEnd = ends
        }
      } else if (file.hunks.length === 0) {
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
      file.hunks.push({ ...range, lines: [], noNewlineAtEnd: { before: false, after: false } })
      continue
    }
    // A line outside any hunk has no line number to stand at.
    const hunk = file.hunks.at(-1)
    if (!hunk) continue
    draft.last = kind
    const line = content(text)
    hunk.lines.push({ kind, text: line })
    if (kind === 'deletion') {
      if (draft.added.length) flush()
      draft.removed.push({ text: line, line: draft.line.before++ })
    } else if (kind === 'addition') {
      draft.added.push({ text: line, line: draft.line.after++ })
    } else {
      flush()
      push({ before: line, after: line, beforeLine: draft.line.before++, afterLine: draft.line.after++ })
    }
  }
  // The heal journal trims the diff it records, which drops the last hunk's
  // trailing blank context lines: a blank line is the only text a trim can
  // remove from a hunk. They are put back so the hunk applies; a blob check
  // still refuses a file whose stripped line held only spaces.
  const last = draft && !draft.file.truncated ? draft.file.hunks.at(-1) : undefined
  if (last) {
    const short = (side: 'addition' | 'deletion', count: number) => count - last.lines.filter((line) => line.kind !== side).length
    const missing = short('addition', last.oldCount)
    if (missing > 0 && missing === short('deletion', last.newCount)) {
      flush()
      for (let i = 0; i < missing; i++) {
        last.lines.push({ kind: 'context', text: '' })
        push({ before: '', after: '', beforeLine: draft!.line.before++, afterLine: draft!.line.after++ })
      }
    }
  }
  close()
  return files
}

/** The files of one cycle's diff as the page reads them: without the hunks. */
export function cycleReviewFromPatch(diff: string): CycleReviewFile[] {
  return parseCyclePatch(diff).map(({ hunks: _hunks, ...file }) => file)
}

export interface CycleAlignedInput { review: AlignedReview; rows: ContextRow[]; labels: TestViewSideLabels }

/** What the aligned view needs for one cycle file. Each side's source holds
 * the patch's lines at their real line numbers and blank lines elsewhere, so
 * the view highlights it once and indexes tokens by line as it does for a
 * whole file. It is code only: a patch holds no complete statement to read. */
export function cycleFileAlignedInput(file: CycleReviewFile, cycle: number): CycleAlignedInput {
  const padded = (side: 'before' | 'after'): string => {
    const lines: string[] = []
    for (const row of file.rows) {
      const line = side === 'before' ? row.beforeLine : row.afterLine
      if (line != null) lines[line - 1] = row[side]!
    }
    return Array.from(lines, (text) => text ?? '').join('\n')
  }
  return {
    review: { before: { source: padded('before'), tests: [] }, after: { source: padded('after'), tests: [] }, supportingFile: true },
    rows: file.rows,
    labels: { before: `Before repair cycle ${cycle}`, after: `After repair cycle ${cycle}` },
  }
}
