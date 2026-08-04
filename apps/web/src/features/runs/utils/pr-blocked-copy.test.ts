import { describe, expect, it } from 'vitest'
import { BLOCKED_HELP, prBlockedLine } from './pr-blocked-copy'

describe('prBlockedLine', () => {
  it('turns every preflight code into a sentence', () => {
    // A run's attempt record stores the raw code, and the card used to print it.
    for (const [code, help] of Object.entries(BLOCKED_HELP)) {
      expect(prBlockedLine(code)).toBe(help.line)
    }
  })

  it('passes through a reason that is already prose', () => {
    // Written by the failing step, not the preflight — swallowing it would lose
    // the only explanation the card has.
    expect(prBlockedLine('gh pr create returned no URL')).toBe('gh pr create returned no URL')
  })
})
