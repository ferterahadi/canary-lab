import { describe, expect, it } from 'vitest'
import { computeDocsHash, type DocsCollection } from './docs-collection'
import { assembleSummary, parsePrdSummaryOutput } from './prd-summary'
import type { Requirement } from '../../../../../../../shared/coverage/types'

// D11 prerequisites on the requirement itself: provenance (where the wording came
// from) and the wording-change stamp a regenerate carries forward. Both are set at
// assembly — the single home for turning parsed requirements into a stored summary.

function collection(entries: { relPath: string; content: string }[]): DocsCollection {
  return { docsDir: '/tmp/docs', entries, docsHash: computeDocsHash(entries) }
}

const SPEC = '# Checkout\n\n## Payment callbacks\nA successful payment produces exactly one order.\n'

describe('parsePrdSummaryOutput — source hint', () => {
  it('carries a well-formed source hint through and drops a malformed one', () => {
    const out = parsePrdSummaryOutput(JSON.stringify({
      requirements: [
        { title: 'A', text: 'a', pathTypes: ['happy'], source: { doc: 'checkout.md', heading: 'Payment callbacks' } },
        { title: 'B', text: 'b', pathTypes: ['happy'], source: { doc: 42 } },
        { title: 'C', text: 'c', pathTypes: ['happy'], source: 'checkout.md' },
        { title: 'D', text: 'd', pathTypes: ['happy'], source: { heading: 'Totals' } },
        { title: 'E', text: 'e', pathTypes: ['happy'], source: { doc: ' checkout.md ' } },
      ],
    }))!
    expect(out[0].source).toEqual({ doc: 'checkout.md', heading: 'Payment callbacks' })
    expect(out[1].source).toBeUndefined()
    expect(out[2].source).toBeUndefined()
    // A heading without a doc names no place a reader could open.
    expect(out[3].source).toBeUndefined()
    expect(out[4].source).toEqual({ doc: 'checkout.md' })
  })
})

describe('assembleSummary — provenance', () => {
  it('locates every active requirement in the source docs', () => {
    const out = assembleSummary(
      collection([{ relPath: 'checkout.md', content: SPEC }]),
      null,
      [{ title: 'One order per payment', text: 'A successful payment produces exactly one order.', pathTypes: ['happy'] }],
      undefined,
      '2026-09-07T00:00:00.000Z',
    )
    expect(out.requirements[0].source).toEqual({ doc: 'checkout.md', heading: 'Payment callbacks', line: 4 })
  })

  it('a deprecated carry-over keeps the source it was located with', () => {
    const previous: Requirement = {
      id: 'R1', title: 'Old', text: 'old wording', pathTypes: ['happy'],
      source: { doc: 'old.md', heading: 'Gone', line: 3 },
    }
    const out = assembleSummary(
      collection([{ relPath: 'checkout.md', content: SPEC }]),
      { requirements: [previous], docsHash: 'h', sourceDocs: ['old.md'], generatedAt: '2026-01-01T00:00:00.000Z' },
      [{ title: 'One order per payment', text: 'A successful payment produces exactly one order.', pathTypes: ['happy'] }],
      undefined,
      '2026-09-07T00:00:00.000Z',
    )
    const gone = out.requirements.find((r) => r.id === 'R1')!
    expect(gone.deprecated).toBe(true)
    expect(gone.source).toEqual({ doc: 'old.md', heading: 'Gone', line: 3 })
  })
})

describe('assembleSummary — wordingChangedAt', () => {
  const now1 = '2026-09-01T00:00:00.000Z'
  const now2 = '2026-09-07T00:00:00.000Z'
  const docs = collection([{ relPath: 'checkout.md', content: SPEC }])

  it('stamps a new requirement with the generation time', () => {
    const out = assembleSummary(docs, null, [{ title: 'A', text: 'a', pathTypes: ['happy'] }], undefined, now1)
    expect(out.requirements[0].wordingChangedAt).toBe(now1)
  })

  it('keeps the stamp when a survivor\'s meaning is unchanged, and moves it when the text changed', () => {
    const first = assembleSummary(docs, null, [
      { title: 'A', text: 'a', pathTypes: ['happy'] },
      { title: 'B', text: 'b', pathTypes: ['happy'] },
    ], undefined, now1)
    const second = assembleSummary(docs, first, [
      { id: 'R1', title: 'A', text: 'a', pathTypes: ['happy'] },
      { id: 'R2', title: 'B', text: 'b — now stricter', pathTypes: ['happy'] },
    ], undefined, now2)
    expect(second.requirements.find((r) => r.id === 'R1')!.wordingChangedAt).toBe(now1)
    expect(second.requirements.find((r) => r.id === 'R2')!.wordingChangedAt).toBe(now2)
  })

  it('a survivor from a summary written before the stamp existed gets no invented date', () => {
    const legacy: Requirement = { id: 'R1', title: 'A', text: 'a', pathTypes: ['happy'] }
    const out = assembleSummary(
      docs,
      { requirements: [legacy], docsHash: 'h', sourceDocs: [], generatedAt: now1 },
      [{ id: 'R1', title: 'A', text: 'a', pathTypes: ['happy'] }],
      undefined,
      now2,
    )
    // Same meaning, no prior stamp: the honest answer is "unknown", so the
    // reader falls back to the summary's generatedAt rather than a fabricated now.
    expect(out.requirements[0].wordingChangedAt).toBeUndefined()
  })
})

describe('assembleSummary — legacy acceptance metadata', () => {
  it('keeps the requirement id and tracks wording changes without carrying retired acceptance fields', () => {
    const docs = collection([{ relPath: 'checkout.md', content: SPEC }])
    const first = assembleSummary(docs, null, [{ title: 'A', text: 'a', pathTypes: ['happy'] }], undefined, '2026-09-01T00:00:00.000Z')
    const accepted = {
      ...first,
      requirements: first.requirements.map((r) => ({ ...r, acceptedAt: '2026-09-02T00:00:00.000Z', acceptedFingerprint: r.fingerprint })),
    }
    const second = assembleSummary(docs, accepted, [{ id: 'R1', title: 'A', text: 'a — reworded', pathTypes: ['happy'] }], undefined, '2026-09-07T00:00:00.000Z')
    const r = second.requirements[0]
    expect(r.id).toBe('R1')
    expect(r).not.toHaveProperty('acceptedAt')
    expect(r).not.toHaveProperty('acceptedFingerprint')
    expect(r.fingerprint).not.toBe(first.requirements[0].fingerprint)
    expect(r.wordingChangedAt).toBe('2026-09-07T00:00:00.000Z')
  })
})
