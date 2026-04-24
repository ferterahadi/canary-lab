import { describe, it, expect, afterEach } from 'vitest'
import { ansi, c, colorEnabled, style } from './colors'

const ORIGINAL_TTY = process.stdout.isTTY
const ORIGINAL_NO_COLOR = process.env.NO_COLOR

afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', {
    value: ORIGINAL_TTY,
    configurable: true,
    writable: true,
  })
  if (ORIGINAL_NO_COLOR === undefined) delete process.env.NO_COLOR
  else process.env.NO_COLOR = ORIGINAL_NO_COLOR
})

function setTty(isTTY: boolean) {
  Object.defineProperty(process.stdout, 'isTTY', {
    value: isTTY,
    configurable: true,
    writable: true,
  })
}

describe('colorEnabled', () => {
  it('returns true when stdout is a TTY and NO_COLOR is unset', () => {
    setTty(true)
    delete process.env.NO_COLOR
    expect(colorEnabled()).toBe(true)
  })

  it('returns false when stdout is not a TTY', () => {
    setTty(false)
    delete process.env.NO_COLOR
    expect(colorEnabled()).toBe(false)
  })

  it('returns false when NO_COLOR is set', () => {
    setTty(true)
    process.env.NO_COLOR = '1'
    expect(colorEnabled()).toBe(false)
  })
})

describe('c', () => {
  it('wraps text in ANSI codes when color is enabled', () => {
    setTty(true)
    delete process.env.NO_COLOR
    expect(c('green', 'ok')).toBe(`${ansi.green}ok${ansi.reset}`)
  })

  it('returns raw text when color is disabled', () => {
    setTty(false)
    expect(c('red', 'err')).toBe('err')
  })
})

describe('style', () => {
  it('composes multiple ANSI prefixes when enabled', () => {
    setTty(true)
    delete process.env.NO_COLOR
    expect(style(['bold', 'cyan'], 'x')).toBe(`${ansi.bold}${ansi.cyan}x${ansi.reset}`)
  })

  it('returns raw text when disabled', () => {
    setTty(false)
    expect(style(['bold', 'cyan'], 'x')).toBe('x')
  })
})
