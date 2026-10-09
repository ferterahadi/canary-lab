import { createHash } from 'crypto'
import fs from 'fs'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import type { RunManifest } from '../../../../../../../shared/run-manifest'
import { isSpecFile } from '../../../../../../../shared/spec-files'
import type { ReviewSource } from '../../../../../../../shared/test-review'
import type { CycleFileExecution, CycleFileRole, CycleReviewFile, RunCycleReview } from '../../../../../../../shared/test-view/cycle-review'
import { findFeature } from '../../../../shared/feature-loader'
import { confinedFile } from '../../../../shared/path-containment'
import { reviewSourceFor } from '../../../../shared/readable-tests/review-source'
import { diffSourceText } from '../dirty-specs/text-diff'
import { detectHealMode } from '../runtime/auto-heal'
import { readManifest } from '../runtime/manifest'
import { runDirFor, runManifestPath } from '../runtime/run-paths'
import { cycleDiffs } from './cycle-sources'
import { resolveCycleTree, suiteRelativePath, type CycleTree } from './cycle-tree'
import { recoverCycleFile } from './recover-cycle-file'

export interface CycleReviewDeps { logsDir: string; featuresDir: string }

/** Translating a file to English is a synchronous compile; past this size the
 * view stays on code rather than hold the route. */
const MAX_ENGLISH_LINES = 5000
const MEMO_LIMIT = 64
// The page re-reads a cycle on every journal change, mostly for other cycles.
// The key covers everything a recovery reads except git's blobs, which never
// change once written.
const memo = new Map<string, RunCycleReview>()

/** One repair cycle's files with their full versions wherever they can be
 * recovered and verified, the English for suite files, and whether the run
 * executed each suite edit. Null when the cycle recorded no diff anywhere. */
export async function buildRunCycleReview(deps: CycleReviewDeps, runId: string, iteration: number): Promise<RunCycleReview | null> {
  const runDir = runDirFor(deps.logsDir, runId)
  const diffs = cycleDiffs(runDir)
  const current = diffs.get(iteration)
  if (!current) return null
  const manifestPath = runManifestPath(runDir)
  const manifest = readManifest(manifestPath)
  const feature = manifest ? findFeature(deps.featuresDir, manifest.feature) : undefined
  const suiteDir = manifest?.suiteSnapshot?.kind === 'taken' ? manifest.suiteSnapshot.dir : null

  const trees = new Map<string | undefined, Promise<CycleTree>>()
  const treeFor = (key: string | undefined): Promise<CycleTree> => {
    if (!manifest) return Promise.resolve({ kind: 'unknown' })
    if (!trees.has(key)) trees.set(key, resolveCycleTree(key, manifest, feature))
    return trees.get(key)!
  }
  const placed = await Promise.all(current.files.map(async (file) => {
    const tree = await treeFor(file.repo)
    return { file, tree, rel: tree.kind === 'feature-dir' ? suiteRelativePath(tree, file.path) : null }
  }))

  const key = memoKey(runDir, iteration, [...diffs.values()].map((diff) => diff.text), manifest, feature,
    placed.map(({ rel }) => suiteStamp(suiteDir, rel)))
  const cached = memo.get(key)
  if (cached) return cached

  const files = await Promise.all(placed.map(async ({ file, tree, rel }): Promise<CycleReviewFile> => {
    const role: CycleFileRole = rel === null ? 'app' : isSpecFile(rel) ? 'spec' : 'support'
    const { recovery, before, after } = await recoverCycleFile({ file, iteration, tree, diffs, suiteDir })
    const { hunks: _hunks, ...wire } = file
    const side = (text: string): ReviewSource => readableSide(rel, role, text, feature)
    return {
      ...wire, role, recovery,
      ...(before !== undefined && after !== undefined ? { sources: {
        before: side(before), after: side(after),
        patch: await diffSourceText(before, after, Math.max(before.split('\n').length, after.split('\n').length)),
      } } : {}),
      ...(rel !== null && manifest ? { executed: execution(manifest, rel, current.previousTimestamp ?? manifest.startedAt) } : {}),
    }
  }))
  const review: RunCycleReview = {
    iteration, files,
    source: current.source, patchPath: current.patchPath, truncated: current.truncated,
    healMode: detectHealMode(manifestPath),
  }
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value!)
  memo.set(key, review)
  return review
}

/** English is for the suite's own JavaScript and TypeScript; app code is code. */
function readableSide(rel: string | null, role: CycleFileRole, source: string, feature: FeatureConfig | undefined): ReviewSource {
  if (rel === null || source === '') return { source, tests: [] }
  if (source.split('\n').length > MAX_ENGLISH_LINES) return { source, tests: [], parseError: `English skipped: file over ${MAX_ENGLISH_LINES} lines` }
  return reviewSourceFor(rel, source, feature?.semanticRules, { withTests: role === 'spec' })
}

/** A suite edit ran only when the run executed the live suite, or adopted the
 * file into its suite copy once the cycle could have edited it. A cycle's
 * journal entry is written when the cycle ends, and a person may adopt the
 * edit before that, so the window opens when the cycle before it ended. */
function execution(manifest: RunManifest, rel: string, since: string): CycleFileExecution {
  if (manifest.suiteSnapshot?.kind !== 'taken') return { kind: 'live' }
  // `!(at < start)` keeps every adoption when a time does not parse.
  const start = Date.parse(since)
  const adoption = [...(manifest.specEdits?.adopted ?? [])].reverse()
    .find((entry) => entry.files.includes(rel) && !(Date.parse(entry.at) < start))
  return adoption ? { kind: 'adopted', by: adoption.by, at: adoption.at } : { kind: 'inert' }
}

/** When the suite copy's file last changed, so an edit to the copy is a new
 * input; null when there is no copy of it. */
function suiteStamp(suiteDir: string | null, rel: string | null): number | null {
  if (!suiteDir || rel === null) return null
  try {
    return fs.statSync(confinedFile(suiteDir, rel)).mtimeMs
  } catch {
    // Absent from the copy, or outside it: recovery reads nothing there either.
    return null
  }
}

function memoKey(runDir: string, iteration: number, diffs: string[], manifest: RunManifest | null, feature: FeatureConfig | undefined, stamps: Array<number | null>): string {
  return createHash('sha1').update(JSON.stringify([
    runDir, iteration, diffs, stamps, feature?.semanticRules ?? null,
    manifest && [manifest.startedAt, manifest.featureDir, manifest.repoPaths, manifest.worktrees, manifest.suiteSnapshot, manifest.specEdits?.adopted],
  ])).digest('hex')
}
