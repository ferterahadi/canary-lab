import { describe, it, expect } from 'vitest'
import { prProvenanceFooter, verdictProvenanceOf } from './pr-provenance'
import type { RunManifest } from '../runtime/manifest'

const TAKEN = { kind: 'taken' as const, dir: '/logs/runs/run-9/suite', takenAt: '2026-09-07T01:00:00.000Z', digest: 'abcdef0123456789deadbeef' }

describe('verdictProvenanceOf', () => {
  it('is nothing for a run recorded before the boundary existed — no claim about a snapshot it never took', () => {
    expect(verdictProvenanceOf(null)).toBeUndefined()
    expect(verdictProvenanceOf({} as RunManifest)).toBeUndefined()
    // specEdits without a snapshot cannot happen (recordSpecEdits returns early
    // on the live dir); a stray record still does not fabricate provenance.
    expect(verdictProvenanceOf({ specEdits: { checkedAt: 't', pending: [], adopted: [] } } as RunManifest)).toBeUndefined()
  })

  it('lifts exactly the three provenance fields and nothing else off the manifest', () => {
    const m = { runId: 'run-9', status: 'passed', suiteSnapshot: TAKEN, specEdits: { checkedAt: 't', pending: [], adopted: [] } } as unknown as RunManifest
    expect(verdictProvenanceOf(m)).toEqual({ suiteSnapshot: TAKEN, specEdits: m.specEdits })
    // A snapshot alone (Playwright never exited, so no specEdits yet) is still
    // provenance; the hints ride along when the runner wrote them.
    expect(verdictProvenanceOf({ suiteSnapshot: TAKEN })).toEqual({ suiteSnapshot: TAKEN })
    const integrity = { hints: [], disclosure: 'd' }
    expect(verdictProvenanceOf({ suiteSnapshot: TAKEN, specEdits: m.specEdits, integrity })).toEqual({ suiteSnapshot: TAKEN, specEdits: m.specEdits, integrity })
  })
})

describe('prProvenanceFooter', () => {
  it('is the plain one-liner when the run carries no provenance', () => {
    expect(prProvenanceFooter({ runId: 'run-9', baseSha: 'base1234567890abc' })).toBe(
      '---\nCaptured by Canary Lab from run `run-9`, based on `base12345678`. Review before merging.',
    )
  })

  it('names the run-start snapshot and says no spec moved when nothing is pending or adopted', () => {
    for (const verdict of [
      { suiteSnapshot: TAKEN, specEdits: { checkedAt: 't', pending: [], adopted: [] } },
      // No specEdits record at all (the run never reached a Playwright exit) reads the same.
      { suiteSnapshot: TAKEN },
    ]) {
      const body = prProvenanceFooter({ runId: 'run-9', baseSha: 'base123', verdict })
      expect(body).toContain('**Verdict provenance.** The tests this run passed are the suite as it stood at run start (snapshot `abcdef012345`, taken 2026-09-07T01:00:00.000Z).')
      expect(body).toContain('- No live spec changed since the snapshot was taken.')
      expect(body).not.toContain('Hint')
    }
  })

  it('lists the edits the run did NOT execute, the ones a human adopted, and each hint with the disclosure', () => {
    const body = prProvenanceFooter({
      runId: 'run-9',
      baseSha: 'base123',
      verdict: {
        suiteSnapshot: TAKEN,
        specEdits: {
          checkedAt: 't',
          pending: [
            { file: 'e2e/a.spec.ts', change: 'modified', affectedTests: ['a'] },
            { file: 'e2e/b.spec.ts', change: 'added', affectedTests: ['b'] },
          ],
          adopted: [{ at: '2026-09-07T00:30:00.000Z', by: 'human', files: ['e2e/c.spec.ts'] }],
        },
        integrity: {
          hints: [
            { kind: 'weaker', file: 'e2e/a.spec.ts', test: 'a', requirements: ['checkout-1'], was: ["expect(total).toHaveText('$1')"], now: [] },
            { kind: 'cannot-classify', file: 'e2e/b.spec.ts', reason: 'the live side does not parse' },
          ],
          disclosure: 'one AI labelled, a second AI checked blind, no human.',
        },
      },
    })
    expect(body).toContain('- Not executed — 2 spec edits made after the run started: `e2e/a.spec.ts` (modified), `e2e/b.spec.ts` (added). Adopt or restore them in Canary Lab before reading this fix against the live suite.')
    expect(body).toContain('- Adopted into the run (human, 2026-09-07T00:30:00.000Z): `e2e/c.spec.ts`.')
    expect(body).toContain("- Hint, not a verdict — `e2e/a.spec.ts` › a (@checkout-1) reads weaker than what ran: was `expect(total).toHaveText('$1')`; now nothing.")
    expect(body).toContain('- Cannot classify — `e2e/b.spec.ts`: the live side does not parse.')
    // The rate never travels without the disclosure.
    expect(body).toContain('wrong 2.4% of the time on the holdout. one AI labelled, a second AI checked blind, no human.')
    expect(body).not.toContain('No live spec changed')
  })

  it('reads a single pending edit and a named cannot-classify test grammatically, hints without @requirement tags', () => {
    const body = prProvenanceFooter({
      runId: 'run-9',
      baseSha: 'base123',
      verdict: {
        suiteSnapshot: TAKEN,
        specEdits: { checkedAt: 't', pending: [{ file: 'e2e/a.spec.ts', change: 'deleted', affectedTests: ['a'] }], adopted: [] },
        integrity: {
          hints: [
            { kind: 'weaker', file: 'e2e/a.spec.ts', test: 'a', was: [], now: ['expect(x).toBeVisible()'] },
            { kind: 'cannot-classify', file: 'e2e/a.spec.ts', test: 'odd', reason: 'no readable assertion' },
          ],
          disclosure: 'd.',
        },
      },
    })
    expect(body).toContain('1 spec edit made after the run started: `e2e/a.spec.ts` (deleted). Adopt or restore it in Canary Lab')
    expect(body).toContain('› a reads weaker than what ran: was nothing; now `expect(x).toBeVisible()`.')
    expect(body).toContain('- Cannot classify — `e2e/a.spec.ts` › odd: no readable assertion.')
  })

  it('says out loud when the run had no snapshot — the verdict then came from the live suite', () => {
    const body = prProvenanceFooter({
      runId: 'run-9',
      baseSha: 'base123',
      verdict: { suiteSnapshot: { kind: 'unavailable', at: 't', reason: 'EACCES: permission denied' } },
    })
    expect(body).toContain('**Verdict provenance.** No run-start snapshot could be taken (EACCES: permission denied): the verdict is from the live suite, so a spec edited while the run was live may have changed what ran.')
  })
})
