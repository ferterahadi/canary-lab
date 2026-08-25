import { describe, expect, it } from 'vitest'
import type { PortSlot } from '../../../../../../../shared/launcher/types'
import { buildSeededNote, describeSeededSlots, seededSlotsAlreadyDeclared, type SeededFrom } from './portify-worktree-borrow'

const seeded = (ports: PortSlot[], feature = 'feat-a', repos = ['app']): SeededFrom => ({ feature, repos, ports })

describe('describeSeededSlots', () => {
  it('returns undefined when no seeded overlay recorded any slots (legacy overlay)', () => {
    expect(describeSeededSlots([])).toBeUndefined()
    expect(describeSeededSlots([seeded([])])).toBeUndefined()
  })

  it('renders each recorded slot as a declarable config literal, with its repo', () => {
    const out = describeSeededSlots([seeded([{ name: 'api', env: 'PORT' }, { name: 'grpc', env: 'GRPC_PORT' }])])!
    expect(out).toContain("{ name: 'api', env: 'PORT' }")
    expect(out).toContain("{ name: 'grpc', env: 'GRPC_PORT' }")
    expect(out).toContain('(repo: app)')
  })

  it('renders an env-less slot without an env key rather than emitting `env: undefined`', () => {
    const out = describeSeededSlots([seeded([{ name: 'api' }])])!
    expect(out).toContain("{ name: 'api' }")
    expect(out).not.toContain('undefined')
  })

  it('tells the client to add slots this feature needs that the source feature never declared', () => {
    // The whole hazard of a borrow: the same repo booted a DIFFERENT way can
    // bind a listener the source feature never exercised, so the list is a
    // starting point and the copy has to say so.
    const out = describeSeededSlots([seeded([{ name: 'api', env: 'PORT' }])])!
    expect(out).toMatch(/add a slot for any listener/i)
  })
})

describe('buildSeededNote', () => {
  it('returns undefined when nothing was seeded', () => {
    expect(buildSeededNote([])).toBeUndefined()
  })

  it('carries the source feature and the recorded slot list', () => {
    const note = buildSeededNote([seeded([{ name: 'api', env: 'PORT' }])])!
    expect(note).toContain('PRE-APPLIED')
    expect(note).toContain('feat-a')
    expect(note).toContain("{ name: 'api', env: 'PORT' }")
  })

  it('degrades to the bare note for a legacy overlay that recorded no slots', () => {
    const note = buildSeededNote([seeded([])])!
    expect(note).toContain('PRE-APPLIED')
    expect(note).not.toContain('START from this list')
  })
})

describe('seededSlotsAlreadyDeclared', () => {
  const declared: PortSlot[] = [{ name: 'api', env: 'PORT' }, { name: 'grpc', env: 'GRPC_PORT' }]

  it('is false when the overlay recorded no slots — a legacy overlay must not skip the client', () => {
    expect(seededSlotsAlreadyDeclared([], declared)).toBe(false)
    expect(seededSlotsAlreadyDeclared([seeded([])], declared)).toBe(false)
  })

  it('is true when every recorded env var is already declared by this feature', () => {
    expect(seededSlotsAlreadyDeclared([seeded([{ name: 'api', env: 'PORT' }])], declared)).toBe(true)
  })

  it('is false when one recorded env var is missing here — the client still has work', () => {
    expect(
      seededSlotsAlreadyDeclared([seeded([{ name: 'api', env: 'PORT' }, { name: 'ws', env: 'WS_PORT' }])], declared),
    ).toBe(false)
  })

  it('matches on env, not slot name — the name is each config\'s own handle', () => {
    expect(seededSlotsAlreadyDeclared([seeded([{ name: 'gateway', env: 'PORT' }])], declared)).toBe(true)
  })

  it('ignores recorded slots with no env — nothing is injected for them, so they prove nothing', () => {
    expect(seededSlotsAlreadyDeclared([seeded([{ name: 'api' }])], declared)).toBe(false)
  })

  it('ignores declared slots with no env when matching', () => {
    expect(seededSlotsAlreadyDeclared([seeded([{ name: 'api', env: 'PORT' }])], [{ name: 'api' }])).toBe(false)
  })

  it('requires every group of a multi-repo seed to be covered', () => {
    const groups = [seeded([{ name: 'api', env: 'PORT' }], 'feat-a', ['app']), seeded([{ name: 'ws', env: 'WS_PORT' }], 'feat-c', ['other'])]
    expect(seededSlotsAlreadyDeclared(groups, declared)).toBe(false)
    expect(seededSlotsAlreadyDeclared(groups, [...declared, { name: 'ws', env: 'WS_PORT' }])).toBe(true)
  })
})
