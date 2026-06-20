import type {
  CoverageLedger,
  CoverageStatus,
  CoverageTotals,
  GapType,
  PathCoverage,
  PathType,
  RequirementCoverage,
  Requirement,
  TestCoverage,
} from '../../../../../../../shared/coverage/types'
import type { LastPassingRun, PassingRunIndex } from './grounding'

// Coverage computation (breadth spine). Joins three grounded facts:
//   • requirements   — from the PRD summary (Phase 1)
//   • annotations    — which test claims to cover which requirement (Phase 2)
//   • passing runs    — which test actually has ground-truth evidence (grounding)
//
// The headline coverage % is deterministic math: verified requirements ÷ total
// (active) requirements. No agent opinion enters this number. Output types live
// in shared/coverage/types.ts (consumed by the UI + MCP); the rigor layer
// (rigor.ts) later assigns the `shallow-verified` gap and per-requirement rigor.

export type { CoverageLedger, RequirementCoverage }

const DEFAULT_PATHS: PathType[] = ['happy']

/** Roll the fine-grained gap type up to the coarse covered/partial/uncovered. */
function coverageStatusFor(gapType: GapType): CoverageStatus {
  if (gapType === 'verified') return 'covered'
  if (gapType === 'untested') return 'uncovered'
  return 'partial' // unverified | path-incomplete | shallow-verified
}

/** A test as the coverage layer needs it (mapped from ExtractedTest upstream). */
export interface CoverageTestInput {
  name: string
  requirements?: string[]
  pathTypes?: PathType[]
  file?: string
  line?: number
}

function pickMostRecent(runs: LastPassingRun[]): LastPassingRun | undefined {
  let best: LastPassingRun | undefined
  for (const run of runs) {
    if (!best) {
      best = run
      continue
    }
    const a = run.at ?? ''
    const b = best.at ?? ''
    if (a > b) best = run
  }
  return best
}

export interface ComputeCoverageArgs {
  feature: string
  requirements: Requirement[]
  tests: CoverageTestInput[]
  index: PassingRunIndex
}

export function computeCoverageLedger(args: ComputeCoverageArgs): CoverageLedger {
  const { feature, requirements, tests, index } = args

  // Resolve each test's verification status once.
  const testCoverage: TestCoverage[] = tests.map((test) => {
    const lastPassingRun = index.byTestName.get(test.name)
    return {
      name: test.name,
      file: test.file,
      line: test.line,
      requirements: test.requirements ?? [],
      pathTypes: test.pathTypes && test.pathTypes.length ? test.pathTypes : DEFAULT_PATHS,
      verified: Boolean(lastPassingRun),
      lastPassingRun,
    }
  })

  // Index annotated tests by requirement id.
  const testsByReq = new Map<string, TestCoverage[]>()
  for (const tc of testCoverage) {
    for (const reqId of tc.requirements) {
      const list = testsByReq.get(reqId)
      if (list) list.push(tc)
      else testsByReq.set(reqId, [tc])
    }
  }

  const active = requirements.filter((r) => !r.deprecated)
  const knownIds = new Set(requirements.map((r) => r.id))

  const reqCoverage: RequirementCoverage[] = active.map((requirement) => {
    const annotated = testsByReq.get(requirement.id) ?? []
    const verified = annotated.filter((t) => t.verified)
    const impliedPaths = requirement.pathTypes.length ? requirement.pathTypes : DEFAULT_PATHS

    // A path is verified if some verified test exercises it.
    const verifiedPaths = new Set<PathType>()
    for (const t of verified) for (const p of t.pathTypes) verifiedPaths.add(p)
    const pathCoverage: PathCoverage[] = impliedPaths.map((path) => ({
      path,
      verified: verifiedPaths.has(path),
    }))

    let gapType: GapType
    if (annotated.length === 0) gapType = 'untested'
    else if (verified.length === 0) gapType = 'unverified'
    else if (pathCoverage.every((p) => p.verified)) gapType = 'verified'
    else gapType = 'path-incomplete'

    return {
      requirement,
      annotatedTestNames: annotated.map((t) => t.name),
      verifiedTestNames: verified.map((t) => t.name),
      lastPassingRun: pickMostRecent(verified.map((t) => t.lastPassingRun!).filter(Boolean)),
      pathCoverage,
      gapType,
      coverageStatus: coverageStatusFor(gapType),
    }
  })

  // Orphan tests = no requirement linkage at all (the annotate-pass candidates).
  const orphanTestNames = testCoverage
    .filter((tc) => tc.requirements.length === 0)
    .map((tc) => tc.name)
    .sort()

  const totals: CoverageTotals = {
    total: active.length,
    verified: reqCoverage.filter((r) => r.gapType === 'verified').length,
    untested: reqCoverage.filter((r) => r.gapType === 'untested').length,
    unverified: reqCoverage.filter((r) => r.gapType === 'unverified').length,
    pathIncomplete: reqCoverage.filter((r) => r.gapType === 'path-incomplete').length,
    shallowVerified: 0, // populated by the rigor layer (Phase 3B)
    orphanTests: orphanTestNames.length,
  }

  const coveragePct = totals.total === 0
    ? 0
    : Math.round((totals.verified / totals.total) * 1000) / 10

  // Annotations pointing at ids the PRD doesn't know about — surfaces stale
  // annotations after a requirement was renamed/removed without a regen.
  const orphanSet = new Set<string>()
  for (const tc of testCoverage) {
    for (const reqId of tc.requirements) {
      if (!knownIds.has(reqId)) orphanSet.add(reqId)
    }
  }

  return {
    feature,
    requirements: reqCoverage,
    tests: testCoverage,
    totals,
    coveragePct,
    orphanRequirementIds: [...orphanSet].sort(),
    orphanTestNames,
  }
}
