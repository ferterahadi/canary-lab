import type { DuplicateAtom, LatencyAtom, RestartAtom, RobustnessEnvelope } from './types'

// Shrink (D16): from an envelope under which a finding reproduced, the smallest
// envelope that still reproduces it — so the repro a human (or the repair
// agent) reads names only what matters. Pure: the caller supplies the probe,
// which boots the suite under a candidate envelope and answers "did the same
// finding happen again". This module only decides what to ask next.
//
// Two searches, in a fixed order, then a confirmation:
//   1. ddmin over ATOMS — drop each atom in turn, heaviest first (restarts, then
//      the duplicate, then latency), so when two atoms each suffice the repro
//      keeps the lighter one; a drop that still reproduces is kept. Repeated
//      until a pass drops nothing (1-minimal).
//   2. bisect each numeric KNOB of the surviving atoms toward the passing side
//      (`latency.ms`, then `duplicate.gapMs`), down to `minStepMs`. The restart
//      atom's `afterNth` is not bisected: "which write" is a position, not a
//      magnitude, and a smaller N is not a weaker perturbation.
//   3. replay the result `confirmations` times; every replay must reproduce or
//      the finding is `unconfirmed` — shown as such, never rounded to a repro.
//
// A knob at a timing threshold (a TTL, a race) has a fuzzy last step by physics,
// not by mechanism, so `minStepMs` is the resolution of the answer and
// `sameAtResolution` is how two shrinks of one finding are compared: same atoms,
// every knob within one step. Search probes are capped by `maxProbes`; the
// confirmation replays are counted separately because they measure something
// else (determinism, not minimality).

/** Answers whether the finding reproduces under this envelope. */
export type ShrinkProbe = (envelope: RobustnessEnvelope) => Promise<boolean>

export interface ShrinkOptions {
  /** Search probes (ddmin + bisect) before the search stops where it is. */
  maxProbes?: number
  /** Replays of the shrunk envelope that must ALL reproduce. */
  confirmations?: number
  /** Knob resolution in milliseconds; bisect stops inside one step. */
  minStepMs?: number
}

export interface ShrinkStep {
  /** 1-based search probe number, or 0 for the opening reproduction check. */
  probe: number
  envelope: RobustnessEnvelope
  reproduced: boolean
  /** What this probe was asking, in words — the shrink trace a pane renders. */
  why: string
}

export type ShrinkStatus = 'confirmed' | 'unconfirmed' | 'not-reproduced'

export interface ShrinkResult {
  status: ShrinkStatus
  /** The smallest envelope known to reproduce (the input, when nothing shrank). */
  envelope: RobustnessEnvelope
  /** Search probes spent (excludes the opening check and the confirmations). */
  probes: number
  budgetExhausted: boolean
  confirmations: { asked: number; reproduced: number }
  steps: ShrinkStep[]
  /** One line a human can act on, e.g. `latency 262 ms · duplicate WRITE /** after 31 ms`. */
  repro: string
}

export const DEFAULT_SHRINK_OPTIONS: Required<ShrinkOptions> = { maxProbes: 12, confirmations: 3, minStepMs: 50 }

type AtomId = 'latency' | 'duplicate' | `restart:${string}`

export async function shrinkEnvelope(envelope: RobustnessEnvelope, probe: ShrinkProbe, options: ShrinkOptions = {}): Promise<ShrinkResult> {
  const opts = { ...DEFAULT_SHRINK_OPTIONS, ...options }
  const steps: ShrinkStep[] = []
  let probes = 0
  let budgetExhausted = false

  const ask = async (candidate: RobustnessEnvelope, why: string, counted = true): Promise<boolean> => {
    const reproduced = await probe(candidate)
    if (counted) probes++
    steps.push({ probe: counted ? probes : 0, envelope: candidate, reproduced, why })
    return reproduced
  }
  const budgetLeft = () => {
    if (probes < opts.maxProbes) return true
    budgetExhausted = true
    return false
  }

  if (!(await ask(envelope, 'does the finding reproduce under the envelope it was found with?', false))) {
    return { status: 'not-reproduced', envelope, probes, budgetExhausted, confirmations: { asked: 0, reproduced: 0 }, steps, repro: reproLine(envelope) }
  }

  // 1. ddmin over atoms.
  let current = envelope
  let dropped = true
  while (dropped) {
    dropped = false
    for (const id of atomIds(current).reverse()) {
      if (!budgetLeft()) break
      const without = withoutAtom(current, id)
      if (await ask(without, `still reproduces without ${describeAtom(current, id)}?`)) {
        current = without
        dropped = true
      }
    }
  }

  // 2. bisect knobs toward the passing side, declared order.
  if (current.latency) {
    const ms = await bisect(current.latency.ms, (ms) => ask(withLatency(current, ms), `still reproduces with latency at ${ms} ms?`))
    current = withLatency(current, ms)
  }
  if (current.duplicate) {
    const gapMs = await bisect(current.duplicate.gapMs, (gapMs) => ask(withDuplicateGap(current, gapMs), `still reproduces with the duplicate ${gapMs} ms after the original?`))
    current = withDuplicateGap(current, gapMs)
  }

  // 3. confirm.
  let reproduced = 0
  for (let i = 1; i <= opts.confirmations; i++) {
    if (await ask(current, `replay ${i} of ${opts.confirmations} of the shrunk envelope`, false)) reproduced++
  }
  return {
    status: reproduced === opts.confirmations ? 'confirmed' : 'unconfirmed',
    envelope: current,
    probes,
    budgetExhausted,
    confirmations: { asked: opts.confirmations, reproduced },
    steps,
    repro: reproLine(current),
  }

  /** `hi` is the value known to reproduce; `lo` the floor or a value known to
   *  pass. Returns the smallest reproducing value found, within one step. */
  async function bisect(failing: number, tryAt: (value: number) => Promise<boolean>): Promise<number> {
    let lo = 0
    let hi = failing
    while (hi - lo > opts.minStepMs && budgetLeft()) {
      const mid = Math.floor((lo + hi) / 2)
      if (await tryAt(mid)) hi = mid
      else lo = mid
    }
    return hi
  }
}

