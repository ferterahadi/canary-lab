import { describe, it, expect, vi } from 'vitest'
import { diffChangedLines } from './text-diff'
import * as gitRepo from '../../../../shared/git-repo'

describe('diffChangedLines', () => {
  it('is empty for identical text', async () => {
    const text = 'line one\nline two\nline three'
    expect(await diffChangedLines(text, text)).toEqual(new Set())
  })

  it('flags only the one line that changed', async () => {
    expect(await diffChangedLines('a\nb\nc', 'a\nB\nc')).toEqual(new Set([2]))
  })

  it('flags an appended line without touching the unchanged ones', async () => {
    expect(await diffChangedLines('a\nb', 'a\nb\nc')).toEqual(new Set([3]))
  })

  it('flags an inserted line in the middle without touching lines after it', async () => {
    expect(await diffChangedLines('a\nb', 'a\nx\nb')).toEqual(new Set([2]))
  })

  it('flags every line when there is no baseline to compare against', async () => {
    expect(await diffChangedLines('', 'a\nb')).toEqual(new Set([1, 2]))
  })

  it('flags nothing when a line is only removed', async () => {
    expect(await diffChangedLines('a\nb\nc', 'a\nc')).toEqual(new Set())
  })

  it('handles text that already ends with a trailing newline without a phantom EOF change', async () => {
    // Both sides already end in `\n` — the normalization must be a no-op here
    // (not append a second `\n`), otherwise the EOF marker would itself look
    // like a divergence even though only line 2 actually changed.
    expect(await diffChangedLines('a\nb\n', 'a\nB\n')).toEqual(new Set([2]))
  })

  it('treats a bad-invocation exit code (>1) as nothing to report', async () => {
    // git exits 1 for "files differ" (normal) and 0 for "identical"; any other
    // code means the invocation itself failed, which must not be mistaken for
    // real diff content.
    const spy = vi.spyOn(gitRepo, 'runGit').mockResolvedValue({ code: 128, stdout: '', stderr: 'fatal: bad' })
    try {
      expect(await diffChangedLines('a\nb', 'a\nB')).toEqual(new Set())
    } finally {
      spy.mockRestore()
    }
  })
})
