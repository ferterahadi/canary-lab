// How long an `external-work` hand-off can go without the client checking in
// before the read reports it as abandoned.
//
// Why anything at all: a parked hand-off has NO deadline by design — the park
// makes the stage's run() return, so nothing polls and nothing can starve a
// client that is legitimately working (see
// features/flights/logic/stages/externalizable.ts). That is right while a client
// IS working, and wrong the moment one walks away: a client that ends its turn
// mid-pipeline leaves the flight parked forever, reporting an innocent
// "waiting-for-approval" with six stages that will never start. Meanwhile an
// INTERNAL agent that goes quiet for five minutes is killed as stalled
// (FLIGHT_AGENT_IDLE_MS). The asymmetry was the bug: the system had an opinion
// about a silent internal producer and none about a silent external one.
//
// 45 minutes is deliberately generous. The skill already tells a client to
// re-call get_flight roughly every 10 minutes while working — for the unrelated
// reason of catching a superseded handOffId — so a client following the loop
// resets this four times over before it can trip.
export const HANDOFF_IDLE_MS = 45 * 60 * 1000

// The ledger is IN-MEMORY on purpose. It answers "has the client touched this
// hand-off during this server's life?", and a server restart already parks every
// running flight (pauseReason "restart"), so there is no state worth persisting
// across one. Keeping it out of the manifest also keeps a read side-effect-free.
export type HandOffContactLedger = Map<string, number>

export function createHandOffContactLedger(): HandOffContactLedger {
  return new Map()
}

// Keyed by hand-off, not by flight: a re-asked step gets a new handOffId, and its
// clock must start fresh rather than inherit the abandoned attempt's contact.
function key(flightId: string, handOffId: string | undefined): string {
  return `${flightId}#${handOffId ?? '-'}`
}

/** Record that the CLIENT looked at this hand-off. Only the MCP surface calls
 *  this — a human watching the web UI is not the client, and counting their
 *  page reads as contact would keep the clock alive forever on a hand-off nobody
 *  is working. */
export function noteHandOffContact(
  ledger: HandOffContactLedger,
  args: { flightId: string; handOffId?: string; nowMs: number },
): void {
  ledger.set(key(args.flightId, args.handOffId), args.nowMs)
}

/** Milliseconds since the client last touched this hand-off — or since the park
 *  itself when it never has, which is the abandoned-on-arrival case. */
export function handOffIdleMs(
  ledger: HandOffContactLedger,
  args: { flightId: string; handOffId?: string; parkedAtMs: number; nowMs: number },
): number {
  const lastContact = ledger.get(key(args.flightId, args.handOffId)) ?? args.parkedAtMs
  return Math.max(0, args.nowMs - lastContact)
}

export interface HandOffIdleReport {
  stage: string
  idleMinutes: number
  /** True when no client has EVER polled this hand-off — the signature of a
   *  client that took the work and ended its turn without submitting. */
  neverPolled: boolean
}

/** The report to attach to a read, or null while the hand-off is still fresh.
 *  Deliberately a REPORT and not a state change: the checkpoint stays
 *  answerable, so a client that comes back late still submits against the same
 *  handOffId and loses nothing. Pausing the flight here would tell a returning
 *  client to discard its work — the opposite of what a stall should cost. */
export function handOffIdleReportFor(args: {
  stage: string
  idleMs: number
  everPolled: boolean
  thresholdMs?: number
}): HandOffIdleReport | null {
  if (args.idleMs < (args.thresholdMs ?? HANDOFF_IDLE_MS)) return null
  return {
    stage: args.stage,
    idleMinutes: Math.floor(args.idleMs / 60_000),
    neverPolled: !args.everPolled,
  }
}

export function hasPolled(ledger: HandOffContactLedger, flightId: string, handOffId?: string): boolean {
  return ledger.has(key(flightId, handOffId))
}

/** The sentence a read leads with when a hand-off has gone quiet. Addressed to
 *  whoever is reading NOW — usually a fresh session that inherited an abandoned
 *  flight, which is the only observer left once the original client is gone. */
export function handOffIdleAdvice(report: HandOffIdleReport): string {
  const how = report.neverPolled
    ? 'no client has checked in on it since it parked'
    : `the client that took it has not checked in for ${report.idleMinutes} minutes`
  return `STALLED HAND-OFF — the ${report.stage} step was handed to a client ${report.idleMinutes} minutes ago and ${how}. The likeliest cause is a client that ended its turn with this step open; a parked hand-off waits indefinitely, so nothing will resume it on its own. It is still answerable: do the work and submit against the SAME handOffId below. If you cannot, tell the user the flight is stalled and let them decide — do not silently leave it parked again.`
}

/** Forget a hand-off's contact record. Called when the hand-off is answered or
 *  the flight stops, so the ledger cannot grow without bound across a long-lived
 *  server. */
export function forgetHandOffContact(ledger: HandOffContactLedger, flightId: string): void {
  for (const k of [...ledger.keys()]) {
    if (k.startsWith(`${flightId}#`)) ledger.delete(k)
  }
}
