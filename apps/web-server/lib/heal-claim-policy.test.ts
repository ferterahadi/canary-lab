import { describe, it, expect } from 'vitest'
import {
  HEAL_CLAIM_ALLOWED_KINDS,
  isHealClaimAllowed,
  resolveAllowedClaimKinds,
} from './heal-claim-policy'

describe('heal-claim-policy', () => {
  it('allows only desktop client kinds by default', () => {
    expect(isHealClaimAllowed('claude-desktop', {})).toBe(true)
    expect(isHealClaimAllowed('codex-desktop', {})).toBe(true)
    expect(isHealClaimAllowed('claude-cli', {})).toBe(false)
    expect(isHealClaimAllowed('codex-cli', {})).toBe(false)
    expect(isHealClaimAllowed('other', {})).toBe(false)
  })

  it('default allowlist is exactly the two desktop kinds', () => {
    expect([...HEAL_CLAIM_ALLOWED_KINDS].sort()).toEqual(['claude-desktop', 'codex-desktop'])
  })

  it('honors the CANARY_LAB_HEAL_CLAIM_CLIENTS override', () => {
    const env = { CANARY_LAB_HEAL_CLAIM_CLIENTS: 'claude-cli,claude-desktop' }
    expect(isHealClaimAllowed('claude-cli', env)).toBe(true)
    expect(isHealClaimAllowed('claude-desktop', env)).toBe(true)
    expect(isHealClaimAllowed('codex-cli', env)).toBe(false)
  })

  it('trims whitespace and ignores unknown tokens in the override', () => {
    const env = { CANARY_LAB_HEAL_CLAIM_CLIENTS: ' claude-cli , bogus , codex-desktop ' }
    expect(resolveAllowedClaimKinds(env).slice().sort()).toEqual(['claude-cli', 'codex-desktop'])
  })

  it('falls back to the default when the override is empty or all-garbage', () => {
    expect(resolveAllowedClaimKinds({ CANARY_LAB_HEAL_CLAIM_CLIENTS: '   ' })).toEqual(HEAL_CLAIM_ALLOWED_KINDS)
    expect(resolveAllowedClaimKinds({ CANARY_LAB_HEAL_CLAIM_CLIENTS: 'nope,zzz' })).toEqual(HEAL_CLAIM_ALLOWED_KINDS)
  })
})
