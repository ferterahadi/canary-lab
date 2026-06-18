import { describe, it, expect } from 'vitest'
import {
  parseAnnotateOutput,
  deterministicMappings,
  proposeCoverageMappings,
  buildAnnotatePrompt,
} from './annotate-engine'
import type { Requirement } from '../../../../shared/coverage/types'

const REQS: Requirement[] = [
  { id: 'R1', title: 'Create todo', text: 'A user can create a todo item', pathTypes: ['happy'] },
  { id: 'R2', title: 'Delete todo', text: 'A user can delete a todo item', pathTypes: ['happy'] },
  { id: 'R9', title: 'Old removed', text: 'gone', pathTypes: ['happy'], deprecated: true },
]
const KNOWN = new Set(['R1', 'R2'])

describe('parseAnnotateOutput', () => {
  it('parses mappings and keeps only known requirement ids', () => {
    const out = parseAnnotateOutput(
      JSON.stringify({
        mappings: [
          { testName: 'creates', requirements: ['R1'], pathTypes: ['happy'], confidence: 0.9 },
          { testName: 'bogus', requirements: ['R404'] },
        ],
      }),
      KNOWN,
    )
    expect(out).toHaveLength(1)
    expect(out![0]).toMatchObject({ testName: 'creates', requirements: ['R1'], source: 'agent' })
  })

  it('tolerates the agent echoing the @req- tag form', () => {
    const out = parseAnnotateOutput(JSON.stringify({ mappings: [{ testName: 't', requirements: ['@req-R2'] }] }), KNOWN)
    expect(out![0].requirements).toEqual(['R2'])
  })

  it('handles fenced JSON', () => {
    const out = parseAnnotateOutput('```json\n{"mappings":[{"testName":"t","requirements":["R1"]}]}\n```', KNOWN)
    expect(out![0].testName).toBe('t')
  })

  it('returns [] for a valid-but-empty mapping set', () => {
    expect(parseAnnotateOutput(JSON.stringify({ mappings: [] }), KNOWN)).toEqual([])
  })

  it('returns null on garbage', () => {
    expect(parseAnnotateOutput('not json at all', KNOWN)).toBeNull()
  })

  it('returns null when mappings is not an array (line 114 branch)', () => {
    // `{ mappings: "string" }` → Array.isArray("string") is false → return null
    expect(parseAnnotateOutput(JSON.stringify({ mappings: 'not an array' }), KNOWN)).toBeNull()
  })

  it('skips null/primitive items in the mappings array (line 117 branch)', () => {
    // A null element in mappings → `!raw || typeof raw !== 'object'` TRUE → continue (skip)
    const out = parseAnnotateOutput(
      JSON.stringify({ mappings: [null, { testName: 't', requirements: ['R1'] }] }),
      KNOWN,
    )
    expect(out).toHaveLength(1)
    expect(out![0].testName).toBe('t')
  })

  it('skips a mapping with a non-string testName (line 119 false branch → empty string → line 120 continue)', () => {
    // testName is a number → ternary FALSE → '' → !testName is true → continue (skip)
    const out = parseAnnotateOutput(
      JSON.stringify({ mappings: [{ testName: 42, requirements: ['R1'] }] }),
      KNOWN,
    )
    expect(out).toEqual([])
  })

  it('sets rationale to undefined when it is an empty string (line 127 ||undefined branch)', () => {
    // rationale is a string but trim() yields '' → `r.rationale.trim() || undefined` → undefined
    const out = parseAnnotateOutput(
      JSON.stringify({ mappings: [{ testName: 't', requirements: ['R1'], rationale: '   ' }] }),
      KNOWN,
    )
    expect(out![0].rationale).toBeUndefined()
  })

  it('sets rationale to undefined when it is not a string (line 127 ternary false branch)', () => {
    // rationale is a number → typeof !== 'string' → ternary FALSE → undefined
    const out = parseAnnotateOutput(
      JSON.stringify({ mappings: [{ testName: 't', requirements: ['R1'], rationale: 99 }] }),
      KNOWN,
    )
    expect(out![0].rationale).toBeUndefined()
  })
})

describe('normalizePathTypes (via parseAnnotateOutput) — edge cases', () => {
  it('returns undefined when pathTypes is not an array (line 76 branch)', () => {
    // pathTypes: "happy" → !Array.isArray("happy") TRUE → normalizePathTypes returns undefined
    const out = parseAnnotateOutput(
      JSON.stringify({ mappings: [{ testName: 't', requirements: ['R1'], pathTypes: 'happy' }] }),
      KNOWN,
    )
    expect(out![0].pathTypes).toBeUndefined()
  })

  it('returns undefined when pathTypes items are all unknown strings (ordered.length=0 branch)', () => {
    // pathTypes: ['unknown-path'] → none in PATH_TYPES → ordered = [] → return undefined
    const out = parseAnnotateOutput(
      JSON.stringify({ mappings: [{ testName: 't', requirements: ['R1'], pathTypes: ['unknown-path-type'] }] }),
      KNOWN,
    )
    expect(out![0].pathTypes).toBeUndefined()
  })

  it('skips non-string items in pathTypes array (line 79 else branch)', () => {
    // pathTypes: [42] → typeof 42 !== 'string' → item skipped → no valid paths → undefined
    const out = parseAnnotateOutput(
      JSON.stringify({ mappings: [{ testName: 't', requirements: ['R1'], pathTypes: [42] }] }),
      KNOWN,
    )
    expect(out![0].pathTypes).toBeUndefined()
  })
})

