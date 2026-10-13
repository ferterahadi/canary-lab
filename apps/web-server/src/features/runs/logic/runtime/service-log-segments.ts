// A service's live log (`svc-<name>.log`) is emptied before every rerun and
// restart — kept services' included — so the Services pane shows one execution
// at a time. Emptying it destroyed the only full copy of what the service
// printed while an earlier execution failed — the evidence a repair was
// diagnosed from. Before each truncation the contents move to an immutable
// per-execution segment instead.
import fs from 'fs'
import path from 'path'
import { type RunContext } from './run-context'
import { latestExecutionIndex } from './run-manifest-writer'
import { errorMessage } from '../../../../../../../shared/lib/error-message'

/** Keep what `safeName`'s live log holds, then empty it. A segment is named for
 *  the last execution that wrote into it (0 = boot output before the first).
 *  A second truncation with no execution in between — a restart followed by
 *  the rerun — appends to the same segment, so neither half is lost. */
export function preserveAndTruncateServiceLog(ctx: RunContext, safeName: string): void {
  const live = ctx.paths.serviceLog(safeName)
  const segment = ctx.paths.serviceLogSegment(safeName, latestExecutionIndex(ctx) ?? 0)
  try {
    // An empty log still gets its segment: a missing one then always means
    // the run predates segments, never that the service printed nothing.
    fs.statSync(live)
    fs.mkdirSync(path.dirname(segment), { recursive: true })
    // copyFile streams in the kernel; only the rare second half is buffered.
    if (fs.existsSync(segment)) fs.appendFileSync(segment, fs.readFileSync(live))
    else fs.copyFileSync(live, segment)
  } catch (err) {
    // A log the service never created has nothing to keep. Anything else is
    // reported, and the truncation still happens: a pane that kept the old
    // execution's output would misdate it as the new one's.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') ctx.runnerLog?.warn(`preserve service log ${safeName} failed: ${errorMessage(err)}`)
  }
  try { fs.writeFileSync(live, '') } catch { /* may not exist yet */ }
}
