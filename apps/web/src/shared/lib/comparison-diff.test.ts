import { describe, expect, it } from 'vitest'
import { compareText, comparisonPatchRows } from './comparison-diff'

describe('compareText', () => {
  it.each([
    ['', ''], ['same', 'same'], ['', 'new'], ['old', ''],
    ['adds item', 'adds an item'], ['expect(status).toBe(401)', 'expect(status).not.toBe(500)'],
    ['  café\n你好 🚀\t', '\tcafé\n世界 🚀  '], ['a b c d', 'x b y d'],
    ['a b', 'b a'], ['<script>alert(1)</script>', '<b>safe</b>'],
  ])('preserves exact text for %j → %j', (before, after) => {
    const parts = compareText(before, after)
    expect(parts.before.map((part) => part.text).join('')).toBe(before)
    expect(parts.after.map((part) => part.text).join('')).toBe(after)
    expect(parts.before.filter((part) => !part.changed).map((part) => part.text).join(''))
      .toBe(parts.after.filter((part) => !part.changed).map((part) => part.text).join(''))
  })

  it('keeps the long unchanged test name neutral after removing tags', () => {
    const tail = ' a new app can read its own empty conversation scope'
    const parts = compareText(`@req-R1 @path-happy @variant-whatsapp${tail}`, `whatsapp:${tail}`)
    expect(parts.before.at(-1)).toEqual({ text: tail, changed: false })
    expect(parts.after.at(-1)).toEqual({ text: tail, changed: false })
  })

  it('highlights disjoint edits without coloring the text between them', () => {
    const parts = compareText('old stable first', 'new stable last')
    expect(parts.before).toEqual([{ text: 'old', changed: true }, { text: ' stable ', changed: false }, { text: 'first', changed: true }])
    expect(parts.after).toEqual([{ text: 'new', changed: true }, { text: ' stable ', changed: false }, { text: 'last', changed: true }])
  })

  it('bounds large comparisons without truncating their content', () => {
    const before = `prefix ${'old '.repeat(1000)}suffix`
    const after = `prefix ${'new '.repeat(1000)}suffix`
    const parts = compareText(before, after)
    expect(parts.before.map((part) => part.text).join('')).toBe(before)
    expect(parts.after.map((part) => part.text).join('')).toBe(after)
    expect(parts.before).toHaveLength(3)
    expect(parts.before[0]).toEqual({ text: 'prefix ', changed: false })
    expect(parts.before[2]).toEqual({ text: ' suffix', changed: false })
  })
})

describe('comparisonPatchRows', () => {
  it('pairs replacements and keeps unmatched additions, context and file boundaries', () => {
    const diff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n context\ndiff --git a/b b/b\n@@ -1 +1,0 @@\n-gone\n'
    expect(comparisonPatchRows(diff)).toEqual([
      { kind: 'section', text: 'diff --git a/a b/a' },
      { kind: 'section', text: '--- a/a' },
      { kind: 'section', text: '+++ b/a' },
      { kind: 'section', text: '@@ -1,2 +1,3 @@' },
      { kind: 'values', before: 'old', after: 'new' },
      { kind: 'values', before: null, after: 'extra' },
      { kind: 'values', before: 'context', after: 'context' },
      { kind: 'section', text: 'diff --git a/b b/b' },
      { kind: 'section', text: '@@ -1 +1,0 @@' },
      { kind: 'values', before: 'gone', after: null },
    ])
  })

  it('does not mistake source resembling file headers for metadata inside a hunk', () => {
    expect(comparisonPatchRows('@@ -1 +1 @@\n--- old\n+++ new')).toEqual([
      { kind: 'section', text: '@@ -1 +1 @@' },
      { kind: 'values', before: '-- old', after: '++ new' },
    ])
  })

  it('retains empty lines, metadata, binary patches and no-newline markers', () => {
    const rows = comparisonPatchRows('# Service: api\n-old\n+\n\\ No newline at end of file\nBinary files differ\n\n')
    expect(rows).toContainEqual({ kind: 'values', before: 'old', after: '' })
    expect(rows).toContainEqual({ kind: 'section', text: '\\ No newline at end of file' })
    expect(rows).toContainEqual({ kind: 'section', text: 'Binary files differ' })
    expect(rows.at(-1)).toEqual({ kind: 'section', text: '' })
  })

  it('keeps partial patch blocks and sequential additions and removals', () => {
    expect(comparisonPatchRows('+added\n-removed\n context')).toEqual([
      { kind: 'values', before: null, after: 'added' },
      { kind: 'values', before: 'removed', after: null },
      { kind: 'section', text: ' context' },
    ])
    expect(comparisonPatchRows('')).toEqual([])
  })
})
