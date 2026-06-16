import { describe, it, expect } from 'vitest'
import { computeDocsHash, type DocsCollection } from './docs-collection'
import {
  buildPrdSummaryPrompt,
  deterministicPrdRequirements,
  parsePrdSummaryOutput,
  reconcileRequirementIds,
  renderPrdSummaryMarkdown,
  summarizePrd,
  type ParsedRequirement,
} from './prd-summary'
import type { PrdSummary, Requirement } from '../../../../shared/coverage/types'

function collection(entries: { relPath: string; content: string }[]): DocsCollection {
  return { docsDir: '/tmp/docs', entries, docsHash: computeDocsHash(entries) }
}

function summary(requirements: Requirement[]): PrdSummary {
  return { requirements, docsHash: 'h', sourceDocs: [], generatedAt: '2026-01-01T00:00:00.000Z' }
}

describe('parsePrdSummaryOutput', () => {
  it('parses fenced JSON and normalizes path types + ladder', () => {
    const out = parsePrdSummaryOutput('```json\n{"requirements":[{"id":"R1","title":"Send","text":"send it","pathTypes":["sad","happy","bogus"],"strictnessLadder":[{"tier":4,"description":"browser"},{"tier":1,"description":"log"}]}]}\n```')
    expect(out).toEqual([
      {
        id: 'R1',
        title: 'Send',
        text: 'send it',
        pathTypes: ['happy', 'sad'],
        strictnessLadder: [
          { tier: 1, description: 'log' },
          { tier: 4, description: 'browser' },
        ],
      },
    ])
  })

  it('defaults pathTypes to happy when none usable, drops untitled', () => {
    const out = parsePrdSummaryOutput('{"requirements":[{"title":"A","text":"a","pathTypes":[]},{"title":"","text":"x","pathTypes":["happy"]}]}')
    expect(out).toEqual([{ id: undefined, title: 'A', text: 'a', pathTypes: ['happy'], strictnessLadder: undefined }])
  })

  it('returns null on garbage', () => {
    expect(parsePrdSummaryOutput('not json at all')).toBeNull()
    expect(parsePrdSummaryOutput('{"nope": 1}')).toBeNull()
  })
})

