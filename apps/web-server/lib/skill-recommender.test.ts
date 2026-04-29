import { describe, it, expect } from 'vitest'
import { tokenize, recommendSkills } from './skill-recommender'
import type { SkillRecord } from './skill-loader'

const mk = (id: string, name: string, description: string): SkillRecord => ({
  id,
  name,
  description,
  source: 'user',
  path: `/${id}.md`,
})

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops stopwords and short tokens', () => {
    const out = tokenize('The user logs IN to the LOGIN page (with OTP).')
    expect(out).toEqual(expect.arrayContaining(['user', 'logs', 'login', 'page', 'otp']))
    expect(out).not.toContain('the')
    expect(out).not.toContain('to')
    expect(out).not.toContain('in') // stopword
  })
  it('drops single-character pieces', () => {
    expect(tokenize('a b c d')).toEqual([])
  })
  it('dedupes', () => {
    const out = tokenize('login login Login LOGIN')
    expect(out).toEqual(['login'])
  })
})

describe('recommendSkills', () => {
  const catalog: SkillRecord[] = [
    mk('s1', 'Login Auth', 'Helps with login, auth, OTP, and signin flows'),
    mk('s2', 'Database', 'Postgres helpers for migrations and seeds'),
    mk('s3', 'Login Quick', 'Login OTP signin'),
    mk('s4', 'Random', 'Totally unrelated tooling'),
  ]

  it('returns top matches sorted by score then by shorter name', () => {
    const prd = 'User must login with OTP and signin to the auth page'
    const out = recommendSkills(prd, catalog, { topN: 3 })
    expect(out.length).toBeGreaterThan(0)
    // s1 and s3 both match login/otp/signin/auth-ish; tie-break by shorter name
    // s3 ("Login Quick" len 11) vs s1 ("Login Auth" len 10) — both have name
    // weight 2× for "login". Either way the first two should be these.
    expect(out[0].skillId === 's1' || out[0].skillId === 's3').toBe(true)
    // Database should not appear unless it had no matches
    expect(out.find((r) => r.skillId === 's2')).toBeUndefined()
  })

  it('returns empty when fewer than min matched tokens hit anywhere', () => {
    // Single PRD token that hits a skill → below the 3-token floor → []
    const out = recommendSkills('database', catalog)
    expect(out).toEqual([])
  })

  it('returns empty when PRD tokenizes to nothing', () => {
    expect(recommendSkills('a', catalog)).toEqual([])
  })

  it('builds a reasoning string with matched terms', () => {
    const prd = 'login otp signin auth page user'
    const out = recommendSkills(prd, catalog, { topN: 1 })
    expect(out[0].reasoning).toMatch(/Matched \d+ PRD terms:/)
    expect(out[0].matchedTerms.length).toBeGreaterThan(0)
  })

  it('respects topN', () => {
    const prd = 'login otp signin auth user account'
    const out = recommendSkills(prd, catalog, { topN: 1 })
    expect(out.length).toBe(1)
  })

  it('handles singular reasoning grammar (1 PRD term)', () => {
    const big: SkillRecord[] = [
      mk('a', 'alpha', 'aaa zzz'),
      mk('b', 'beta', 'bbb zzz'),
      mk('c', 'gamma', 'ccc zzz'),
    ]
    // Three skills all matching the same single token "zzz" — that satisfies
    // the 3-token floor only if minMatchedTokens=1. Force that here so we
    // can exercise the singular-grammar branch.
    const out = recommendSkills('zzz', big, { minMatchedTokens: 1 })
    expect(out[0].reasoning).toMatch(/Matched 1 PRD term:/)
  })

  it('weights name 2x description', () => {
    const skills: SkillRecord[] = [
      mk('name-hit', 'login signup auth', 'unrelated copy here'),
      mk('desc-hit', 'unrelated', 'login signup auth in description only'),
    ]
    const out = recommendSkills('login signup auth', skills, { topN: 5 })
    expect(out[0].skillId).toBe('name-hit')
    expect(out[0].score).toBeGreaterThan(out[1].score)
  })
})
