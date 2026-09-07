// Integrity hints (D13): the verification-strength differential's reading of
// the live spec edits a run has NOT executed, shaped for a reader — the UI, an
// MCP result, a skill. Advisory by construction: nothing here is consulted by
// `decideRunStatus`, and no hint can adopt, approve, block or withhold. Only
// `weaker` and `cannot-classify` are worth a reader's attention; an edit the
// differential reads as equivalent or stronger is reported as a pending edit
// and nothing more.
import type { PendingSpecEdit } from '../dirty-specs/detect'
import { testRequirementsReader } from '../dirty-specs/test-requirements'
import type { PredicateChange } from '../../../../../../../shared/verification-strength/types'

// The disclosure lives in the root shared tree so the web can show it beside a
// hint that has no run manifest to read it from; re-exported here for the
// server-side callers that already import it from this module.
export { INTEGRITY_HINT_DISCLOSURE } from '../../../../../../../shared/verification-strength/disclosure'
export type { IntegrityHint } from '../../../../../../../shared/verification-strength/hints'
import type { IntegrityHint } from '../../../../../../../shared/verification-strength/hints'

export function deriveIntegrityHints(
  pending: PendingSpecEdit[],
  readLiveSource: (rel: string) => string | undefined,
): IntegrityHint[] {
  const hints: IntegrityHint[] = []
  for (const edit of pending) {
    const strength = edit.strength
    if (!strength) continue
    for (const reason of strength.reasons ?? []) hints.push({ kind: 'cannot-classify', file: edit.file, reason })
    const requirementsOf = testRequirementsReader(edit.file, readLiveSource)
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

function unclassifiableReason(changes: PredicateChange[]): string {
  return changes.find((change) => change.verdict === 'unclassifiable')?.reason ?? 'the differential could not read this change'
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}
