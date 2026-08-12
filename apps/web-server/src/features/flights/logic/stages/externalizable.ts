import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { FlightCheckpointResponse, FlightStageKey } from '../types'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { CHECKPOINT_OPTIONS } from '../types'

// Lets ONE stage adapter serve both executors without a second implementation.
//
// A flight's reading/authoring stages spawn a local claude/codex CLI by default.
// When the flight was started by an MCP client that asked to do that work itself
// (opts.stageProducer === 'external'), the same stage instead parks on an
// `external-work` checkpoint carrying the rendered prompt, and consumes whatever
// the client returns on the checkpoint response.
//
// Why a checkpoint rather than a start/submit MCP tool pair per stage: the pair
// costs a tool in the profile union, a line in the hand-authored smoke mirror and
// prose in three skill channels EACH (see cl_add-mcp-tool), and there is already a
// tool that does exactly this — respond_flight_checkpoint. It is also the safer
// mechanism: a parked checkpoint makes run() RETURN, so nothing polls and no idle
// deadline can starve. Portify's external path polls instead, which is why a real
// external portify over 30 minutes gets abandoned mid-hand-off.
//
// What this deliberately does NOT do is make a stage runnable standalone outside a
// flight. The five existing start/submit_external_* jobs are standalone on purpose
// and are unaffected.

export interface ExternalizableSpec {
  /** Build the hand-off. `prompt` is what the client executes — normally the exact
   *  string the internal spawn would have received, so the two executors are
   *  working from identical instructions. `context` carries any machine-readable
   *  payload the client needs alongside it (paths to read, ids to preserve). */
  handOff(ctx: StageContext): { prompt: string; context?: unknown }
  /** Consume the client's answer (`response.data`) and settle the stage. Receives
   *  `unknown` because it crosses the MCP boundary — validate before trusting it,
   *  exactly as the internal path validates its agent's JSON. */
  consume(ctx: StageContext, result: unknown): Promise<StageOutcome>
  /** Shown on the checkpoint. Defaults to a generic hand-off line. */
  message?: string
}

/** The two answers an `external-work` checkpoint accepts. `submit` means the
 *  client did the work and put its result on `data`; `run-internally` hands the
 *  job back to Canary's own agent, so a client that cannot do it (no file tools,
 *  no subagents, refused permission) degrades instead of failing the flight.
 *
 *  Re-exported from the shared vocabulary rather than re-declared: this constant
 *  was the precedent every other stage now follows, and two copies of the same
 *  option list is the drift it was introduced to prevent. */
export const EXTERNAL_WORK_OPTIONS = CHECKPOINT_OPTIONS['external-work']

/** True when this flight's hand-off-capable stages should be executed by the MCP
 *  client that started it rather than by a locally spawned CLI. */
export function handsOffToClient(ctx: StageContext): boolean {
  return ctx.manifest().opts.stageProducer === 'external'
}

/** Is the given stage currently parked on ITS OWN external-work hand-off? Stages
 *  own other checkpoint kinds too (docs parks on `prd-source`, scout has a legacy
 *  `config-approval`), so a responder must ask this before claiming a response. */
export function parkedOnExternalWork(ctx: StageContext, stageKey: FlightStageKey): boolean {
  return ctx.manifest().stages.find((s) => s.key === stageKey)?.checkpoint?.kind === 'external-work'
}

/** Build the hand-off outcome. Exported as a primitive because not every stage
 *  hands off at `run()`: docs parks on the human `prd-source` fork FIRST and only
 *  reaches agent work inside its collect path, so it calls this mid-flow rather
 *  than being wrapped. `externalizable()` below is the convenience form for the
 *  run()-shaped stages. */
export function externalWorkCheckpoint(
  ctx: StageContext,
  stageKey: FlightStageKey,
  prompt: string,
  opts: { message?: string; context?: unknown } = {},
): StageOutcome {
  // Also spill the prompt to disk. The MCP flight view drops any checkpoint
  // `data` over its inline budget (~8 KB) — and for this kind the data IS the
  // task, so a large prompt (specs-coverage inlines the requirements + gaps)
  // would otherwise reach the client as "omitted, review it in the web UI",
  // which is not something a work hand-off can act on. With the file written,
  // the oversized case degrades to a path the client can Read — the
  // inline-vs-path rule the MCP tools already follow.
  const dir = path.join(ctx.flightDir, stageKey)
  let promptPath: string | undefined
  try {
    fs.mkdirSync(dir, { recursive: true })
    promptPath = path.join(dir, 'external-task.md')
    fs.writeFileSync(promptPath, prompt, 'utf8')
  } catch {
    // A sidecar we cannot write must not sink the hand-off: the inline prompt is
    // still on the checkpoint, and only the oversized path loses its fallback.
    promptPath = undefined
  }
  return {
    kind: 'checkpoint',
    checkpoint: {
      kind: 'external-work',
      message: opts.message ?? `Run this ${stageKey} step in your own client, then respond with the result on \`data\`.`,
      options: [...EXTERNAL_WORK_OPTIONS],
      data: {
        stage: stageKey,
        prompt,
        // Identifies THIS hand-off, so a submit can be matched to the ask it
        // answers — see rejectStaleSubmit for the race that closes. A re-park
        // reuses the checkpoint wholesale and so keeps its id; only a genuinely
        // new ask mints one.
        handOffId: crypto.randomBytes(4).toString('hex'),
        ...(promptPath ? { promptPath } : {}),
        ...(opts.context === undefined ? {} : { context: opts.context }),
      },
    },
  }
}