describe('normalizeRequirements (via parseAnnotateOutput) — non-string items', () => {
  it('skips non-string entries in requirements array (line 89 else branch)', () => {
    // requirements: [42, 'R1'] → typeof 42 !== 'string' → skipped; 'R1' is valid
    const out = parseAnnotateOutput(
      JSON.stringify({ mappings: [{ testName: 't', requirements: [42, 'R1'] }] }),
      KNOWN,
    )
    expect(out![0].requirements).toEqual(['R1'])
  })
})

describe('overlapScore — empty set guard (line 155 branch)', () => {
  it('returns 0 and skips mapping when test has no tokens (both sets empty)', () => {
    // Test name '' tokenizes to an empty set → overlapScore returns 0 immediately.
    // With score=0, best stays null → deterministicMappings returns [].
    const out = deterministicMappings(REQS, [{ name: '' }])
    expect(out).toEqual([])
  })
})

describe('deterministicMappings', () => {
  it('maps a test to the requirement with the strongest token overlap', () => {
    const out = deterministicMappings(REQS, [
      { name: 'delete removes the todo item' },
      { name: 'create makes a new todo' },
    ])
    const byTest = Object.fromEntries(out.map((m) => [m.testName, m.requirements[0]]))
    expect(byTest['delete removes the todo item']).toBe('R2')
    expect(byTest['create makes a new todo']).toBe('R1')
    expect(out.every((m) => m.source === 'deterministic')).toBe(true)
  })

  it('does not map a test below the overlap threshold', () => {
    const out = deterministicMappings(REQS, [{ name: 'completely unrelated xyzzy plugh' }])
    expect(out).toEqual([])
  })

  it('never maps to a deprecated requirement', () => {
    const out = deterministicMappings(REQS, [{ name: 'old removed gone thing' }])
    expect(out.every((m) => m.requirements[0] !== 'R9')).toBe(true)
  })

  it('does not map when best score exists but is below a raised threshold (line 178 false branch)', () => {
    // overlapScore = shared / min(|a|, |b|). With 3 tokens where only 1 matches,
    // score ≈ 0.33 — above 0 (so best is non-null) but below threshold=0.99.
    // Exercises the `best && best.score >= threshold` FALSE branch.
    const out = deterministicMappings(REQS, [{ name: 'delete foobar bazqux' }], 0.99)
    expect(out).toEqual([])
  })
})

describe('proposeCoverageMappings', () => {
  it('uses the injected agent runner and parses its output', async () => {
    const out = await proposeCoverageMappings(
      { requirements: REQS, tests: [{ name: 'creates a todo' }] },
      {
        resolveAgents: () => ['claude'],
        runAgent: async () => JSON.stringify({ mappings: [{ testName: 'creates a todo', requirements: ['R1'], confidence: 0.8 }] }),
      },
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ testName: 'creates a todo', requirements: ['R1'], source: 'agent' })
  })

  it('falls back to deterministic when the agent output is unparseable', async () => {
    const out = await proposeCoverageMappings(
      { requirements: REQS, tests: [{ name: 'delete removes the todo item' }] },
      { resolveAgents: () => ['claude'], runAgent: async () => 'garbage' },
    )
    expect(out[0].source).toBe('deterministic')
    expect(out[0].requirements).toEqual(['R2'])
  })

  it('falls back to deterministic when no agent is available', async () => {
    const out = await proposeCoverageMappings(
      { requirements: REQS, tests: [{ name: 'create makes a new todo' }], adapter: 'deterministic' },
    )
    expect(out[0].source).toBe('deterministic')
  })

  it('returns [] when there are no tests or no active requirements', async () => {
    expect(await proposeCoverageMappings({ requirements: REQS, tests: [] })).toEqual([])
    expect(await proposeCoverageMappings({ requirements: [], tests: [{ name: 'x' }] })).toEqual([])
  })
})

describe('buildAnnotatePrompt', () => {
  it('injects active requirements and tests, excluding deprecated reqs', () => {
    const prompt = buildAnnotatePrompt(REQS, [{ name: 'creates a todo', bodySource: 'body' }])
    expect(prompt).toContain('"id": "R1"')
    expect(prompt).toContain('"id": "R2"')
    expect(prompt).not.toContain('"id": "R9"')
    expect(prompt).toContain('creates a todo')
  })

  it('returns unknown {{key}} placeholders unchanged (return match branch)', () => {
    // Pass a custom templatePath by writing a temp file with an unknown placeholder.
    // This hits the `return match` else branch in the replace callback.
    const os = require('os') as typeof import('os')
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const tmpFile = path.join(os.tmpdir(), `canary-annotate-tmpl-${Date.now()}.md`)
    try {
      fs.writeFileSync(tmpFile, '{{requirements}} {{unknown}}')
      const prompt = buildAnnotatePrompt(REQS, [], tmpFile)
      expect(prompt).toContain('{{unknown}}')
    } finally {
      fs.rmSync(tmpFile, { force: true })
    }
  })
})

describe('parseAnnotateOutput — invalid JSON catch branch', () => {
  it('returns null when JSON.parse throws (invalid JSON with braces)', () => {
    // `{invalid}` has { and } so start/end checks pass, but JSON.parse throws.
    expect(parseAnnotateOutput('{invalid json}', KNOWN)).toBeNull()
  })
})
