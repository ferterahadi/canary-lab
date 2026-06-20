import { describe, it, expect } from 'vitest'
import { RingBuffer } from './ring-buffer'

describe('RingBuffer', () => {
  it('stores chunks under the cap verbatim', () => {
    const rb = new RingBuffer(100)
    rb.append('hello ')
    rb.append('world')
    expect(rb.snapshot()).toBe('hello world')
    expect(rb.byteLength()).toBe(11)
  })

  it('trims the head chunk to keep the cap when total exceeds it', () => {
    const rb = new RingBuffer(10)
    rb.append('1234567890')
    rb.append('abcdef')
    // 16 bytes total, cap 10 → trim 6 bytes from the head, keeping the most
    // recent 10 bytes.
    expect(rb.snapshot()).toBe('7890abcdef')
    expect(rb.byteLength()).toBe(10)
  })

  it('drops whole head chunks when one chunk alone exceeds the cap', () => {
    const rb = new RingBuffer(5)
    rb.append('aa') // 2 bytes
    rb.append('bbbbbbb') // 7 bytes — combined 9, overflow 4 → trim head down
    rb.append('CC') // pushes the original head fully out
    expect(rb.byteLength()).toBeLessThanOrEqual(5)
    expect(rb.snapshot().endsWith('CC')).toBe(true)
  })

  it('ignores empty appends', () => {
    const rb = new RingBuffer(10)
    rb.append('')
    expect(rb.byteLength()).toBe(0)
    expect(rb.snapshot()).toBe('')
  })

  it('records exit info', () => {
    const rb = new RingBuffer(10)
    expect(rb.exitInfo()).toBeNull()
    rb.markExit(0)
    expect(rb.exitInfo()).toEqual({ code: 0 })
  })

  it('clear resets state', () => {
    const rb = new RingBuffer(10)
    rb.append('xyz')
    rb.markExit(2)
    rb.clear()
    expect(rb.snapshot()).toBe('')
    expect(rb.byteLength()).toBe(0)
    expect(rb.exitInfo()).toBeNull()
  })
})
