import { listRuns } from '../run-store'
import { readRunSummary } from '../run-store'
import { readManifest } from '../runtime/manifest'
import { buildRunPaths, runDirFor } from '../runtime/run-paths'
import type { LastPassingRun } from '../../../../shared/coverage/types'

// The grounding substrate: over a feature's run history, find the most-recent
// run in which each test actually PASSED. This is the ground truth a coverage
// claim is checked against — a test file existing is just a claim; a passing
// run is evidence.
//
// Join key = the test NAME (Playwright title). passedNames[] is the stable
// per-test passing signal in each run's e2e-summary.json; passedIds[] are
// Playwright-internal ids that drift with line numbers (see normalizeRunSummary),
// so name is the durable key. A test counts as passing in a run whenever it is
// in that run's passedNames[], regardless of the run's overall status (another
// test failing doesn't un-pass this one).

export type { LastPassingRun }

export interface PassingRunIndex {
  /** testName → its most-recent passing run. */
  byTestName: Map<string, LastPassingRun>
}

export interface BuildIndexDeps {
  listRuns?: typeof listRuns
  readRunSummary?: typeof readRunSummary
  readManifest?: typeof readManifest
}

/**
 * Build the per-test "last passing run" index for one feature. Runs are walked
 * newest-first, so the first time a test name is seen is its most-recent pass.
 */
export function buildLastPassingRunIndex(
  logsDir: string,
  feature: string,
  deps: BuildIndexDeps = {},
): PassingRunIndex {
  const list = deps.listRuns ?? listRuns
  const readSummary = deps.readRunSummary ?? readRunSummary
  const readMan = deps.readManifest ?? readManifest

  const entries = list(logsDir, { feature }) // newest-first
  const byTestName = new Map<string, LastPassingRun>()
  const envByRunId = new Map<string, string | undefined>()

  for (const entry of entries) {
    const runDir = runDirFor(logsDir, entry.runId)
    const summary = readSummary(runDir)
    const passedNames = summary?.passedNames
    if (!passedNames || !passedNames.length) continue

    let env = envByRunId.get(entry.runId)
    if (env === undefined && !envByRunId.has(entry.runId)) {
      const manifest = readMan(buildRunPaths(runDir).manifestPath)
      env = manifest?.env
      envByRunId.set(entry.runId, env)
    }

    for (const name of passedNames) {
      if (byTestName.has(name)) continue // newest-first → keep the first seen
      byTestName.set(name, {
        testName: name,
        runId: entry.runId,
        env,
        at: entry.endedAt ?? entry.startedAt,
      })
    }
  }

  return { byTestName }
}