/** Refuse a `submit` that answers a hand-off this stage has already moved past,
 *  and re-park the CURRENT ask so whoever holds it now can still answer.
 *  Returns null when the submit is legitimate (or is not a submit at all).
 *
 *  The race this closes is not the obvious one. A pause CLEARS the checkpoint, so
 *  a submit arriving while the flight is parked is already refused by the status
 *  guard. But a RESUME re-parks a fresh hand-off and the flight is
 *  waiting-for-approval again — from then on the previous client's late submit was
 *  accepted, and because Canary validates files-on-disk, stale-but-valid work
 *  could settle the stage against an ask the user had since changed.
 *
 *  Shared rather than inlined: three stages park this kind (scout via the wrapper,
 *  docs and specs-coverage from their own responders), and a gate that only two of
 *  them applied would be the same partial fix this whole change exists to stop. */
export function rejectStaleSubmit(
  ctx: StageContext,
  stageKey: FlightStageKey,
  response: FlightCheckpointResponse,
): StageOutcome | null {
  if (response.choice !== 'submit') return null
  const checkpoint = ctx.manifest().stages.find((s) => s.key === stageKey)?.checkpoint
  const data = checkpoint?.data as { handOffId?: unknown } | undefined
  const parkedId = typeof data?.handOffId === 'string' ? data.handOffId : undefined
  // No id to match means the hand-off predates this gate — an in-flight one must
  // stay answerable across the upgrade rather than becoming unanswerable.
  if (parkedId === undefined || response.token === parkedId) return null
  ctx.appendLog(`[${stageKey}] discarded a submit answering a superseded hand-off\n`)
  // Re-park the SAME checkpoint: it is already the right ask, its `handOffId` is
  // the one the current holder was given (rotating it would invalidate them), and
  // re-deriving the prompt could produce a different one. `lastRejection` is what
  // the agent-facing surfaces read to lead with "discard, do not resubmit" — set
  // on the data rather than spliced into the message so a second stale submit
  // does not stack a second prefix.
  // Both non-null by here: a `parkedId` only exists because `checkpoint.data`
  // carried a string `handOffId`.
  return {
    kind: 'checkpoint',
    checkpoint: { ...checkpoint!, data: { ...data!, lastRejection: 'stale_submission' } },
  }
}

export function externalizable(
  stageKey: FlightStageKey,
  inner: StageAdapter,
  spec: ExternalizableSpec,
): StageAdapter {
  return {
    async run(ctx) {
      if (!handsOffToClient(ctx)) return inner.run(ctx)
      const { prompt, context } = spec.handOff(ctx)
      ctx.appendLog(`[${stageKey}] handed off to the external client\n`)
      return externalWorkCheckpoint(ctx, stageKey, prompt, {
        ...(spec.message === undefined ? {} : { message: spec.message }),
        ...(context === undefined ? {} : { context }),
      })
    },

    async onCheckpointResponse(ctx, response) {
      // Only claim the response when the parked checkpoint is OURS. Stages wrapped
      // here may own other checkpoints too — scout still carries a legacy
      // config-approval responder — and swallowing those would silently break them.
      if (!parkedOnExternalWork(ctx, stageKey)) {
        if (inner.onCheckpointResponse) return inner.onCheckpointResponse(ctx, response)
        // Documented StageAdapter default when a stage has no responder.
        return inner.run(ctx)
      }
      // Handing the step BACK is always legitimate, whoever asks and whenever —
      // a client that cannot do the work must be able to say so even if its
      // hand-off has been superseded. Only a `submit` carries a result that could
      // settle the stage, so only a submit is gated.
      if (response.choice === 'run-internally') {
        ctx.appendLog(`[${stageKey}] client handed the step back — running it here\n`)
        return inner.run(ctx)
      }
      const stale = rejectStaleSubmit(ctx, stageKey, response)
      if (stale) return stale
      return spec.consume(ctx, response.data)
    },

    // R78's restart wipe and the pause teardown must behave identically whoever
    // executed the stage — the artifacts on disk are the same either way. The
    // teardown forward is UNCONDITIONAL now that it is a required method, so a
    // wrapper that forgot it is a compile error rather than a stage that silently
    // stops stopping the moment it is wrapped.
    teardown: (ctx) => inner.teardown(ctx),
    ...(inner.reset ? { reset: inner.reset.bind(inner) } : {}),
  }
}
