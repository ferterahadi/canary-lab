import { createCompositionTracker } from '../../../agent-sessions/logic/agent-stream-progress'
import type { StageContext } from '../flight-stages'

// The chunk sink every flight stage that spawns an agent passes as its
// `onChunk`/`onOutput`. The CLI's JSONL session is the one transcript and is
// already tailed by AgentSessionView; copying the same chunks into `stage.log`
// made every delta rewrite and broadcast the growing Flight manifest.
//
// The manifest keeps only a compact activity snapshot derived from those
// chunks. Conductor status and evidence still enter it explicitly through
// `ctx.appendLog`, so dropping transcript copies does not drop stage facts.
//
// One home rather than five: the same silence exists at every agent-spawning
// stage (docs, scout, prd-summary, and both halves of the specs↔coverage loop),
// and a fix applied to some spawns and not others is exactly how stream-json and
// idle timeouts drifted apart before (see cl_reuse-shared-logic).

/** Republish cadence. The flight detail refetches every 2s while a flight is
 *  active, so anything faster buys a reader nothing and only adds manifest
 *  writes. */
const PUBLISH_EVERY_MS = 1000

/** Derive compact live activity from a stage's CLI output stream.
 *
 *  `now` is injectable because the throttle is the whole behaviour worth
 *  testing, and a test that waited out real seconds to prove it would be both
 *  slow and flaky. */
export function agentProgressSink(
  ctx: StageContext,
  now: () => number = Date.now,
): (chunk: string) => void {
  const tracker = createCompositionTracker()
  let lastPublishedAt = 0
  return (chunk) => {
    const activity = tracker.push(chunk)
    if (!activity) return
    const at = now()
    if (at - lastPublishedAt < PUBLISH_EVERY_MS) return
    lastPublishedAt = at
    ctx.setAgentActivity(activity)
  }
}
