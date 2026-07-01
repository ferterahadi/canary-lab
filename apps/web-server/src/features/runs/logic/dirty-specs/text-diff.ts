import fs from 'fs'
import os from 'os'
import path from 'path'
import { runGit } from '../../../../shared/git-repo'

// Line-level diff between two arbitrary text snippets, via git's own diff
// engine rather than a hand-rolled one — `--no-index` compares two filesystem
// paths directly, ignoring any repo/index, so this works for isolated
// snippets (e.g. one test's body) with no relation to a real git repo.

// Parses `@@ -a,b +c,d @@` unified-diff hunk headers and returns every line
// number added/changed on the "+" (new-file) side. A hunk with no "+" length
// (`+c,0`, a pure deletion) contributes nothing — matches the intent that a
// removed line doesn't mark anything on the new-file side.
function parseAddedLines(diffOutput: string): Set<number> {
  const changed = new Set<number>()
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm
  let m: RegExpExecArray | null
  while ((m = hunkRe.exec(diffOutput)) !== null) {
    const start = Number(m[1])
    const len = m[2] !== undefined ? Number(m[2]) : 1
    for (let i = 0; i < len; i++) changed.add(start + i)
  }
  return changed
}

export async function diffChangedLines(oldText: string, newText: string): Promise<Set<number>> {
  if (oldText === newText) return new Set()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-text-diff-'))
  try {
    const oldPath = path.join(dir, 'old')
    const newPath = path.join(dir, 'new')
    // A missing trailing newline makes git treat the last line as "changed"
    // purely because of the EOF marker, even when its content is identical —
    // normalize so that artifact never shows up as a phantom changed line.
    const withTrailingNewline = (s: string) => (s.endsWith('\n') ? s : `${s}\n`)
    fs.writeFileSync(oldPath, withTrailingNewline(oldText))
    fs.writeFileSync(newPath, withTrailingNewline(newText))
    // Exit code is 1 when the files differ (not an error) and 0 when they
    // don't — only treat other codes (bad invocation) as "nothing to report".
    const res = await runGit(dir, ['diff', '--no-index', '--unified=0', oldPath, newPath])
    if (res.code > 1) return new Set()
    return parseAddedLines(res.stdout)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
