import fs from 'fs'
import path from 'path'
import { parseRequestMatch } from './request-match'
import { ROBUSTNESS_ENVELOPE_FORMAT, ROBUSTNESS_ENVELOPE_RELATIVE_PATH, type DuplicateAtom, type LatencyAtom, type RestartAtom, type RobustnessEnvelope } from './types'

// Inside features/<suite>/ on purpose: the D9 snapshot copies the whole suite
// folder (only envsets, node_modules and .git are skipped), so this file rides
// along and a mid-run edit to it is reported like any other spec edit.
export function robustnessEnvelopePath(featureDir: string): string {
  return path.join(featureDir, ROBUSTNESS_ENVELOPE_RELATIVE_PATH)
}

/** Written on the stage's first start when the suite has none. Every declared
 *  slot is fronted: fixed latency on all traffic, one replay of every write, one
 *  restart per slot held on its SECOND write — the three questions a
 *  non-idempotent, in-memory service fails. The second write, not the first: the
 *  shim recycles the service before forwarding the Nth match, so a restart on
 *  the first write happens before any state exists and can lose nothing. The
 *  replay is sent the moment the original is forwarded (`gapMs: 0`): a duplicate
 *  that lands after the test's next read is invisible, and an API suite reads
 *  back within a millisecond — the 6d live proof saw the shipped storefront's
 *  seven journeys finish in 265 ms, before a 500 ms replay could arrive. */
export function defaultRobustnessEnvelope(slots: readonly string[]): RobustnessEnvelope {
  const envelope: RobustnessEnvelope = {
    format: ROBUSTNESS_ENVELOPE_FORMAT,
    latency: { ms: 300 },
    duplicate: { gapMs: 0, match: 'WRITE /**' },
  }
  if (slots.length > 0) envelope.restart = slots.map((slot) => ({ slot, afterNth: 2, match: 'WRITE /**' }))
  return envelope
}

export type ParseRobustnessEnvelopeResult =
  | { ok: true; envelope: RobustnessEnvelope }
  | { ok: false; reason: string }

/** Validates a parsed JSON value into an envelope, naming the first violation.
 *  Unknown keys are dropped rather than carried: a misspelt atom that survived
 *  as an inert extra field would look declared and perturb nothing. */
export function parseRobustnessEnvelope(raw: unknown): ParseRobustnessEnvelopeResult {
  if (!isRecord(raw)) return { ok: false, reason: 'envelope must be a JSON object' }
  if (raw.format !== ROBUSTNESS_ENVELOPE_FORMAT) return { ok: false, reason: `format must be "${ROBUSTNESS_ENVELOPE_FORMAT}"` }
  const envelope: RobustnessEnvelope = { format: ROBUSTNESS_ENVELOPE_FORMAT }

  if (raw.latency !== undefined) {
    if (!isRecord(raw.latency)) return { ok: false, reason: 'latency must be an object' }
    if (!isNonNegativeInt(raw.latency.ms)) return { ok: false, reason: 'latency.ms must be a non-negative integer' }
    envelope.latency = { ms: raw.latency.ms } satisfies LatencyAtom
  }

  if (raw.duplicate !== undefined) {
    if (!isRecord(raw.duplicate)) return { ok: false, reason: 'duplicate must be an object' }
    if (!isNonNegativeInt(raw.duplicate.gapMs)) return { ok: false, reason: 'duplicate.gapMs must be a non-negative integer' }
    const match = validMatch(raw.duplicate.match, 'duplicate.match')
    if (!match.ok) return match
    envelope.duplicate = { gapMs: raw.duplicate.gapMs, match: match.value } satisfies DuplicateAtom
  }

  if (raw.restart !== undefined) {
    if (!Array.isArray(raw.restart)) return { ok: false, reason: 'restart must be a list' }
    const seen = new Set<string>()
    const restart: RestartAtom[] = []
    for (const [i, entry] of raw.restart.entries()) {
      if (!isRecord(entry)) return { ok: false, reason: `restart[${i}] must be an object` }
      if (typeof entry.slot !== 'string' || entry.slot === '') return { ok: false, reason: `restart[${i}].slot must be a non-empty string` }
      if (seen.has(entry.slot)) return { ok: false, reason: `restart[${i}].slot "${entry.slot}" is declared twice` }
      if (!isNonNegativeInt(entry.afterNth) || entry.afterNth < 1) return { ok: false, reason: `restart[${i}].afterNth must be an integer ≥ 1` }
      const match = validMatch(entry.match, `restart[${i}].match`)
      if (!match.ok) return match
      seen.add(entry.slot)
      restart.push({ slot: entry.slot, afterNth: entry.afterNth, match: match.value })
    }
    envelope.restart = restart
  }

  return { ok: true, envelope }
}

export type ReadRobustnessEnvelopeResult =
  | { kind: 'ok'; path: string; envelope: RobustnessEnvelope }
  | { kind: 'absent'; path: string }
  | { kind: 'invalid'; path: string; reason: string }

/** Absent is a state, not an error: the stage writes the default then. Anything
 *  else that is not a valid envelope is `invalid` with its reason — the human
 *  owns this file by hand and must see what they broke. */
export function readRobustnessEnvelope(featureDir: string): ReadRobustnessEnvelopeResult {
  const p = robustnessEnvelopePath(featureDir)
  if (!fs.existsSync(p)) return { kind: 'absent', path: p }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    return { kind: 'invalid', path: p, reason: err instanceof Error ? err.message : String(err) }
  }
  const parsed = parseRobustnessEnvelope(raw)
  return parsed.ok ? { kind: 'ok', path: p, envelope: parsed.envelope } : { kind: 'invalid', path: p, reason: parsed.reason }
}

export function writeRobustnessEnvelope(featureDir: string, envelope: RobustnessEnvelope): string {
  const p = robustnessEnvelopePath(featureDir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(envelope, null, 2) + '\n')
  return p
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function validMatch(raw: unknown, field: string): { ok: true; value: string } | { ok: false; reason: string } {
  const parsed = parseRequestMatch(typeof raw === 'string' ? raw : '')
  return parsed.ok ? { ok: true, value: raw as string } : { ok: false, reason: `${field}: ${parsed.reason}` }
}

export { ROBUSTNESS_ENVELOPE_FORMAT, ROBUSTNESS_ENVELOPE_RELATIVE_PATH } from './types'