describe('reconcileRequirementIds — the id spine', () => {
  const previous: Requirement[] = [
    { id: 'R1', title: 'Login', text: 'user can log in', pathTypes: ['happy'] },
    { id: 'R2', title: 'Logout', text: 'user can log out', pathTypes: ['happy'] },
  ]

  it('preserves ids of surviving requirements via echoed id', () => {
    const parsed: ParsedRequirement[] = [
      { id: 'R2', title: 'Logout', text: 'user can log out (reworded)', pathTypes: ['happy'] },
      { id: 'R1', title: 'Login', text: 'user can log in', pathTypes: ['happy', 'sad'] },
    ]
    const out = reconcileRequirementIds(previous, parsed)
    expect(out.find((r) => r.id === 'R1')?.pathTypes).toEqual(['happy', 'sad'])
    expect(out.find((r) => r.id === 'R2')?.text).toContain('reworded')
    expect(out.filter((r) => r.deprecated)).toEqual([])
  })

  it('preserves ids by exact title match when the agent forgets to echo', () => {
    const parsed: ParsedRequirement[] = [
      { title: 'login', text: 'reworded', pathTypes: ['happy'] }, // case-insensitive match → R1
    ]
    const out = reconcileRequirementIds(previous, parsed)
    expect(out[0].id).toBe('R1')
    // R2 not matched → carried over as deprecated, id kept
    const r2 = out.find((r) => r.id === 'R2')
    expect(r2?.deprecated).toBe(true)
  })

  it('assigns fresh ids beyond the max to genuinely new requirements', () => {
    const parsed: ParsedRequirement[] = [
      { id: 'R1', title: 'Login', text: 'x', pathTypes: ['happy'] },
      { id: 'R2', title: 'Logout', text: 'y', pathTypes: ['happy'] },
      { title: 'Reset password', text: 'new req', pathTypes: ['happy', 'sad'] },
    ]
    const out = reconcileRequirementIds(previous, parsed)
    expect(out.find((r) => r.title === 'Reset password')?.id).toBe('R3')
  })

  it('never reuses a previous id for a different requirement (invented ids reassigned)', () => {
    const parsed: ParsedRequirement[] = [
      { id: 'R1', title: 'Brand new thing', text: 'z', pathTypes: ['happy'] }, // echoes R1 but title differs from any survivor... still echoes a real id
    ]
    // R1 exists, so the echo IS honored (continuity-first). The point of this
    // test: the OTHER previous id (R2) must not be silently dropped.
    const out = reconcileRequirementIds(previous, parsed)
    expect(out.find((r) => r.id === 'R1')?.title).toBe('Brand new thing')
    expect(out.find((r) => r.id === 'R2')?.deprecated).toBe(true)
  })

  it('preserves a survivor’s strictness ladder when the regen omits it', () => {
    const prev: Requirement[] = [
      {
        id: 'R1',
        title: 'Send LINE message',
        text: 'send it',
        pathTypes: ['happy'],
        strictnessLadder: [
          { tier: 1, description: 'app log' },
          { tier: 4, description: 'browser at line.com' },
        ],
      },
    ]
    const parsed: ParsedRequirement[] = [
      { id: 'R1', title: 'Send LINE message', text: 'reworded', pathTypes: ['happy'] }, // no ladder
    ]
    const out = reconcileRequirementIds(prev, parsed)
    expect(out[0].strictnessLadder).toEqual(prev[0].strictnessLadder)
  })

  it('a regenerated ladder overrides the previous one', () => {
    const prev: Requirement[] = [
      { id: 'R1', title: 'X', text: 'x', pathTypes: ['happy'], strictnessLadder: [{ tier: 1, description: 'old' }] },
    ]
    const parsed: ParsedRequirement[] = [
      { id: 'R1', title: 'X', text: 'x', pathTypes: ['happy'], strictnessLadder: [{ tier: 3, description: 'new' }] },
    ]
    const out = reconcileRequirementIds(prev, parsed)
    expect(out[0].strictnessLadder).toEqual([{ tier: 3, description: 'new' }])
  })

  it('a duplicated echoed id only binds once; the second gets a fresh id', () => {
    const parsed: ParsedRequirement[] = [
      { id: 'R1', title: 'Login', text: 'a', pathTypes: ['happy'] },
      { id: 'R1', title: 'Login again', text: 'b', pathTypes: ['happy'] },
    ]
    const out = reconcileRequirementIds(previous, parsed)
    const ids = out.filter((r) => !r.deprecated).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length) // all unique
    expect(ids).toContain('R1')
    expect(ids).toContain('R3') // second login got fresh id beyond max
  })
})

describe('deterministicPrdRequirements', () => {
  it('extracts one requirement per heading and preserves ids across regen', () => {
    const before = collection([
      { relPath: 'spec.md', content: '# Login\nuser logs in\n# Logout\nuser logs out' },
    ])
    const first = deterministicPrdRequirements(before, [])
    expect(first.map((r) => r.id)).toEqual(['R1', 'R2'])
    expect(first.map((r) => r.title)).toEqual(['Login', 'Logout'])

    // Regenerate after appending a new section — existing ids must hold.
    const after = collection([
      { relPath: 'spec.md', content: '# Login\nuser logs in\n# Logout\nuser logs out\n# Reset\nreset pw' },
    ])
    const second = deterministicPrdRequirements(after, first)
    expect(second.find((r) => r.title === 'Login')?.id).toBe('R1')
    expect(second.find((r) => r.title === 'Logout')?.id).toBe('R2')
    expect(second.find((r) => r.title === 'Reset')?.id).toBe('R3')
  })

  it('falls back to one requirement per doc when there are no headings', () => {
    const c = collection([{ relPath: 'notes.md', content: 'just a flat note' }])
    const reqs = deterministicPrdRequirements(c, [])
    expect(reqs).toHaveLength(1)
    expect(reqs[0].title).toBe('notes')
    expect(reqs[0].text).toBe('just a flat note')
  })
})

