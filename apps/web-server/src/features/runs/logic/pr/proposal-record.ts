import type { RunPrAttempt, RunProposedPr } from '../../../../../../../shared/run-state'
import type { ProposeResult } from './propose-fixes'

export function proposalRecord(
  results: ProposeResult[],
  context: { at: string; auto: boolean },
): { opened: RunProposedPr[]; attempt: RunPrAttempt } {
  return {
    opened: results.flatMap((r) => r.ok && r.pr ? [r.pr] : []),
    attempt: {
      ...context,
      results: results.map((r) => ({
        repoName: r.repoName,
        ok: r.ok,
        ...(r.pr ? { url: r.pr.url } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
      })),
    },
  }
}
