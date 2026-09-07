import type {
  CoverageLedger,
  EnforcementState,
  EnforcementSummary,
  Requirement,
  RequirementCoverage,
  RequirementEnforcement,
  RequirementTestChange,
} from '../../../../../../../shared/coverage/types'

// The ledger's time axis (D11), pure. Three timestamps per requirement — proven,
// tests changed, wording changed — ordered into one of four states. The facts
// come from the caller: `wordingChangedAt` rides the requirement itself, the
// proof and the test changes come from run evidence (requirement-history.ts).
// Like `provenPct`, this layer is additive: it never touches a gap type, a
// status, or a percentage. The state vocabulary is documented on the type.

/** Run evidence about one requirement's mapped tests. */
export interface RequirementHistory {
  /** The newest run in which every mapped test passed. */
  provenAt?: { runId: string; at: string }
  /** Every classified change to a mapped test, in any order. */
  testChanges: RequirementTestChange[]
}

const ms = (iso: string): number => Date.parse(iso)

export function deriveRequirementEnforcement(
  requirement: Requirement,
  history: RequirementHistory,
  generatedAt: string,
): RequirementEnforcement {
  const wordingChangedAt = requirement.wordingChangedAt ?? generatedAt
  // Never proven reads as −∞: everything that happened is newer than the proof.
  const provenMs = history.provenAt ? ms(history.provenAt.at) : -Infinity
  const latest = [...history.testChanges].sort((a, b) => ms(b.at) - ms(a.at))[0]
  const weakenedSinceProof = history.testChanges.some((c) => c.verdict === 'weaker' && ms(c.at) > provenMs)

  let state: EnforcementState
  if (weakenedSinceProof) state = 'tests-weakened'
  else if (latest && ms(latest.at) > provenMs) state = 'proof-stale'
  else if (ms(wordingChangedAt) > provenMs) state = 'wording-ahead'
  else state = 'proven-unchanged'

  const accepted: RequirementEnforcement['accepted'] = requirement.acceptedAt === undefined
    ? 'none'
    : requirement.acceptedFingerprint === requirement.fingerprint ? 'current' : 'outdated'

  return {
    state,
    ...(history.provenAt ? { provenAt: history.provenAt } : {}),
    ...(latest ? { testsChangedAt: latest } : {}),
    wordingChangedAt,
    accepted,
  }
}

export interface ApplyEnforcementArgs {
  /** The summary's generation time — the wording stamp for pre-D11 survivors. */
  generatedAt: string
  /** The feature's latest run, for the "proven in run <id>" header. */
  runId?: string
  /** Run evidence over a set of test names (a requirement's mapped tests). */
  historyFor: (tests: string[]) => RequirementHistory
}

/** Attach a time-axis state to every requirement and the roll-up to the ledger. */
export function applyEnforcement(ledger: CoverageLedger, args: ApplyEnforcementArgs): CoverageLedger {
  const states: Record<EnforcementState, number> = {
    'proven-unchanged': 0, 'tests-weakened': 0, 'wording-ahead': 0, 'proof-stale': 0,
  }
  const requirements: RequirementCoverage[] = ledger.requirements.map((rc) => {
    const history = args.historyFor(rc.annotatedTestNames)
    // Only a `covered` claim can be proven: a partial or untested requirement's
    // mapped tests may all be green and still leave paths nobody exercised.
    const provable = rc.gapType === 'covered' ? history : { testChanges: history.testChanges }
    const enforcement = deriveRequirementEnforcement(rc.requirement, provable, args.generatedAt)
    states[enforcement.state] += 1
    return { ...rc, enforcement }
  })
  const enforcement: EnforcementSummary = {
    ...(args.runId ? { runId: args.runId } : {}),
    provenUnchanged: states['proven-unchanged'],
    total: requirements.length,
    states,
  }
  return { ...ledger, requirements, enforcement }
}
