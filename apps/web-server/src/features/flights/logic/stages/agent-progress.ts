import { createCompositionTracker } from '../../../agent-sessions/logic/agent-stream-progress'
import type { StageContext } from '../flight-stages'

// The chunk sink every flight stage that spawns an agent passes as its
// `onChunk`/`onOutput`, in place of a bare `ctx.appendLog`.
//
// Stages already teed raw agent stdout into the stage log, and the log is not a
// live view — nobody reads 291 KB of stream-json envelopes. Meanwhile the panel
// that IS read (AgentSessionView) can only show completed blocks, so the minutes
// an agent spends thinking or composing showed nothing at all. This turns the
// same chunks the log was already getting into a snapshot of what the agent is
// doing, at a cadence the flight view actually polls.
//
// One home rather than five: the same silence exists at every agent-spawning
// stage (docs, scout, prd-summary, and both halves of the specs↔coverage loop),
// and a fix applied to some spawns and not others is exactly how stream-json and
// idle timeouts drifted apart before (see cl_reuse-shared-logic).

/** Republish cadence. The flight detail refetches every 2s while a flight is
 *  active, so anything faster buys a reader nothing and only adds manifest
 *  writes — and the manifest is already written once per chunk by appendLog. */
const PUBLISH_EVERY_MS = 1000

/** Wrap a stage's log append so the agent's live activity rides along.
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
    // The log stays the record of what arrived, unconditionally — progress is a
    // derived convenience and must never cost the stage its raw output.
    ctx.appendLog(chunk)
    const activity = tracker.push(chunk)
    if (!activity) return
    const at = now()
    if (at - lastPublishedAt < PUBLISH_EVERY_MS) return
    lastPublishedAt = at
    ctx.setAgentActivity(activity)
  }
}
