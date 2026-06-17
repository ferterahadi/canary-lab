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
})
