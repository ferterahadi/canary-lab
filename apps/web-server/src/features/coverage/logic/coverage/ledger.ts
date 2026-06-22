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

// Semantic coverage computation. Joins two facts, NO test runs:
//   • requirements — from the PRD summary (Phase 1)
//   • annotations  — which test claims to cover which requirement + paths (Phase 2)
//
// A requirement is `covered` when every declared path is claimed by a mapped test,
// `path-incomplete` when some paths are unclaimed, `untested` when no test maps to
// it. The headline % is deterministic math (covered ÷ active); whether a test ever
// PASSED is a separate concern and never enters this number. Output types live in
// shared/coverage/types.ts; strength.ts later grades each test's depth.

export type { CoverageLedger, RequirementCoverage }

const DEFAULT_PATHS: PathType[] = ['happy']

/** Roll the fine-grained gap type up to the coarse covered/partial/uncovered. */
function coverageStatusFor(gapType: GapType): CoverageStatus {
  if (gapType === 'covered') return 'covered'
  if (gapType === 'untested') return 'uncovered'
  return 'partial' // path-incomplete
}

/** A test as the coverage layer needs it (mapped from ExtractedTest upstream). */
export interface CoverageTestInput {
  name: string
  requirements?: string[]
  pathTypes?: PathType[]
  file?: string
  line?: number
}

export interface ComputeCoverageArgs {
  feature: string
  requirements: Requirement[]
  tests: CoverageTestInput[]
}

export function computeCoverageLedger(args: ComputeCoverageArgs): CoverageLedger {
  const { feature, requirements, tests } = args

  const testCoverage: TestCoverage[] = tests.map((test) => ({
    name: test.name,
    file: test.file,
    line: test.line,
    requirements: test.requirements ?? [],
    pathTypes: test.pathTypes && test.pathTypes.length ? test.pathTypes : DEFAULT_PATHS,
  }))

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
    const impliedPaths = requirement.pathTypes.length ? requirement.pathTypes : DEFAULT_PATHS

    // A path is covered if some MAPPED test claims it (no run required).
    const claimedPaths = new Set<PathType>()
    for (const t of annotated) for (const p of t.pathTypes) claimedPaths.add(p)
    const pathCoverage: PathCoverage[] = impliedPaths.map((path) => ({
      path,
      covered: claimedPaths.has(path),
    }))

    let gapType: GapType
    if (annotated.length === 0) gapType = 'untested'
    else if (pathCoverage.every((p) => p.covered)) gapType = 'covered'
    else gapType = 'path-incomplete'

    return {
      requirement,
      annotatedTestNames: annotated.map((t) => t.name),
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
    covered: reqCoverage.filter((r) => r.gapType === 'covered').length,
    pathIncomplete: reqCoverage.filter((r) => r.gapType === 'path-incomplete').length,
    untested: reqCoverage.filter((r) => r.gapType === 'untested').length,
    orphanTests: orphanTestNames.length,
  }

  const coveragePct = totals.total === 0
    ? 0
    : Math.round((totals.covered / totals.total) * 1000) / 10

  // Breadth: requirements that have at least one mapped test (everything except
  // 'untested'). The looser sibling of coveragePct (which also wants every path).
  const mappedPct = totals.total === 0
    ? 0
    : Math.round(((totals.total - totals.untested) / totals.total) * 1000) / 10

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
    mappedPct,
    orphanRequirementIds: [...orphanSet].sort(),
    orphanTestNames,
  }
}