/** Two shrinks of one finding agree when they kept the same atoms and every
 *  knob sits within one step — the resolution the search actually has. */
export function sameAtResolution(a: RobustnessEnvelope, b: RobustnessEnvelope, minStepMs: number = DEFAULT_SHRINK_OPTIONS.minStepMs): boolean {
  const ids = atomIds(a)
  if (ids.length !== atomIds(b).length || !ids.every((id) => atomIds(b).includes(id))) return false
  if (a.latency && Math.abs(a.latency.ms - b.latency!.ms) > minStepMs) return false
  if (a.duplicate && (a.duplicate.match !== b.duplicate!.match || Math.abs(a.duplicate.gapMs - b.duplicate!.gapMs) > minStepMs)) return false
  return (a.restart ?? []).every((r) => {
    const other = b.restart!.find((o) => o.slot === r.slot)!
    return other.afterNth === r.afterNth && other.match === r.match
  })
}

/** The one-line repro fragment: every kept atom, in envelope order. */
export function reproLine(envelope: RobustnessEnvelope): string {
  const parts: string[] = []
  if (envelope.latency) parts.push(describeLatency(envelope.latency))
  if (envelope.duplicate) parts.push(describeDuplicate(envelope.duplicate))
  for (const restart of envelope.restart ?? []) parts.push(describeRestart(restart))
  return parts.length ? parts.join(' · ') : 'no perturbation'
}

function atomIds(envelope: RobustnessEnvelope): AtomId[] {
  const ids: AtomId[] = []
  if (envelope.latency) ids.push('latency')
  if (envelope.duplicate) ids.push('duplicate')
  for (const restart of envelope.restart ?? []) ids.push(`restart:${restart.slot}`)
  return ids
}

function withoutAtom(envelope: RobustnessEnvelope, id: AtomId): RobustnessEnvelope {
  const { latency, duplicate, restart, ...rest } = envelope
  const next: RobustnessEnvelope = { ...rest }
  if (latency && id !== 'latency') next.latency = latency
  if (duplicate && id !== 'duplicate') next.duplicate = duplicate
  const kept = (restart ?? []).filter((r) => `restart:${r.slot}` !== id)
  if (kept.length) next.restart = kept
  return next
}

function withLatency(envelope: RobustnessEnvelope, ms: number): RobustnessEnvelope {
  return { ...envelope, latency: { ms } }
}

function withDuplicateGap(envelope: RobustnessEnvelope, gapMs: number): RobustnessEnvelope {
  return { ...envelope, duplicate: { ...envelope.duplicate!, gapMs } }
}

function describeAtom(envelope: RobustnessEnvelope, id: AtomId): string {
  if (id === 'latency') return describeLatency(envelope.latency!)
  if (id === 'duplicate') return describeDuplicate(envelope.duplicate!)
  return describeRestart(envelope.restart!.find((r) => `restart:${r.slot}` === id)!)
}

const describeLatency = (atom: LatencyAtom) => `latency ${atom.ms} ms`
const describeDuplicate = (atom: DuplicateAtom) => `duplicate ${atom.match} after ${atom.gapMs} ms`
const describeRestart = (atom: RestartAtom) => `restart ${atom.slot} on ${atom.match} #${atom.afterNth}`
