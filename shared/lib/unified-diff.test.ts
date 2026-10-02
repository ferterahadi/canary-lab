import { describe, expect, it } from 'vitest'
import { unifiedDiffLines } from './unified-diff'
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
