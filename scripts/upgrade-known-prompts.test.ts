import { describe, it, expect } from 'vitest'
import { KNOWN_OLD_HEAL_PROMPTS } from './upgrade-known-prompts'

describe('KNOWN_OLD_HEAL_PROMPTS', () => {
  it('is non-empty and every entry has a version + body', () => {
    expect(KNOWN_OLD_HEAL_PROMPTS.length).toBeGreaterThan(0)
    for (const p of KNOWN_OLD_HEAL_PROMPTS) {
      expect(p.version).toBeTruthy()
      expect(p.body.length).toBeGreaterThan(0)
    }
  })

  it('bodies are unique', () => {
    const seen = new Set<string>()
    for (const p of KNOWN_OLD_HEAL_PROMPTS) {
      expect(seen.has(p.body)).toBe(false)
      seen.add(p.body)
    }
  })
})
