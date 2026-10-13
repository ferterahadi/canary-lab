import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { trackTempDirs } from '../../tools/test-helpers/temp-dir'
import { parseCyclePatch } from '../test-view/cycle-review'
import { applyHunks, hunkRange, unifiedDiffLines, type PatchHunk } from './unified-diff'
import { comparisonPatchRows } from '../comparison-patch'

// These are changed source lines whose text begins with -- and ++, not headers.
const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n--- old\n+++ new\n'

describe('unifiedDiffLines', () => {
  it('preserves raw text and distinguishes headers from source inside a hunk', () => {
    expect(unifiedDiffLines(patch)).toEqual([
      { kind: 'file', text: 'diff --git a/a b/a' },
      { kind: 'old-file', text: '--- a/a' },
      { kind: 'new-file', text: '+++ b/a' },
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'deletion', text: '--- old' },
      { kind: 'addition', text: '+++ new' },
    ])
    expect(comparisonPatchRows(patch).at(-1)).toEqual({ kind: 'values', before: '-- old', after: '++ new' })
  })

  it('handles explicit counts, context, empty sides, and metadata without losing blank lines', () => {
    const input = '@@ -1,2 +1,2 @@\n same\n-old\n+new\n\\ No newline at end of file\n\n@@ -3,0 +3,1 @@\n+added\n@@ -4,1 +4,0 @@\n-deleted\nBinary files differ'
    const lines = unifiedDiffLines(input)
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'context', 'deletion', 'addition', 'metadata', 'metadata', 'hunk', 'addition', 'hunk', 'deletion', 'metadata'])
    expect(lines.map((l) => l.text).join('\n')).toBe(input)
    expect(unifiedDiffLines('@@ -1,0 +1,1 @@\n context').at(-1)?.kind).toBe('context')
  })

  it('resets unfinished hunks at file and repository boundaries', () => {
    const suffix = 'diff --git a/b b/b\n--- a/b\n+++ b/b\n+second\n# repo: next\n--- a/c\n+++ b/c\n+third'
    const lines = unifiedDiffLines('@@ -1,9 +1,9 @@\n-old\n+new\n' + suffix)
    expect(lines.filter((l) => l.kind === 'new-file').map((l) => l.text)).toEqual(['+++ b/b', '+++ b/c'])
    expect(lines.filter((l) => l.kind === 'addition')).toHaveLength(3)
  })

  it('retains headerless fragments, reversed blocks, ordinary text, and empty input', () => {
    expect(unifiedDiffLines('')).toEqual([])
    expect(unifiedDiffLines('+a\n-b\n context\n+++x\n---y').map((l) => l.kind)).toEqual(['addition', 'deletion', 'metadata', 'addition', 'deletion'])
    expect(comparisonPatchRows('+a\n-b\n context')).toEqual([
      { kind: 'values', before: null, after: 'a' },
      { kind: 'values', before: 'b', after: null },
      { kind: 'section', text: ' context' },
    ])
  })
})

describe('hunkRange', () => {
  it('reads both ranges, an omitted count as one line, and ignores the context trailer', () => {
    expect(hunkRange('@@ -40,2 +40,4 @@ export function price() {')).toEqual({ oldStart: 40, oldCount: 2, newStart: 40, newCount: 4 })
    expect(hunkRange('@@ -10 +12 @@')).toEqual({ oldStart: 10, oldCount: 1, newStart: 12, newCount: 1 })
    expect(hunkRange('@@ -3,0 +4,2 @@')).toEqual({ oldStart: 3, oldCount: 0, newStart: 4, newCount: 2 })
    expect(hunkRange(' @@ -1 +1 @@')).toBeNull()
  })
})

