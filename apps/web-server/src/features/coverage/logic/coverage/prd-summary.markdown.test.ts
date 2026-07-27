import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeDocsHash, type DocsCollection } from './docs-collection'
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
