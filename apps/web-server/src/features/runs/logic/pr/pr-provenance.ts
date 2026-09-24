import type { RunIntegrity, RunManifest, RunSpecEdits, RunSuiteSnapshot } from '../runtime/manifest'
import { INTEGRITY_HINT_FALSE_POSITIVE_RATE } from '../../../../../../../shared/verification-strength/disclosure'
import { plural } from '../../../../../../../shared/lib/plural'

// The pull request's provenance footer. A reviewer reading "the tests passed"
// on a PR has one question Canary can answer and the agent cannot be trusted
// to: WHICH tests. A run executes the suite as it stood at run start (D9), so
// the footer says so, lists the live edits the run did not execute and the
// ones a human adopted, and repeats the advisory hints with their disclosure —
// the same facts the run detail shows, written where the merge decision is
// made. Deterministic and appended by us: the agent's prose never gets to
// describe its own boundary.

/** The three manifest fields the footer reads — the run-start copy, the edits
 *  measured against it, and the differential's hints on those edits. The
 *  snapshot is required: a record with no snapshot is no provenance at all
 *  (`verdictProvenanceOf` returns nothing instead), so the footer never has to
 *  invent a reason for a boundary that was never recorded. */
export interface VerdictProvenance {
  suiteSnapshot: RunSuiteSnapshot
  specEdits?: RunSpecEdits
  integrity?: RunIntegrity
}

/** Lift the provenance fields off a manifest, or nothing when the run predates
 *  the boundary — an older run then gets the plain footer rather than a claim
 *  about a snapshot it never took. */
export function verdictProvenanceOf(manifest: Pick<RunManifest, 'suiteSnapshot' | 'specEdits' | 'integrity'> | null | undefined): VerdictProvenance | undefined {
  if (!manifest?.suiteSnapshot) return undefined
  return {
    suiteSnapshot: manifest.suiteSnapshot,
    ...(manifest.specEdits ? { specEdits: manifest.specEdits } : {}),
    ...(manifest.integrity ? { integrity: manifest.integrity } : {}),
  }
}

export function prProvenanceFooter(a: { runId: string; baseSha: string; verdict?: VerdictProvenance }): string {
  const lines = [
    '---',
    `Captured by Canary Lab from run \`${a.runId}\`, based on \`${a.baseSha.slice(0, 12)}\`. Review before merging.`,
  ]
  if (a.verdict) lines.push('', ...verdictLines(a.verdict.suiteSnapshot, a.verdict.specEdits, a.verdict.integrity))
  return lines.join('\n')
}

function verdictLines(snapshot: RunSuiteSnapshot, specEdits: RunSpecEdits | undefined, integrity: RunIntegrity | undefined): string[] {
  if (snapshot.kind !== 'taken') {
    return [`**What this run tested.** Canary Lab could not record the tests when the run started (${snapshot.reason}), so a test-file change during the run may have changed what was tested.`]
  }
  const out = [`**What this run tested.** The tests that passed were recorded when the run started (copy \`${snapshot.digest.slice(0, 12)}\`, recorded ${snapshot.takenAt}).`]
  const pending = specEdits?.pending ?? []
  const adopted = specEdits?.adopted ?? []
  if (pending.length > 0) {
    const files = pending.map((e) => `\`${e.file}\` (${e.change})`).join(', ')
    out.push(`- Not run — ${plural(pending.length, 'test-file change')} made after the run started: ${files}. Adopt or restore ${pending.length === 1 ? 'it' : 'them'} in Canary Lab before reading this fix against the current tests.`)
  }
  for (const record of adopted) {
    out.push(`- Adopted into the run (${record.by}, ${record.at}): ${record.files.map((f) => `\`${f}\``).join(', ')}.`)
  }
  if (pending.length === 0 && adopted.length === 0) out.push('- No test files changed after the tests were recorded.')
  for (const hint of integrity?.hints ?? []) {
    if (hint.kind === 'weaker') {
      const was = hint.was.length > 0 ? hint.was.map((s) => `\`${s}\``).join(', ') : 'nothing'
      const now = hint.now.length > 0 ? hint.now.map((s) => `\`${s}\``).join(', ') : 'nothing'
      const reqs = hint.requirements?.length ? ` (${hint.requirements.map((r) => `@${r}`).join(' ')})` : ''
      out.push(`- Hint, not a verdict — \`${hint.file}\` › ${hint.test}${reqs} may be weaker than the test that ran: was ${was}; now ${now}.`)
    } else {
      out.push(`- Cannot classify — \`${hint.file}\`${hint.test ? ` › ${hint.test}` : ''}: ${hint.reason}.`)
    }
  }
  if (integrity?.hints.length) {
    out.push(`  Hints are advisory and do not change the run result. In a fixed sample of public-repository changes, this check incorrectly flagged a weakening ${INTEGRITY_HINT_FALSE_POSITIVE_RATE} of the time. ${integrity.disclosure}`)
  }
  return out
}