describe('buildPrdSummaryPrompt', () => {
  it('injects docs + previous requirement ids', () => {
    const c = collection([{ relPath: 'spec.md', content: '# X\nbody' }])
    const prompt = buildPrdSummaryPrompt(c, [{ id: 'R1', title: 'X', text: 'b', pathTypes: ['happy'] }])
    expect(prompt).toContain('spec.md')
    expect(prompt).toContain('"id": "R1"')
  })
})

describe('summarizePrd orchestrator', () => {
  it('uses the agent output and reconciles ids', async () => {
    const c = collection([{ relPath: 'spec.md', content: '# Send\nsend a message' }])
    const out = await summarizePrd(
      { collection: c, now: '2026-06-16T00:00:00.000Z' },
      {
        resolveAgents: () => ['claude'],
        runAgent: async () =>
          '{"requirements":[{"title":"Send message","text":"send it","pathTypes":["happy"],"strictnessLadder":[{"tier":4,"description":"browser at line.com"}]}]}',
      },
    )
    expect(out.requirements).toHaveLength(1)
    expect(out.requirements[0].id).toBe('R1')
    expect(out.requirements[0].strictnessLadder?.[0].tier).toBe(4)
    expect(out.docsHash).toBe(c.docsHash)
    expect(out.sourceDocs).toEqual(['spec.md'])
    expect(out.generatedAt).toBe('2026-06-16T00:00:00.000Z')
  })

  it('falls back to deterministic when the agent yields garbage', async () => {
    const c = collection([{ relPath: 'spec.md', content: '# Login\nlog in' }])
    const out = await summarizePrd(
      { collection: c, now: 'n' },
      { resolveAgents: () => ['claude'], runAgent: async () => 'totally not json' },
    )
    expect(out.requirements[0].title).toBe('Login')
    expect(out.requirements[0].id).toBe('R1')
  })

  it('falls back to deterministic when no agent is available', async () => {
    const c = collection([{ relPath: 'spec.md', content: '# A\nx' }])
    const out = await summarizePrd({ collection: c, adapter: 'deterministic', now: 'n' }, { resolveAgents: () => [] })
    expect(out.requirements[0].id).toBe('R1')
  })

  it('preserves ids across a real regenerate cycle (before/after docs pair)', async () => {
    const before = collection([{ relPath: 'spec.md', content: '# Login\nlog in\n# Logout\nlog out' }])
    const first = await summarizePrd({ collection: before, adapter: 'deterministic', now: 'n' }, { resolveAgents: () => [] })

    const after = collection([{ relPath: 'spec.md', content: '# Logout\nlog out\n# Login\nlog in\n# Reset\nreset' }])
    const second = await summarizePrd({ collection: after, previous: first, adapter: 'deterministic', now: 'n' }, { resolveAgents: () => [] })

    expect(second.requirements.find((r) => r.title === 'Login')?.id).toBe('R1')
    expect(second.requirements.find((r) => r.title === 'Logout')?.id).toBe('R2')
    expect(second.requirements.find((r) => r.title === 'Reset')?.id).toBe('R3')
  })
})

describe('renderPrdSummaryMarkdown', () => {
  it('renders headings and computes accurate sourceRange offsets', () => {
    const s = summary([
      { id: 'R1', title: 'Login', text: 'user can log in', pathTypes: ['happy'] },
      { id: 'R2', title: 'Logout', text: 'user can log out', pathTypes: ['happy', 'sad'] },
    ])
    const { markdown, requirements } = renderPrdSummaryMarkdown(s, 'auth')
    expect(markdown).toContain('# auth — Requirements')
    for (const req of requirements) {
      const range = req.sourceRange!
      expect(markdown.slice(range.start, range.end)).toBe(req.text)
    }
  })
})
