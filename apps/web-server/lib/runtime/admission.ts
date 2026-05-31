import os from 'os'

/**
 * Resource-aware admission control. Each run can boot several services plus a
 * Playwright runner (and a heal agent), so N concurrent runs can exhaust a
 * laptop. The admission decision answers: can this run start now, or must it
 * queue until something frees up?
 *
 * The model is a "slot budget" derived from a CPU/free-RAM heuristic, with an
 * optional hard ceiling (`CANARY_MAX_CONCURRENT_RUNS`). It is pure given its
 * inputs (system resources injected) so it is deterministic to test; the
 * scheduler that owns the queue + promotion lives alongside the server start
 * flow and calls into this.
 */

export interface SystemResources {
  cpuCount: number
  freeMemBytes: number
}

export function readSystemResources(): SystemResources {
  return { cpuCount: os.cpus().length, freeMemBytes: os.freemem() }
}

export interface AdmissionConfig {
  /** Optional hard ceiling on concurrent (running+healing) runs. null = rely
   *  purely on the resource heuristic. */
  maxConcurrentRuns: number | null
  /** Estimated working-set memory per run, used by the memory guard. */
  perRunMemBytes: number
}

const DEFAULT_PER_RUN_MEM_BYTES = 768 * 1024 * 1024 // 768 MB

/** Parse admission config from the environment. `CANARY_MAX_CONCURRENT_RUNS`
 *  is the optional manual ceiling; invalid/empty values fall back to null. */
export function resolveAdmissionConfig(env: NodeJS.ProcessEnv = process.env): AdmissionConfig {
  const raw = env.CANARY_MAX_CONCURRENT_RUNS
  let max: number | null = null
  if (raw != null && raw.trim() !== '') {
    const n = Number.parseInt(raw.trim(), 10)
    if (Number.isFinite(n) && n > 0) max = n
  }
  return { maxConcurrentRuns: max, perRunMemBytes: DEFAULT_PER_RUN_MEM_BYTES }
}

/** Budget in "run slots" from the resource heuristic: the tighter of a CPU
 *  bound (leave one core for the server/UI) and a free-memory bound. */
export function computeSlotBudget(res: SystemResources, cfg: AdmissionConfig): number {
  const cpuSlots = Math.max(1, res.cpuCount - 1)
  const memSlots = Math.max(1, Math.floor(res.freeMemBytes / cfg.perRunMemBytes))
  return Math.min(cpuSlots, memSlots)
}

/** Estimated cost of a run: one slot per service plus one for the Playwright
 *  runner. A service-less run still costs 1. */
export function estimateRunCost(serviceCount: number): number {
  return Math.max(0, serviceCount) + 1
}

export interface AdmissionInput {
  /** Cost (see estimateRunCost) of each currently running/healing run. */
  activeCosts: number[]
  /** Cost of the candidate run wanting to start. */
  candidateCost: number
  resources: SystemResources
  config: AdmissionConfig
}

export interface AdmissionDecision {
  admit: boolean
  /** Present when admit=false — why the run must queue. */
  reason?: 'resources'
}

/**
 * Decide whether to admit a candidate run now. A run is admitted when both:
 *  - the manual ceiling (if set) isn't exceeded, and
 *  - the slot budget has room — OR nothing else is active (so a single large
 *    run can never deadlock against its own cost exceeding the budget).
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const { activeCosts, candidateCost, resources, config } = input

  if (config.maxConcurrentRuns != null && activeCosts.length + 1 > config.maxConcurrentRuns) {
    return { admit: false, reason: 'resources' }
  }

  // Nothing else running → always admit, regardless of the candidate's size.
  if (activeCosts.length === 0) return { admit: true }

  const budget = computeSlotBudget(resources, config)
  const used = activeCosts.reduce((sum, c) => sum + c, 0)
  if (used + candidateCost <= budget) return { admit: true }
  return { admit: false, reason: 'resources' }
}
