import { describe, it, expect } from 'vitest'
import { diffChangedLines } from './text-diff'

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
})
