import { describe, expect, it } from 'vitest'
import type { DocEntry } from './docs-collection'
import { locateRequirementSource } from './requirement-source'

// Provenance (D11): every requirement names the source doc and section it came
// from, so the ledger can show WHERE a wording lives and a wording change can be
// traced to a doc edit. Canary locates it deterministically from the docs the
// summary was built from; an agent's hint is validated, never trusted.

const CHECKOUT = [
  '# Checkout',
  '',
  '## Totals',
  'The cart total must equal the sum of line prices plus tax.',
  '',
  '## Payment callbacks',
  'A successful payment produces exactly one order, even when the callback is repeated.',
  '',
].join('\n')

const RETURNS = [
  '# Returns',
  '',
  '## Refund window',
  'A customer can request a refund within 30 days of delivery.',
  '',
].join('\n')

const docs: DocEntry[] = [
  { relPath: 'checkout.md', content: CHECKOUT },
  { relPath: 'returns.md', content: RETURNS },
]

describe('locateRequirementSource', () => {
  it('finds the doc, the nearest heading above the best-matching line, and its 1-based line', () => {
    const source = locateRequirementSource(
      { title: 'One order per payment', text: 'A successful payment produces exactly one order when the callback is repeated.' },
      docs,
    )
    expect(source).toEqual({ doc: 'checkout.md', heading: 'Payment callbacks', line: 7 })
  })

  it('picks the doc with the strongest overlap when several docs exist', () => {
    const source = locateRequirementSource(
      { title: 'Refund window', text: 'Customers can request a refund within 30 days of delivery.' },
      docs,
    )
    expect(source?.doc).toBe('returns.md')
    expect(source?.heading).toBe('Refund window')
  })

  it('restricts the search to the hinted doc when the hint names a real source doc', () => {
    // The refund wording overlaps returns.md far more, but the agent says it read
    // it in checkout.md — the doc hint is honoured because it exists in the collection.
    const source = locateRequirementSource(
      { title: 'Refund window', text: 'Customers can request a refund within 30 days of delivery.' },
      docs,
      { doc: 'checkout.md' },
    )
    // Nothing in checkout.md overlaps, so the line is unknown — the doc alone is kept.
    expect(source).toEqual({ doc: 'checkout.md' })
  })

  it('ignores a doc hint that names no source doc in the collection', () => {
    const source = locateRequirementSource(
      { title: 'Refund window', text: 'Customers can request a refund within 30 days of delivery.' },
      docs,
      { doc: '../../etc/passwd' },
    )
    expect(source?.doc).toBe('returns.md')
  })

  it('honours a heading hint that matches a heading in the located doc', () => {
    const source = locateRequirementSource(
      { title: 'Totals', text: 'unrelated wording that matches nothing' },
      docs,
      { doc: 'checkout.md', heading: 'payment callbacks' },
    )
    expect(source).toEqual({ doc: 'checkout.md', heading: 'Payment callbacks', line: 6 })
  })

  it('a heading hint that matches no heading in the doc falls back to the overlap match', () => {
    const source = locateRequirementSource(
      { title: 'Refund window', text: 'Customers can request a refund within 30 days of delivery.' },
      docs,
      { doc: 'returns.md', heading: 'Chargebacks' },
    )
    expect(source).toEqual({ doc: 'returns.md', heading: 'Refund window', line: 4 })
  })

  it('a blank heading hint is no hint — the overlap match stands', () => {
    const source = locateRequirementSource(
      { title: 'Refund window', text: 'Customers can request a refund within 30 days of delivery.' },
      docs,
      { doc: 'returns.md', heading: '   ' },
    )
    expect(source).toEqual({ doc: 'returns.md', heading: 'Refund window', line: 4 })
  })

  it('keeps the strongest line and the strongest doc when weaker overlaps follow them', () => {
    const many: DocEntry[] = [
      { relPath: 'a.md', content: '## Strong\nrefund window delivery days customer\nrefund mentioned once more\n' },
      { relPath: 'b.md', content: '## Weak\na refund is mentioned here\n' },
    ]
    const source = locateRequirementSource(
      { title: 'Refund window', text: 'A customer can request a refund within 30 days of delivery.' },
      many,
    )
    expect(source).toEqual({ doc: 'a.md', heading: 'Strong', line: 2 })
  })

  it('returns undefined with no docs, and undefined when nothing overlaps', () => {
    expect(locateRequirementSource({ title: 'x', text: 'y' }, [])).toBeUndefined()
    expect(locateRequirementSource({ title: 'zzz', text: 'qqq www' }, docs)).toBeUndefined()
  })

  it('omits the heading for a doc that has none above the match', () => {
    const plain: DocEntry[] = [{ relPath: 'notes.txt', content: 'first line\nthe refund window is thirty days\n' }]
    expect(locateRequirementSource({ title: 'Refund window', text: 'refund within thirty days' }, plain))
      .toEqual({ doc: 'notes.txt', line: 2 })
  })
})