describe('applyHunks', () => {
  const tempDir = trackTempDirs('apply-hunks-')
  /** The hunks git itself writes for `before` → `after`, read by the cycle parser. */
  const gitHunks = (before: string, after: string): PatchHunk[] => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'a'), before)
    fs.writeFileSync(path.join(dir, 'b'), after)
    let diff = ''
    try {
      execFileSync('git', ['diff', '--no-index', '--no-color', 'a', 'b'], { cwd: dir, encoding: 'utf8' })
    } catch (err) {
      // `git diff --no-index` exits 1 when the files differ; its stdout is the diff.
      diff = (err as { stdout: string }).stdout
    }
    return parseCyclePatch(diff)[0]?.hunks ?? []
  }
  const roundTrip = (before: string, after: string): void => {
    const hunks = gitHunks(before, after)
    expect(applyHunks(before, hunks, 'forward')).toEqual({ ok: true, text: after })
    expect(applyHunks(after, hunks, 'reverse')).toEqual({ ok: true, text: before })
  }

  it('reproduces git\'s own result both ways for edits, insertions at the top, deletions to empty and added files', () => {
    roundTrip('a\nb\nc\n', 'a\nB\nc\n')
    roundTrip('a\nb\n', 'top\na\nb\n')
    roundTrip('a\nb\n', '')
    roundTrip('', 'new\nfile\n')
    roundTrip('one\n', 'one\ntwo\n')
  })

  it('keeps the newline git records, or its absence, on each side', () => {
    roundTrip('a\nb', 'a\nB')
    roundTrip('a\nb', 'a\nb\n')
    roundTrip('a\nb\n', 'a\nb')
  })

  it('keeps a CRLF file\'s endings', () => {
    roundTrip('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')
  })

  it('matches git on many random edits of one longer file', () => {
    let seed = 7
    const random = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    const base = Array.from({ length: 200 }, (_, i) => `line ${i}`)
    for (let round = 0; round < 50; round++) {
      const next = [...base]
      for (let edit = 0; edit < 1 + random(6); edit++) {
        const at = random(next.length)
        const kind = random(3)
        if (kind === 0) next.splice(at, 1)
        else if (kind === 1) next.splice(at, 0, `inserted ${round}.${edit}`)
        else next[at] = `changed ${round}.${edit}`
      }
      roundTrip(`${base.join('\n')}\n`, `${next.join('\n')}\n`)
    }
  })

  it('refuses a hunk that does not fit the text instead of guessing', () => {
    const hunks = gitHunks('a\nb\nc\n', 'a\nB\nc\n')
    expect(applyHunks('a\nX\nc\n', hunks, 'forward')).toEqual({ ok: false, reason: 'context-mismatch', line: 2 })
    // A file shorter than the hunk runs out of lines to match.
    expect(applyHunks('a\n', hunks, 'forward')).toEqual({ ok: false, reason: 'context-mismatch', line: 2 })
    const late = gitHunks('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', '1\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n')
    expect(applyHunks('1\n2\n', late, 'forward')).toMatchObject({ ok: false, reason: 'out-of-range' })
    // Two hunks out of order would read the file backwards.
    const two = gitHunks(`${base(20)}`, `${base(20).replace('line 1\n', 'one\n').replace('line 18\n', 'eighteen\n')}`)
    expect(applyHunks(base(20), [two[1], two[0]], 'forward')).toMatchObject({ ok: false, reason: 'out-of-range' })
  })

  it('refuses a hunk cut short by a journal\'s size cap', () => {
    const [hunk] = gitHunks('a\nb\nc\n', 'a\nB\nc\n')
    expect(applyHunks('a\nb\nc\n', [{ ...hunk, lines: hunk.lines.slice(0, 2) }], 'forward')).toEqual({ ok: false, reason: 'truncated' })
  })

  it('leaves text alone with no hunks', () => {
    expect(applyHunks('a\nb\n', [], 'forward')).toEqual({ ok: true, text: 'a\nb\n' })
    expect(applyHunks('', [], 'reverse')).toEqual({ ok: true, text: '' })
  })
})

function base(lines: number): string {
  return `${Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n')}\n`
}
