import { createHash } from 'crypto'
import fs from 'fs'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import type { RunManifest } from '../../../../../../../shared/run-manifest'
import { isSpecFile } from '../../../../../../../shared/spec-files'
import type { ReviewSource } from '../../../../../../../shared/test-review'
import type { CycleFileExecution, CycleFileRole, CycleReviewFile, RunCycleReview } from '../../../../../../../shared/test-view/cycle-review'
import { findFeature } from '../../../../shared/feature-loader'
import { gitBlobSha1, isZeroBlob, matchesBlob } from '../../../../shared/git-blob'
import { confinedFile } from '../../../../shared/path-containment'
import { reviewSourceFor } from '../../../../shared/readable-tests/review-source'
import { diffSourceText } from '../dirty-specs/text-diff'
import { detectHealMode } from '../runtime/auto-heal'
import { readManifest } from '../runtime/manifest'
import { runDirFor, runManifestPath } from '../runtime/run-paths'
import { cycleDiffs, type CycleDiff } from './cycle-sources'
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

  // A replay reads the suite copy under every name the file had across the
  // cycles, so each of those is an input; so is each resolved tree, which
  // changes when a checkout comes back or the suite config moves it.
  const names = [...new Set([...diffs.values()].flatMap((diff) => diff.files.flatMap((file) => [file.path, file.previousPath ?? file.path])))]
  const stamps = placed.flatMap(({ tree }) => tree.kind === 'feature-dir' ? names.map((name) => suiteStamp(suiteDir, suiteRelativePath(tree, name))) : [])
  const key = memoKey(runDir, iteration, [...diffs.values()].map((diff) => diff.text), manifest, feature, placed.map(({ tree }) => tree), stamps)
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
      ...(rel !== null && manifest ? { executed: execution(manifest, rel, file.blobs?.after, current) } : {}),
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

/** A suite edit ran only when the run executed the live suite, or copied the
 * edited file into its suite copy and reran. An adoption after the cycle's
 * journal entry copied the live file with the edit in it; the test-heal rule
 * adopts just after that entry. A person may adopt before the entry is
 * written, while the cycle is still open: that adoption counts only when it
 * is the copy's latest re-take, made within the cycle, and the copy still
 * holds this cycle's after version. */
function execution(manifest: RunManifest, rel: string, afterBlob: string | undefined, cycle: CycleDiff): CycleFileExecution {
  if (manifest.suiteSnapshot?.kind !== 'taken') return { kind: 'live' }
  const adoptions = manifest.specEdits?.adopted ?? []
  const adopted = (entry: (typeof adoptions)[number]): CycleFileExecution => ({ kind: 'adopted', by: entry.by, at: entry.at })
  const ended = cycle.timestamp ? Date.parse(cycle.timestamp) : Number.NaN
  const later = [...adoptions].reverse().find((entry) => entry.files.includes(rel) && Date.parse(entry.at) >= ended)
  if (later) return adopted(later)
  const latest = adoptions.at(-1)
  const opened = Date.parse(cycle.previousTimestamp ?? manifest.startedAt)
  if (latest?.files.includes(rel) && Date.parse(latest.at) >= opened && suiteHolds(manifest.suiteSnapshot.dir, rel, afterBlob)) return adopted(latest)
  return { kind: 'inert' }
}

/** Whether the suite copy's file is the version a blob id names; the zero id
 * names an absent file. */
function suiteHolds(suiteDir: string, rel: string, sha: string | undefined): boolean {
  if (!sha) return false
  try {
    const file = confinedFile(suiteDir, rel)
    if (isZeroBlob(sha)) return !fs.existsSync(file)
    return matchesBlob(gitBlobSha1(fs.readFileSync(file)), sha)
  } catch {
    // Absent from the copy, or outside it: the copy does not hold this version.
    return false
  }
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

function memoKey(runDir: string, iteration: number, diffs: string[], manifest: RunManifest | null, feature: FeatureConfig | undefined, trees: CycleTree[], stamps: Array<number | null>): string {
  return createHash('sha1').update(JSON.stringify([
    runDir, iteration, diffs, trees, stamps, feature?.semanticRules ?? null,
    manifest && [manifest.startedAt, manifest.featureDir, manifest.repoPaths, manifest.worktrees, manifest.suiteSnapshot, manifest.specEdits?.adopted],
  ])).digest('hex')
}
