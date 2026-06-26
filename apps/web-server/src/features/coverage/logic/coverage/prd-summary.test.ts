import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeDocsHash, type DocsCollection } from '../../../coverage/logic/coverage/docs-collection'
import {
  assembleSummary,
  buildPrdSummaryPrompt,
  parsePrdSummaryOutput,
  parseVariantDimension,
  reconcileRequirementIds,
  renderPrdSummaryMarkdown,
  readPrdSummary,
  summarizePrd,
  writePrdSummary,
  PRD_SUMMARY_JSON,
  PRD_SUMMARY_MD,
  type ParsedRequirement,
} from './prd-summary'
import type { PrdSummary, Requirement } from '../../../../../../../shared/coverage/types'

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

  it('parses kind + happy/unhappy path prose', () => {
    const out = parsePrdSummaryOutput('{"requirements":[{"id":"R1","kind":"non-functional","title":"Hash","text":"It should hash at rest","happyPath":"stored as digest","unhappyPath":"  ","pathTypes":["happy"]}]}')
    expect(out).toEqual([
      { id: 'R1', kind: 'non-functional', title: 'Hash', text: 'It should hash at rest', happyPath: 'stored as digest', pathTypes: ['happy'] },
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

  it('skips null/non-object items in requirements array (line 138 branch)', () => {
    // A null element in the requirements array → `!raw || ...` TRUE → continue (skip)
    const out = parsePrdSummaryOutput(
      JSON.stringify({ requirements: [null, { title: 'A', text: 'a', pathTypes: ['happy'] }] }),
    )
    expect(out).toHaveLength(1)
    expect(out![0].title).toBe('A')
  })

  it('skips items with non-string title or text (line 140 branch)', () => {
    // title is a number → `typeof r.title !== 'string'` TRUE → continue (skip)
    const out = parsePrdSummaryOutput(
      JSON.stringify({ requirements: [{ title: 42, text: 'a', pathTypes: ['happy'] }] }),
    )
    expect(out).toEqual([])
  })

  it('normalizePathTypes returns happy when not an array (line 91 branch)', () => {
    // pathTypes is a string, not an array → normalizePathTypes returns ['happy']
    const out = parsePrdSummaryOutput(
      JSON.stringify({ requirements: [{ title: 'A', text: 'a', pathTypes: 'happy' }] }),
    )
    expect(out![0].pathTypes).toEqual(['happy'])
  })

  it('normalizeLadder: skips null items in ladder array (line 108 branch)', () => {
    // strictnessLadder contains null → `!item` TRUE → continue (skip)
    const out = parsePrdSummaryOutput(
      JSON.stringify({
        requirements: [{
          title: 'A', text: 'a', pathTypes: ['happy'],
          strictnessLadder: [null, { tier: 1, description: 'log' }],
        }],
      }),
    )
    expect(out![0].strictnessLadder).toEqual([{ tier: 1, description: 'log' }])
  })

  it('normalizeLadder: skips items with invalid tier (line 111 branch)', () => {
    // tier 99 is not in TIERS → `!(TIERS as number[]).includes(tier)` TRUE → continue
    const out = parsePrdSummaryOutput(
      JSON.stringify({
        requirements: [{
          title: 'A', text: 'a', pathTypes: ['happy'],
          strictnessLadder: [{ tier: 99, description: 'invalid' }, { tier: 1, description: 'log' }],
        }],
      }),
    )
    expect(out![0].strictnessLadder).toEqual([{ tier: 1, description: 'log' }])
  })

  it('normalizeLadder: skips duplicate tiers (line 112 branch)', () => {
    // Two rungs with tier=1 → second is a duplicate → seenTiers.has(tier) TRUE → skipped
    const out = parsePrdSummaryOutput(
      JSON.stringify({
        requirements: [{
          title: 'A', text: 'a', pathTypes: ['happy'],
          strictnessLadder: [
            { tier: 1, description: 'first log' },
            { tier: 1, description: 'duplicate log' },
          ],
        }],
      }),
    )
    expect(out![0].strictnessLadder).toHaveLength(1)
    expect(out![0].strictnessLadder![0].description).toBe('first log')
  })

  it('normalizeLadder: skips items with empty description (line 113 branch)', () => {
    // description is '   ' → trim() is '' → falsy → continue (skip)
    const out = parsePrdSummaryOutput(
      JSON.stringify({
        requirements: [{
          title: 'A', text: 'a', pathTypes: ['happy'],
          strictnessLadder: [
            { tier: 1, description: '   ' },  // empty after trim
            { tier: 4, description: 'browser' },
          ],
        }],
      }),
    )
    expect(out![0].strictnessLadder).toEqual([{ tier: 4, description: 'browser' }])
  })

  it('normalizeLadder: returns undefined when no valid rungs (line 118 branch)', () => {
    // All ladder items have invalid tiers → rungs = [] → return undefined
    const out = parsePrdSummaryOutput(
      JSON.stringify({
        requirements: [{
          title: 'A', text: 'a', pathTypes: ['happy'],
          strictnessLadder: [{ tier: 99, description: 'nope' }],
        }],
      }),
    )
    expect(out![0].strictnessLadder).toBeUndefined()
  })
})

describe('parseVariantDimension + requirement variants (D1)', () => {
  it('parses a valid dimension (name + ≥2 values, lower-cased + deduped)', () => {
    const out = parseVariantDimension('{"variantDimension":{"name":"Channel","values":["Email","whatsapp","email"]},"requirements":[]}')
    expect(out).toEqual({ name: 'channel', values: ['email', 'whatsapp'] })
  })

  it('drops a one-value "dimension" (no breadth to track)', () => {
    expect(parseVariantDimension('{"variantDimension":{"name":"channel","values":["email"]},"requirements":[]}')).toBeUndefined()
  })

  it('returns undefined when no dimension is declared', () => {
    expect(parseVariantDimension('{"requirements":[]}')).toBeUndefined()
  })

  it('returns undefined when name is a whitespace-only string (normalizeVariantValue empty-string branch)', () => {
    expect(parseVariantDimension('{"variantDimension":{"name":"   ","values":["email","sms"]}}')).toBeUndefined()
  })

  it('returns undefined when values is not an array (normalizeVariantDimension guard branch)', () => {
    expect(parseVariantDimension('{"variantDimension":{"name":"channel","values":"email,sms"}}')).toBeUndefined()
  })

  it('validates requirement variants against the dimension (drops unknowns; needs ≥2)', () => {
    const dim = parseVariantDimension('{"variantDimension":{"name":"channel","values":["email","whatsapp","call","line"]}}')
    const out = parsePrdSummaryOutput(
      '{"requirements":[{"title":"all","text":"t","pathTypes":["happy"],"variants":["email","whatsapp","sms"]},{"title":"one","text":"t","pathTypes":["happy"],"variants":["email"]}]}',
      dim,
    )
    // R-all: sms dropped (not in vocab) → email+whatsapp kept.
    expect(out![0].variants).toEqual(['email', 'whatsapp'])
    // R-one: single declared value → no breadth → variants omitted.
    expect(out![1].variants).toBeUndefined()
  })

  it('ignores requirement variants when there is no dimension', () => {
    const out = parsePrdSummaryOutput('{"requirements":[{"title":"x","text":"t","pathTypes":["happy"],"variants":["email","whatsapp"]}]}')
    expect(out![0].variants).toBeUndefined()
  })

  it('parses variantsNA (within declared variants, non-empty reason), dropping strays', () => {
    const dim = parseVariantDimension('{"variantDimension":{"name":"channel","values":["email","whatsapp","call","line"]}}')
    const out = parsePrdSummaryOutput(
      JSON.stringify({ requirements: [{
        title: 'cfg', text: 't', pathTypes: ['happy'],
        variants: ['email', 'whatsapp', 'call', 'line'],
        variantsNA: [
          { variant: 'whatsapp', reason: 'no v2 endpoint' },
          { variant: 'call', reason: '' },          // empty reason → dropped
          { variant: 'sms', reason: 'not declared' }, // not in variants → dropped
        ],
      }] }),
      dim,
    )
    expect(out![0].variantsNA).toEqual([{ variant: 'whatsapp', reason: 'no v2 endpoint' }])
  })

  it('drops variantsNA entirely when the requirement declares no variants', () => {
    const dim = parseVariantDimension('{"variantDimension":{"name":"channel","values":["email","whatsapp"]}}')
    const out = parsePrdSummaryOutput(
      JSON.stringify({ requirements: [{ title: 'x', text: 't', pathTypes: ['happy'], variantsNA: [{ variant: 'email', reason: 'r' }] }] }),
      dim,
    )
    expect(out![0].variantsNA).toBeUndefined()
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

  it('skips duplicate normalized titles in previous when building the title map (line 183 false branch)', () => {
    // Two previous requirements with the same normalized title → the second iteration
    // hits the FALSE branch of `if (!prevByTitle.has(key))` (already set, so skip).
    const dupPrevious: Requirement[] = [
      { id: 'R1', title: 'Login Feature', text: 'log in', pathTypes: ['happy'] },
      { id: 'R2', title: 'Login Feature', text: 'also login', pathTypes: ['happy'] }, // same normalized title
    ]
    const parsed: ParsedRequirement[] = [
      { title: 'Login Feature', text: 'updated', pathTypes: ['happy'] },
    ]
    const out = reconcileRequirementIds(dupPrevious, parsed)
    // Title match resolves to R1 (the first one stored under that normalized key)
    expect(out.find((r) => r.id === 'R1')?.title).toBe('Login Feature')
    // R2 survives as deprecated since it wasn't matched
    expect(out.find((r) => r.id === 'R2')?.deprecated).toBe(true)
  })
})

describe('reconcileRequirementIds — id stability', () => {
  it('maxIdNumber handles non-Rn ids (line 161 false branch)', () => {
    // Previous ids include a non-matching id like 'CUSTOM-1' → regex match fails →
    // max stays 0 → fresh id starts at R1.
    const previous: Requirement[] = [
      { id: 'CUSTOM-1', title: 'Custom req', text: 'custom', pathTypes: ['happy'] },
    ]
    const parsed: ParsedRequirement[] = [
      { title: 'New req', text: 'new', pathTypes: ['happy'] },
    ]
    const out = reconcileRequirementIds(previous, parsed)
    // Fresh id starts at R1 since maxIdNumber('CUSTOM-1') returns 0
    expect(out.find((r) => r.title === 'New req')?.id).toBe('R1')
    // The old custom id is deprecated
    expect(out.find((r) => r.id === 'CUSTOM-1')?.deprecated).toBe(true)
  })
})

describe('buildPrdSummaryPrompt', () => {
  it('lists source doc paths to read (no inlined body) + previous requirement ids', () => {
    const c = collection([{ relPath: 'spec.md', content: '# X\nUNIQUE_DOC_BODY_TOKEN' }])
    const prompt = buildPrdSummaryPrompt(c, [{ id: 'R1', title: 'X', text: 'b', pathTypes: ['happy'] }])
    // Agentic: the prompt lists the resolvable file path so the agent READS it
    // with its tools — the body is NOT inlined, so it can't shortcut to one-shot.
    expect(prompt).toContain('/tmp/docs/spec.md')
    expect(prompt).not.toContain('UNIQUE_DOC_BODY_TOKEN')
    expect(prompt).toContain('"id": "R1"')
  })

  it('returns unknown {{key}} placeholders unchanged (return match branch)', () => {
    // Pass a custom templatePath with an unknown placeholder to hit `return match`.
    const os = require('os') as typeof import('os')
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const tmpFile = path.join(os.tmpdir(), `canary-prd-tmpl-${Date.now()}.md`)
    try {
      fs.writeFileSync(tmpFile, '{{docs}} {{unknown}}')
      const c = collection([{ relPath: 'spec.md', content: 'content' }])
      const prompt = buildPrdSummaryPrompt(c, [], undefined, tmpFile)
      expect(prompt).toContain('{{unknown}}')
    } finally {
      fs.rmSync(tmpFile, { force: true })
    }
  })
})

describe('parsePrdSummaryOutput — invalid JSON catch branch', () => {
  it('returns null when JSON.parse throws (invalid JSON with braces)', () => {
    // `{invalid}` has { and } so start/end checks pass, but JSON.parse throws.
    expect(parsePrdSummaryOutput('{invalid json}')).toBeNull()
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

  it('throws (LLM-only) when every agent returns unparseable output', async () => {
    const c = collection([{ relPath: 'spec.md', content: '# Login\nlog in' }])
    await expect(
      summarizePrd(
        { collection: c, now: 'n' },
        { resolveAgents: () => ['claude'], runAgent: async () => 'totally not json' },
      ),
    ).rejects.toThrow(/requires the claude or codex agent/)
  })

  it('throws (LLM-only) when no agent is available', async () => {
    const c = collection([{ relPath: 'spec.md', content: '# A\nx' }])
    await expect(
      summarizePrd({ collection: c, now: 'n' }, { resolveAgents: () => [] }),
    ).rejects.toThrow(/requires the claude or codex agent/)
  })

  it('preserves ids across a real regenerate cycle (agent output, before/after docs pair)', async () => {
    const reqsJson = (titles: string[]) =>
      JSON.stringify({ requirements: titles.map((t) => ({ title: t, text: t.toLowerCase(), pathTypes: ['happy'] })) })
    const before = collection([{ relPath: 'spec.md', content: '# Login\nlog in\n# Logout\nlog out' }])
    const first = await summarizePrd(
      { collection: before, now: 'n' },
      { resolveAgents: () => ['claude'], runAgent: async () => reqsJson(['Login', 'Logout']) },
    )

    const after = collection([{ relPath: 'spec.md', content: '# Logout\nlog out\n# Login\nlog in\n# Reset\nreset' }])
    const second = await summarizePrd(
      { collection: after, previous: first, now: 'n' },
      { resolveAgents: () => ['claude'], runAgent: async () => reqsJson(['Logout', 'Login', 'Reset']) },
    )

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

  it('groups by functional/non-functional, enumerates, and spells out happy + unhappy paths', () => {
    const s = summary([
      { id: 'R1', kind: 'functional', title: 'Issue PAT', text: 'It should issue a token on approval', happyPath: 'approver clicks approve → token issued', unhappyPath: 'rejection returns 403, no token', pathTypes: ['happy', 'sad'] },
      { id: 'R2', kind: 'non-functional', title: 'Hash at rest', text: 'It should store only a hashed token', happyPath: 'secret stored as SHA-256 digest', pathTypes: ['happy'] },
    ])
    const { markdown } = renderPrdSummaryMarkdown(s, 'pat')
    // No problem-statement preamble — opens straight into grouped requirements.
    expect(markdown).toContain('## Functional requirements')
    expect(markdown).toContain('## Non-functional requirements')
    expect(markdown).toContain('### 1. R1 — Issue PAT')
    expect(markdown).toContain('### 1. R2 — Hash at rest') // re-enumerated per section
    expect(markdown).toContain('**Happy path:** approver clicks approve → token issued')
    expect(markdown).toContain('**Unhappy path:** rejection returns 403, no token')
    // A requirement without an unhappy path omits the line rather than inventing one.
    const r2Block = markdown.slice(markdown.indexOf('### 1. R2'))
    expect(r2Block).not.toContain('**Unhappy path:**')
  })

  it('defaults an unclassified requirement into the functional section', () => {
    const s = summary([{ id: 'R1', title: 'Legacy', text: 'no kind set', pathTypes: ['happy'] }])
    const { markdown } = renderPrdSummaryMarkdown(s, 'legacy')
    expect(markdown).toContain('## Functional requirements')
    expect(markdown).not.toContain('## Non-functional requirements')
  })

  it('renders variantsNA list in the markdown (lines 606/609)', () => {
    const s = summary([{
      id: 'R1', title: 'Send', text: 'send a message', pathTypes: ['happy'],
      variants: ['email', 'sms'],
      variantsNA: [{ variant: 'sms', reason: 'no endpoint' }],
    }])
    const { markdown } = renderPrdSummaryMarkdown(s, 'notify')
    expect(markdown).toContain('_N/A: sms (no endpoint)_')
  })
})

describe('normalizeRequirementVariantsNA — uncovered branches', () => {
  const DIM = parseVariantDimension('{"variantDimension":{"name":"channel","values":["email","sms","whatsapp","call"]}}')

  it('treats non-string reason as empty string → item dropped (line 115 false branch)', () => {
    // raw.reason is a number → typeof !== 'string' → reason = '' → item skipped
    // Must pass variantDimension so that variants are normalized and normalizeRequirementVariantsNA is called.
    const out = parsePrdSummaryOutput(
      JSON.stringify({ requirements: [{
        title: 'r', text: 't', pathTypes: ['happy'],
        variants: ['email', 'sms'],
        variantsNA: [{ variant: 'sms', reason: 99 }], // reason is a number, not a string
      }] }),
      DIM,
    )
    // item is dropped (reason is not a string) → variantsNA undefined
    expect(out![0].variantsNA).toBeUndefined()
  })

  it('returns undefined when all variantsNA items are dropped (line 121 false branch)', () => {
    // All items have empty reason → all dropped → out.length = 0 → returns undefined
    const out = parsePrdSummaryOutput(
      JSON.stringify({ requirements: [{
        title: 'r', text: 't', pathTypes: ['happy'],
        variants: ['email', 'sms'],
        variantsNA: [{ variant: 'email', reason: '' }], // empty reason → dropped
      }] }),
      DIM,
    )
    expect(out![0].variantsNA).toBeUndefined()
  })

  it('skips non-object items in variantsNA array (line 112 typeof !== object branch)', () => {
    // A STRING item in variantsNA: !item is false (string is truthy) but typeof !== 'object' → continue
    const out = parsePrdSummaryOutput(
      JSON.stringify({ requirements: [{
        title: 'r', text: 't', pathTypes: ['happy'],
        variants: ['email', 'sms'],
        variantsNA: ['not-an-object', { variant: 'sms', reason: 'no endpoint' }],
      }] }),
      DIM,
    )
    expect(out![0].variantsNA).toEqual([{ variant: 'sms', reason: 'no endpoint' }])
  })
})

describe('normalizeVariantValue — non-string and empty-string branches (line 65)', () => {
  const DIM = parseVariantDimension('{"variantDimension":{"name":"channel","values":["email","sms"]}}')

  it('returns undefined (line 65 true branch) when variant is a non-string (e.g. a number)', () => {
    // normalizeVariantValue(42) → typeof 42 !== 'string' → return undefined → item dropped
    const out = parsePrdSummaryOutput(
      JSON.stringify({ requirements: [{
        title: 'r', text: 't', pathTypes: ['happy'],
        variants: ['email', 'sms'],
        variantsNA: [{ variant: 42, reason: 'non-string variant' }], // number, not string
      }] }),
      DIM,
    )
    expect(out![0].variantsNA).toBeUndefined()
  })

  it('returns undefined (line 67 false branch) when variant whitespace-trims to empty', () => {
    // normalizeVariantValue('   ') → v = '' → v ? v : undefined → undefined
    const out = parsePrdSummaryOutput(
      JSON.stringify({ requirements: [{
        title: 'r', text: 't', pathTypes: ['happy'],
        variants: ['email', 'sms'],
        variantsNA: [{ variant: '   ', reason: 'whitespace-only variant name' }],
      }] }),
      DIM,
    )
    expect(out![0].variantsNA).toBeUndefined()
  })
})

describe('parseTopLevelObject — catch branch', () => {
  it('returns null when JSON inside {} braces is syntactically invalid', () => {
    // `{invalid json}` passes the start/end guards but JSON.parse throws → catch → null
    expect(parsePrdSummaryOutput('{invalid json}')).toBeNull()
  })
})

describe('buildPrdSummaryPrompt — previousVariantDimension branches (line 396)', () => {
  it('uses "(none — infer...)" when no previousVariantDimension is passed (false branch)', () => {
    const col = collection([{ relPath: 'spec.md', content: '# Feature\n some text' }])
    const prompt = buildPrdSummaryPrompt(col, [])
    expect(prompt).toContain('(none — infer the dimension from the documents, if any)')
  })

  it('serializes previousVariantDimension as JSON when provided (true branch)', () => {
    const col = collection([{ relPath: 'spec.md', content: '# Feature\n some text' }])
    const dim = { name: 'channel', values: ['email', 'sms'] }
    const prompt = buildPrdSummaryPrompt(col, [], dim)
    expect(prompt).toContain('"name": "channel"')
    expect(prompt).not.toContain('(none — infer the dimension from the documents, if any)')
  })
})

describe('assembleSummary', () => {
  it('stamps the variantDimension onto the summary when one is supplied (dimension truthy branch)', () => {
    const c = collection([{ relPath: 'spec.md', content: '# Send\nsend it' }])
    const dim = { name: 'channel', values: ['email', 'sms'] }
    const out = assembleSummary(
      c,
      null,
      [{ title: 'Send', text: 'send it', pathTypes: ['happy'] }],
      dim,
      '2026-06-26T00:00:00.000Z',
    )
    expect(out.variantDimension).toEqual(dim)
    expect(out.requirements[0].id).toBe('R1')
    expect(out.generatedAt).toBe('2026-06-26T00:00:00.000Z')
  })

  it('omits variantDimension when neither this pass nor the previous summary declared one', () => {
    const c = collection([{ relPath: 'spec.md', content: '# Send\nsend it' }])
    const out = assembleSummary(c, null, [{ title: 'Send', text: 'send it', pathTypes: ['happy'] }], undefined, 'n')
    expect(out.variantDimension).toBeUndefined()
  })
})

describe('writePrdSummary', () => {
  it('writes the JSON sidecar + markdown into docs/, returning requirements with sourceRanges', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-prd-write-'))
    try {
      const s = summary([
        { id: 'R1', title: 'Login', text: 'user can log in', pathTypes: ['happy'] },
      ])
      const written = writePrdSummary(tmpDir, 'auth', s)
      // Returned summary carries sourceRange offsets back to the caller.
      expect(written.requirements[0].sourceRange).toBeDefined()

      const docsDir = path.join(tmpDir, 'docs')
      const json = JSON.parse(fs.readFileSync(path.join(docsDir, PRD_SUMMARY_JSON), 'utf-8')) as PrdSummary
      expect(json.requirements[0].sourceRange).toBeDefined()
      const md = fs.readFileSync(path.join(docsDir, PRD_SUMMARY_MD), 'utf-8')
      expect(md).toContain('# auth — Requirements')
      expect(md).toContain('R1 — Login')

      // Round-trips through readPrdSummary.
      expect(readPrdSummary(tmpDir)?.requirements[0].id).toBe('R1')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('readPrdSummary — missing file', () => {
  it('returns null when the sidecar does not exist (!existsSync branch)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-prd-read-'))
    try {
      expect(readPrdSummary(tmpDir)).toBeNull()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
