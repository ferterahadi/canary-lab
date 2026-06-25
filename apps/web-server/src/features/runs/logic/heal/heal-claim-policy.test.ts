import { describe, it, expect } from 'vitest'
import {
  HEAL_CLAIM_BLOCKED_KINDS,
  isHealClaimAllowed,
  resolveBlockedClaimKinds,
} from './heal-claim-policy'

describe('heal-claim-policy', () => {
  it('blocks only the runner-spawned PTY kinds by default', () => {
    expect(isHealClaimAllowed('claude', {})).toBe(true)
    expect(isHealClaimAllowed('codex', {})).toBe(true)
    expect(isHealClaimAllowed('other', {})).toBe(true)
    expect(isHealClaimAllowed('claude-pty', {})).toBe(false)
    expect(isHealClaimAllowed('codex-pty', {})).toBe(false)
  })

  it('default denylist is exactly the two PTY kinds', () => {
    expect([...HEAL_CLAIM_BLOCKED_KINDS].sort()).toEqual(['claude-pty', 'codex-pty'])
  })

  it('honors the CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS override', () => {
    const env = { CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS: 'claude,claude-pty' }
    expect(isHealClaimAllowed('claude', env)).toBe(false)
    expect(isHealClaimAllowed('claude-pty', env)).toBe(false)
    expect(isHealClaimAllowed('codex', env)).toBe(true)
    expect(isHealClaimAllowed('codex-pty', env)).toBe(true)
  })

  it('trims whitespace and ignores unknown tokens in the override', () => {
    const env = { CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS: ' claude-pty , bogus , codex ' }
    expect(resolveBlockedClaimKinds(env).slice().sort()).toEqual(['claude-pty', 'codex'])
  })

  it('falls back to the default when the override is empty or all-garbage', () => {
    expect(resolveBlockedClaimKinds({ CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS: '   ' })).toEqual(HEAL_CLAIM_BLOCKED_KINDS)
    expect(resolveBlockedClaimKinds({ CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS: 'nope,zzz' })).toEqual(HEAL_CLAIM_BLOCKED_KINDS)
  })
})
