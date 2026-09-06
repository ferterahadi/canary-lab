// Integrity hints (D13): what the verification-strength differential says about
// the live edits a run has NOT executed. Advisory — a hint informs the reader,
// it never changes a status. The detection number that backs `weaker` came from
// one AI labelling and a second AI checking blind, with no human; every place a
// hint is shown carries that disclosure.
import { describe, it, expect } from 'vitest'
import { INTEGRITY_HINT_DISCLOSURE, deriveIntegrityHints } from './run-integrity-hints'
import type { PendingSpecEdit } from '../dirty-specs/detect'

const predicate = (source: string) => ({
  matcher: 'toHaveText', target: 'page.getByTestId("total")', expected: 'literal' as const,
  expectedArity: 1, negated: false, soft: false, poll: false, line: 3, source,
})

const WEAKENED: PendingSpecEdit = {
  file: 'e2e/checkout.spec.ts',
  change: 'modified',
  affectedTests: ['charges the card'],
  strength: {
    baseline: 'run-start',
    verdict: 'weaker',
    tests: [{
      kind: 'changed',
      name: 'charges the card',
      verdict: 'weaker',
      changes: [
        { kind: 'reshaped', verdict: 'weaker', before: predicate("await expect(total).toHaveText('$10')"), after: predicate('await expect(total).toBeVisible()') },
        { kind: 'removed', verdict: 'weaker', before: predicate("await expect(receipt).toHaveText('paid')") },
      ],
    }],
  },
}

const SOURCE = `test('charges the card', { tag: ['@req-checkout-12', '@req-payments-3'] }, async () => {
  await expect(total).toBeVisible()
})
`

describe('deriveIntegrityHints', () => {
  it('turns a weaker test change into one hint carrying the predicate that was and is', () => {
    const hints = deriveIntegrityHints([WEAKENED], () => SOURCE)
    expect(hints).toEqual([{
      kind: 'weaker',
      file: 'e2e/checkout.spec.ts',
      test: 'charges the card',
      requirements: ['checkout-12', 'payments-3'],
      was: ["await expect(total).toHaveText('$10')", "await expect(receipt).toHaveText('paid')"],
      now: ['await expect(total).toBeVisible()'],
    }])
  })

  it('reports a cannot-classify hint per unclassifiable test, and one for a file that does not parse', () => {
    const edits: PendingSpecEdit[] = [
      {
        file: 'e2e/a.spec.ts', change: 'modified', affectedTests: ['x'],
        strength: {
          baseline: 'run-start', verdict: 'unclassifiable',
          tests: [{ kind: 'changed', name: 'x', verdict: 'unclassifiable', changes: [], reason: 'custom matcher toLookRight has no strength rule' }],
        },
      },
      {
        file: 'e2e/b.spec.ts', change: 'modified', affectedTests: ['y'],
        strength: { baseline: 'run-start', verdict: 'unclassifiable', tests: [], reasons: ['after side does not parse: Unexpected token'] },
      },
    ]
    expect(deriveIntegrityHints(edits, () => undefined)).toEqual([
      { kind: 'cannot-classify', file: 'e2e/a.spec.ts', test: 'x', reason: 'custom matcher toLookRight has no strength rule' },
      { kind: 'cannot-classify', file: 'e2e/b.spec.ts', reason: 'after side does not parse: Unexpected token' },
    ])
  })

  it('says nothing about equivalent or stronger edits, or edits with no verdict', () => {
    const edits: PendingSpecEdit[] = [
      { file: 'e2e/a.spec.ts', change: 'modified', affectedTests: ['x'], strength: { baseline: 'run-start', verdict: 'stronger', tests: [{ kind: 'changed', name: 'x', verdict: 'stronger', changes: [] }] } },
      { file: 'e2e/b.spec.ts', change: 'modified', affectedTests: ['y'] },
    ]
    expect(deriveIntegrityHints(edits, () => SOURCE)).toEqual([])
  })

  it('names the deleted test under the name the copy knew it by', () => {
    const edit: PendingSpecEdit = {
      file: 'e2e/a.spec.ts', change: 'deleted', affectedTests: ['gone'],
      strength: {
        baseline: 'run-start', verdict: 'weaker',
        tests: [{ kind: 'deleted', name: 'gone', verdict: 'weaker', changes: [{ kind: 'removed', verdict: 'weaker', before: predicate('await expect(x).toBe(1)') }] }],
      },
    }
    expect(deriveIntegrityHints([edit], () => undefined)).toEqual([
      { kind: 'weaker', file: 'e2e/a.spec.ts', test: 'gone', was: ['await expect(x).toBe(1)'], now: [] },
    ])
  })
})

describe('INTEGRITY_HINT_DISCLOSURE', () => {
  it('names how the detection was checked, in the words the disclosure rule requires', () => {
    expect(INTEGRITY_HINT_DISCLOSURE).toContain('one AI labelled')
    expect(INTEGRITY_HINT_DISCLOSURE).toContain('a second AI checked blind')
    expect(INTEGRITY_HINT_DISCLOSURE).toContain('no human')
  })
})
