import { describe, expect, it } from 'vitest'
import { clampToViewport } from './viewport'

const anchor = { left: 300, right: 340 }

describe('clampToViewport', () => {
  it('aligns to the anchor when there is room', () => {
    expect(clampToViewport(anchor, 100, 'start', 1000)).toBe(300)
    expect(clampToViewport(anchor, 100, 'center', 1000)).toBe(270)
    expect(clampToViewport(anchor, 100, 'end', 1000)).toBe(240)
  })

  it('keeps the edge margin on the right side', () => {
    expect(clampToViewport({ left: 950, right: 990 }, 100, 'start', 1000)).toBe(892)
  })

  it('keeps the edge margin on the left side', () => {
    expect(clampToViewport({ left: 0, right: 40 }, 100, 'end', 1000)).toBe(8)
    expect(clampToViewport({ left: 0, right: 10 }, 100, 'center', 1000, 12)).toBe(12)
  })

  it('lets the left margin win when the viewport is too narrow for both', () => {
    expect(clampToViewport(anchor, 300, 'start', 200)).toBe(8)
  })
})
