import fs from 'fs'
import path from 'path'
import type { FlightStageKey } from '../types'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'

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
 *  no subagents, refused permission) degrades instead of failing the flight. */
export const EXTERNAL_WORK_OPTIONS = ['submit', 'run-internally'] as const

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
        ...(promptPath ? { promptPath } : {}),
        ...(opts.context === undefined ? {} : { context: opts.context }),
      },
    },
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
      if (response.choice === 'run-internally') {
        ctx.appendLog(`[${stageKey}] client handed the step back — running it here\n`)
        return inner.run(ctx)
      }
      return spec.consume(ctx, response.data)
    },

    // R78's restart wipe and the pause teardown must behave identically whoever
    // executed the stage — the artifacts on disk are the same either way.
    ...(inner.interrupt ? { interrupt: inner.interrupt.bind(inner) } : {}),
    ...(inner.reset ? { reset: inner.reset.bind(inner) } : {}),
  }
}
