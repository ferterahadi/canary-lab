import { describe, expect, it } from 'vitest'
import { formatMs, formatSize } from './format-units'

describe('formatSize', () => {
  it('prints bytes, then KB and MB with one decimal', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(1024 * 1024 - 1)).toBe('1024.0 KB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatSize(5 * 1024 * 1024 + 512 * 1024)).toBe('5.5 MB')
  })
})

describe('formatMs', () => {
  it('prints whole milliseconds under a second and seconds above', () => {
    expect(formatMs(0)).toBe('0ms')
    expect(formatMs(250)).toBe('250ms')
    expect(formatMs(999)).toBe('999ms')
    expect(formatMs(1000)).toBe('1.0s')
    expect(formatMs(2400)).toBe('2.4s')
  })

  it('rounds a fractional sub-second value', () => {
    expect(formatMs(12.4)).toBe('12ms')
    expect(formatMs(12.5)).toBe('13ms')
  })
})
