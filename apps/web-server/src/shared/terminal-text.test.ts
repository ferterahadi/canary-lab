import { describe, expect, it } from 'vitest'
import { stripTerminalEscapes, type TerminalTextProfile } from './terminal-text'

const profiles: TerminalTextProfile[] = ['color', 'classifier', 'verification', 'diagnostic']

describe('terminal cleaning profiles', () => {
  it.each(profiles)('%s removes color and preserves ordinary text and redraws', (profile) => {
    expect(stripTerminalEscapes('\x1b[31mred\x1b[0m', profile)).toBe('red')
    expect(stripTerminalEscapes('plain [text]\rnext\nnext', profile)).toBe('plain [text]\rnext\nnext')
  })

  it.each(profiles)('%s retains its existing escape vocabulary', (profile) => {
    const cursor = '\x1b[20;10H\x1b[2J'
    const privateCsi = '\x1b[>0c'
    const osc = '\x1b]0;title\x07\x1b]0;title\x1b\\\x1b(B\x1b='
    expect(stripTerminalEscapes(cursor, profile)).toBe(profile === 'color' ? cursor : '')
    expect(stripTerminalEscapes(privateCsi, profile)).toBe(profile === 'color' || profile === 'classifier' ? privateCsi : '')
    expect(stripTerminalEscapes(osc, profile)).toBe(profile === 'diagnostic' ? '' : osc)
    expect(stripTerminalEscapes('[2mdim[22m', profile)).toBe(profile === 'diagnostic' ? 'dim' : '[2mdim[22m')
    expect(stripTerminalEscapes('\x1b[31mred\x1b[0m', profile)).toBe('red')
  })
})
