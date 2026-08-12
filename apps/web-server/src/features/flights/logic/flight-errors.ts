import { type FlightManifest } from './types'

// The Flight conductor — a deterministic, server-owned stage machine
// (NOT one giant agent prompt). It advances the stage array sequentially,
// persists the manifest after every transition, pauses on typed checkpoints,
// and computes every stage verdict itself: adapters may spawn agents for
// judgment work, but a stage settles only on the harness-checked outcome the
// adapter returns (boot passed, ledger met target, archive on disk…).
//
// Stage adapters are injected (Phase 3 provides the real ones; tests stub
// them) so the machine's semantics — advance, pause/resume, jump, crash
// recovery, single-flight — are testable in isolation.

/** Stamps a conductor system line with the time it was written, so the UI can
 *  show *when* each `[tag]` step happened instead of an undated wall of text.
 *  The stamp rides inside the tag (`[docs@<iso>] …`) rather than as a separate
 *  column, so the log stays one plain-text stream and an unstamped line from a
 *  pre-stamping flight still parses — the reader just gets no time for it.
 *
 *  Only a chunk that OPENS with a tag is stamped: agent output is mirrored into
 *  the same log untagged and in partial chunks, and stamping mid-stream would
 *  splice timestamps into the agent's prose. */
export function stampSystemLine(chunk: string, iso: string): string {
  return chunk.replace(/^\[([\w-]+)\]/, `[$1@${iso}]`)
}

export class FlightConflictError extends Error {
  readonly statusCode = 409
  constructor(public readonly repoPaths: string[], public readonly existingFlightId: string) {
    super(`a flight is already active for ${repoPaths.join(', ')} (${existingFlightId})`)
    this.name = 'FlightConflictError'
  }
}

/** A feature has at most ONE flight record. Re-invoking `flight` on a feature
 *  that already has one must say what to do with it — continue (resume from
 *  the first open stage), redo (restart from stage 1, discarding the record's
 *  stage evidence), or jump (start at a chosen stage, prerequisites checked).
 *  Thrown when no mode was given so every surface (CLI prompt, REST 409, MCP
 *  next-text) presents the same three-way choice instead of silently creating
 *  a second record. */
export class FlightExistsError extends Error {
  readonly statusCode = 409
  readonly options = ['continue', 'redo', 'jump'] as const
  constructor(
    public readonly feature: string,
    public readonly existingFlightId: string,
    public readonly existingStatus: FlightManifest['status'],
  ) {
    super(
      `feature "${feature}" already has a flight record (${existingFlightId}, ${existingStatus}) — ` +
        `choose continue (resume where it left off), redo (restart from stage 1), or jump (start at a chosen stage)`,
    )
    this.name = 'FlightExistsError'
  }
}

/** A checkpoint answer arrived for a flight that is no longer parked on one —
 *  overwhelmingly because the user STOPPED it while the step was in an external
 *  client's hands.
 *
 *  Typed rather than a bare Error because the answer to it is not "retry": the
 *  agent holding that work has to discard it and stand down, and it cannot be
 *  told so mid-turn (no server→client push exists). Its next tool call is the
 *  only channel, so that call has to carry a machine-readable reason and the
 *  live status — enough for the client to know whether the flight was paused for
 *  it to resume, or aborted for good. */
export class FlightNotParkedError extends Error {
  readonly statusCode = 409
  constructor(
    public readonly flightId: string,
    public readonly status: FlightManifest['status'],
    public readonly pauseReason?: string,
  ) {
    super(`flight ${flightId} is ${status}, not waiting for approval`)
    this.name = 'FlightNotParkedError'
  }
}

/** A `--from-stage` entry whose prerequisites are not satisfied. The message
 *  names the missing prerequisite so the caller can fix it, not guess. */
export class FlightStageEntryError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'FlightStageEntryError'
  }
}

/** A flight's repos + intent are frozen against PARTIAL re-entry (jump /
 *  continue) — the surviving stage artifacts were built from them. Thrown when
 *  a caller passes a DIFFERENT repo set or description on those paths, so the
 *  CLI/REST/MCP all reject the edit with the same escape hatch instead of
 *  silently mutating the record. A full restart (mode `redo`) accepts new
 *  values — every stage's evidence is discarded, so nothing can lie (R75). */
export class FlightFrozenError extends Error {
  readonly statusCode = 409
  constructor(public readonly feature: string, what: 'repos' | 'intent') {
    super(
      `${what === 'repos' ? 'repo list' : 'intent'} is frozen for feature "${feature}" while re-entering mid-pipeline — ` +
        `restart from the beginning (mode "redo") to change it, or delete the flight`,
    )
    this.name = 'FlightFrozenError'
  }
}
