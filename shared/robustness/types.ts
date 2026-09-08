// The robustness envelope (D15): what the Robustness Lab stage perturbs, declared
// by the human as plain JSON at features/<suite>/robustness/envelope.json.
//
// Every knob is a whole number and every atom is deterministic — no jitter, no
// randomness — because shrink (D16) bisects these values toward the passing side
// and a repro that only replays sometimes is worth nothing. The file sits inside
// the suite folder so the D9 run-start snapshot copies it and a mid-run edit is
// a spec edit; this type is the one home for its shape, shared by the shim
// (server), the stage pane (web) and the MCP results.

export const ROBUSTNESS_ENVELOPE_FORMAT = 'canary-lab/robustness-envelope@1'

export type RobustnessAtomKind = 'latency' | 'duplicate' | 'restart'

/** Delay every response through every shim by a fixed number of milliseconds. */
export interface LatencyAtom {
  ms: number
}

/** Replay the first request that matches, once, `gapMs` after it — same body,
 *  same headers — and discard the replay's response. A keyed endpoint dedupes;
 *  an unkeyed one double-applies, which is the defect this atom exists to find. */
export interface DuplicateAtom {
  gapMs: number
  /** `"<METHOD> <path-glob>"` — see `request-match.ts` for the grammar. */
  match: string
}

/** On the Nth matching request to `slot`: hold it, SIGTERM the slot's service,
 *  boot it again, wait for health, then forward. In-memory state does not
 *  survive; file-backed state does. One schedule per slot. */
export interface RestartAtom {
  slot: string
  afterNth: number
  match: string
}

export interface RobustnessEnvelope {
  format: typeof ROBUSTNESS_ENVELOPE_FORMAT
  latency?: LatencyAtom
  duplicate?: DuplicateAtom
  restart?: RestartAtom[]
}
