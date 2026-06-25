import { describe, it, expect } from 'vitest'
import { computeDocsHash, type DocsCollection } from '../docs-collection'
import type { Requirement } from '../../../../../../../shared/coverage/types'
import { fakeRequirementsFromDocs, fakeMappingsFor } from './fake-coverage-agents'

// These cover the test-only heuristics (heading extraction + token overlap) that
// back fakeSummarize / fakePropose. They are NOT production behaviour — production
// coverage generation is LLM-only — but the fixtures must stay correct so the
// many subsystem tests that inject them keep asserting against stable output.

function collection(entries: { relPath: string; content: string }[]): DocsCollection {
  return { docsDir: '/tmp/docs', entries, docsHash: computeDocsHash(entries) }
}

describe('fakeRequirementsFromDocs (heading extraction)', () => {
  it('extracts one requirement per heading and preserves ids across regen', () => {
    const before = collection([
      { relPath: 'spec.md', content: '# Login\nuser logs in\n# Logout\nuser logs out' },
    ])
    const first = fakeRequirementsFromDocs(before, [])
    expect(first.map((r) => r.id)).toEqual(['R1', 'R2'])
    expect(first.map((r) => r.title)).toEqual(['Login', 'Logout'])

    const after = collection([
      { relPath: 'spec.md', content: '# Login\nuser logs in\n# Logout\nuser logs out\n# Reset\nreset pw' },
    ])
    const second = fakeRequirementsFromDocs(after, first)
    expect(second.find((r) => r.title === 'Login')?.id).toBe('R1')
    expect(second.find((r) => r.title === 'Logout')?.id).toBe('R2')
    expect(second.find((r) => r.title === 'Reset')?.id).toBe('R3')
  })

  it('falls back to one requirement per doc when there are no headings', () => {
    const c = collection([{ relPath: 'notes.md', content: 'just a flat note' }])
    const reqs = fakeRequirementsFromDocs(c, [])
    expect(reqs).toHaveLength(1)
    expect(reqs[0].title).toBe('notes')
    expect(reqs[0].text).toBe('just a flat note')
  })

  it('uses relPath as text when doc has no headings and no non-empty first line', () => {
    const c = collection([{ relPath: 'empty.md', content: '   \n   ' }])
    expect(fakeRequirementsFromDocs(c, [])[0].text).toBe('empty.md')
  })

  it('uses title as body fallback when heading body is empty', () => {
    const c = collection([{ relPath: 'spec.md', content: '# Just a heading\n' }])
    const reqs = fakeRequirementsFromDocs(c, [])
    expect(reqs[0].title).toBe('Just a heading')
    expect(reqs[0].text).toBe('Just a heading')
  })
})

const REQS: Requirement[] = [
  { id: 'R1', title: 'Create todo', text: 'A user can create a todo item', pathTypes: ['happy'] },
  { id: 'R2', title: 'Delete todo', text: 'A user can delete a todo item', pathTypes: ['happy'] },
  { id: 'R9', title: 'Old removed', text: 'gone', pathTypes: ['happy'], deprecated: true },
]

describe('fakeMappingsFor (token overlap)', () => {
  it('maps a test to the requirement with the strongest token overlap', () => {
    const out = fakeMappingsFor(REQS, [
      { name: 'delete removes the todo item' },
      { name: 'create makes a new todo' },
    ])
    const byTest = Object.fromEntries(out.map((m) => [m.testName, m.requirements[0]]))
    expect(byTest['delete removes the todo item']).toBe('R2')
    expect(byTest['create makes a new todo']).toBe('R1')
    expect(out.every((m) => m.source === 'deterministic')).toBe(true)
  })

  it('returns [] when the test has no tokens (empty-set guard)', () => {
    expect(fakeMappingsFor(REQS, [{ name: '' }])).toEqual([])
  })

  it('does not map a test below the overlap threshold', () => {
    expect(fakeMappingsFor(REQS, [{ name: 'completely unrelated xyzzy plugh' }])).toEqual([])
  })

  it('never maps to a deprecated requirement', () => {
    const out = fakeMappingsFor(REQS, [{ name: 'old removed gone thing' }])
    expect(out.every((m) => m.requirements[0] !== 'R9')).toBe(true)
  })

  it('does not map when best score exists but is below a raised threshold', () => {
    expect(fakeMappingsFor(REQS, [{ name: 'delete foobar bazqux' }], 0.99)).toEqual([])
  })
})
