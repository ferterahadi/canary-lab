// Integrity hints (D13): the verification-strength differential's reading of
// the live spec edits a run has NOT executed, shaped for a reader — the UI, an
// MCP result, a skill. Advisory by construction: nothing here is consulted by
// `decideRunStatus`, and no hint can adopt, approve, block or withhold. Only
// `weaker` and `cannot-classify` are worth a reader's attention; an edit the
// differential reads as equivalent or stronger is reported as a pending edit
// and nothing more.
import { extractTestsFromSource } from '../../../../shared/ast-extractor'
import type { PendingSpecEdit } from '../dirty-specs/detect'
import type { PredicateChange } from '../../../../../../../shared/verification-strength/types'

/** How the detection behind a `weaker` hint was checked. The Phase 1 holdout
 *  was labelled by one AI and checked blind by a second; no human labelled it.
 *  Travels with every surface that shows a hint, so a number is never quoted
 *  without it. */
export const INTEGRITY_HINT_DISCLOSURE =
  'Advisory only — this hint never changes a verdict. Its detection was checked by AI: one AI labelled, a second AI checked blind, no human.'

export type IntegrityHint =
  | {
      kind: 'weaker'
      /** Spec path relative to the suite dir. */
      file: string
      /** Test name on the live side; for a deleted test, the name the copy knew. */
      test: string
      /** `@req-*` ids the live test carries. Absent when it carries none or is gone. */
      requirements?: string[]
      /** Assertion source as written, before-side then live-side, for the changes that weakened. */
      was: string[]
      now: string[]
    }
  | {
      kind: 'cannot-classify'
      file: string
      /** Absent when the whole file could not be read (a side that does not parse). */
      test?: string
      reason: string
    }

export function deriveIntegrityHints(
  pending: PendingSpecEdit[],
  readLiveSource: (rel: string) => string | undefined,
): IntegrityHint[] {
  const hints: IntegrityHint[] = []
  for (const edit of pending) {
    const strength = edit.strength
    if (!strength) continue
    for (const reason of strength.reasons ?? []) hints.push({ kind: 'cannot-classify', file: edit.file, reason })
    const requirementsOf = requirementsReader(edit.file, readLiveSource)
    for (const test of strength.tests) {
      if (test.verdict === 'weaker') {
        const weakening = test.changes.filter((change) => change.verdict === 'weaker')
        const requirements = requirementsOf(test.name)
        hints.push({
          kind: 'weaker',
          file: edit.file,
          test: test.name,
          ...(requirements ? { requirements } : {}),
          was: weakening.map((change) => change.before?.source).filter(isString),
          now: weakening.map((change) => change.after?.source).filter(isString),
        })
      } else if (test.verdict === 'unclassifiable') {
        hints.push({
          kind: 'cannot-classify',
          file: edit.file,
          test: test.name,
          reason: test.reason ?? unclassifiableReason(test.changes),
        })
      }
    }
  }
  return hints
}

// The live source is read once per file and only when a hint needs it. The
// full extractor (not the metadata one) is what reads `@req-*` tags.
function requirementsReader(rel: string, readLiveSource: (rel: string) => string | undefined): (test: string) => string[] | undefined {
  let byName: Map<string, string[] | undefined> | null = null
  return (test) => {
    if (!byName) {
      const source = readLiveSource(rel)
      byName = new Map(source === undefined ? [] : extractTestsFromSource(rel, source).tests.map((t) => [t.name, t.requirements]))
    }
    return byName.get(test)
  }
}

function unclassifiableReason(changes: PredicateChange[]): string {
  return changes.find((change) => change.verdict === 'unclassifiable')?.reason ?? 'the differential could not read this change'
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}
