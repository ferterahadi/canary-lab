import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { listSpecFiles } from '../../../../shared/feature-loader'
import { extractTestMetadataFromSource, extractTestPredicatesFromSource } from '../../../../shared/ast-extractor'
import { getGitRoot, runGit } from '../../../../shared/git-repo'
import { diffSpecPredicates } from '../../../../shared/verification-strength/differential'
import type { SpecDiff } from '../../../../../../../shared/verification-strength/types'

// Test-file integrity detection. Canary Lab's promise is that a verdict stays
// outside the agent's control; the threat is the heal agent silently editing a
// *.spec.ts so a failing test goes green. Detection is content-hash based:
// every spec is hashed and compared to a baseline. mtime/fs-watch is only a
// recompute *trigger* upstream — never the truth. A file's dirty/clean status is
// still whole-file (any byte change marks the file), but `affectedTests` narrows
// to the individual test(s) whose own body actually changed — see `computeDirty`.

// rel-path (relative to featureDir) -> sha256 of the spec content. Also reused,
// with a `${rel}::${testName}` key, for per-test body hashes below.
export type SpecHashes = Record<string, string>

export interface SpecInfo {
  /** Path relative to the feature dir, e.g. `e2e/voucher.spec.ts`. Stable across
   *  the main checkout and a worktree copy, so it keys the dirty record. */
  rel: string
  abs: string
  /** Test titles declared in the file. */
  tests: string[]
}

function testHashKey(rel: string, testName: string): string {
  return `${rel}::${testName}`
}

export interface DirtyBaseline {
  /** Promoted only from an untampered passing run — the attested green content. */
  lastGreenHashes: SpecHashes
  /** Captured at run start — fallback baseline when the feature has no green yet. */
  runStartHashes: SpecHashes
  /** Set when the user approves the current content in Canary. */
  approvedHashes: SpecHashes
  /** Per-test counterparts of the three baselines above, keyed by `${rel}::${testName}`
   *  (see `testHashKey`) — lets a change be attributed to the test(s) actually edited
   *  instead of every test in the file. */
  lastGreenTestHashes?: SpecHashes
  runStartTestHashes?: SpecHashes
  approvedTestHashes?: SpecHashes
  /** Directory holding the run-start copy of the suite (the D9 snapshot), when
   *  one was taken. Supplies the before-side *content* for the strength verdict;
   *  the hashes above can say "changed" but not "changed how". */
  runStartSourceDir?: string
}

/** The verification-strength differential for one dirty spec: the assertion set
 *  before the edit against the assertion set now. An advisory hint, never a gate
 *  (D13) — `weaker` and `unclassifiable` are what a reader is told about. */
export interface SpecStrength extends SpecDiff {
  /** Where the before-side content came from: the run-start copy, or the
   *  committed spec when no copy holds this file. */
  baseline: 'run-start' | 'head'
}

export interface DirtySpec {
  file: string
  affectedTests: string[]
  /** Absent when no baseline content is readable (a hash-only legacy record,
   *  an untracked file with no run-start copy) — the file is still dirty. */
  strength?: SpecStrength
}

export interface DirtyResult {
  status: 'clean' | 'dirty'
  dirtySpecs: DirtySpec[]
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

// List the feature's specs with their declared test titles. Unreadable files
// contribute an empty test list rather than throwing — a half-written spec must
// not crash detection.
export function listFeatureSpecs(featureDir: string): SpecInfo[] {
  return listSpecFiles(featureDir).map((abs) => {
    let source = ''
    try {
      source = fs.readFileSync(abs, 'utf8')
    } catch {
      /* unreadable spec → no tests */
    }
    const { tests } = extractTestMetadataFromSource(abs, source)
    return { rel: path.relative(featureDir, abs), abs, tests: tests.map((t) => t.name) }
  })
}

// Every readable spec's content under the feature dir, keyed by rel path. A
// missing / unreadable spec contributes no entry (callers treat absence as
// "nothing to attest" rather than a phantom change).
function readSpecSources(featureDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const abs of listSpecFiles(featureDir)) {
    try {
      out[path.relative(featureDir, abs)] = fs.readFileSync(abs, 'utf8')
    } catch {
      /* missing/unreadable spec contributes no content */
    }
  }
  return out
}

function hashSources(sources: Record<string, string>): SpecHashes {
  return Object.fromEntries(Object.entries(sources).map(([rel, source]) => [rel, hashContent(source)]))
}

// Content-hash every spec under the feature dir, keyed by rel path.
export function hashFeatureSpecs(featureDir: string): SpecHashes {
  return hashSources(readSpecSources(featureDir))
}

// Hash of each individual test's body (via the same AST extractor used for
// display), keyed `${rel}::${testName}`. Lets a divergence be attributed to the
// test(s) actually edited rather than every test declared in the file.
function hashTestBodies(rel: string, source: string): SpecHashes {
  const out: SpecHashes = {}
  const { tests } = extractTestMetadataFromSource(rel, source)
  for (const t of tests) out[testHashKey(rel, t.name)] = hashContent(t.bodySource)
  return out
}

export function hashFeatureSpecTests(featureDir: string): SpecHashes {
  const out: SpecHashes = {}
  for (const abs of listSpecFiles(featureDir)) {
    const rel = path.relative(featureDir, abs)
    try {
      Object.assign(out, hashTestBodies(rel, fs.readFileSync(abs, 'utf8')))
    } catch {
      /* missing/unreadable spec contributes no hash */
    }
  }
  return out
}

// Hash of each spec's *committed* (HEAD) content, plus the same per-test
// breakdown, keyed the same way as the live hashes. Used as the bootstrap
// baseline and — critically — as the "committed → on the record" clean
// override: once a change is committed, the working tree matches HEAD and the
// cue clears even if the stale green/run-start baselines still hold the
// pre-edit content.
async function headSpecHashes(
  featureDir: string,
  rels: string[],
): Promise<{ file: SpecHashes; tests: SpecHashes; sources: Record<string, string> }> {
  const root = await getGitRoot(featureDir)
  if (!root) return { file: {}, tests: {}, sources: {} }
  // `getGitRoot` returns a realpath'd toplevel; realpath the feature dir too so
  // the repo-relative path is correct even when featureDir traverses a symlink
  // (e.g. macOS /var → /private/var). A mismatch yields a `../../` path and
  // `git show HEAD:` fails — which would silently read as "not committed".
  let realFeatureDir = featureDir
  try {
    realFeatureDir = fs.realpathSync(featureDir)
  } catch {
    /* feature dir gone — no HEAD hashes */
  }
  const file: SpecHashes = {}
  const tests: SpecHashes = {}
  const sources: Record<string, string> = {}
  for (const rel of rels) {
    const repoRel = path.relative(root, path.join(realFeatureDir, rel))
    const res = await runGit(root, ['show', `HEAD:${repoRel}`])
    if (res.code === 0) {
      file[rel] = hashContent(res.stdout)
      sources[rel] = res.stdout
      Object.assign(tests, hashTestBodies(rel, res.stdout))
    }
  }
  return { file, tests, sources }
}

// The before side of a dirty spec's strength verdict: the run-start copy when it
// holds the file, else the committed content. Absent when neither does.
function baselineSource(
  rel: string,
  runStartSourceDir: string | undefined,
  headSource: string | undefined,
): { source: string; baseline: SpecStrength['baseline'] } | undefined {
  if (runStartSourceDir) {
    try {
      return { source: fs.readFileSync(path.join(runStartSourceDir, rel), 'utf8'), baseline: 'run-start' }
    } catch {
      /* copy no longer holds this spec (or was never taken for it) — fall through to HEAD */
    }
  }
  if (headSource !== undefined) return { source: headSource, baseline: 'head' }
  return undefined
}

function specStrength(
  rel: string,
  after: string,
  runStartSourceDir: string | undefined,
  headSource: string | undefined,
): SpecStrength | undefined {
  const before = baselineSource(rel, runStartSourceDir, headSource)
  if (!before) return undefined
  const diff = diffSpecPredicates(
    extractTestPredicatesFromSource(rel, before.source),
    extractTestPredicatesFromSource(rel, after),
  )
  return { ...diff, baseline: before.baseline }
}

// Whether a single hash (current vs. head/approved/attest) reads as clean —
// shared by the whole-file and per-test checks below.
function isCleanAgainst(cur: string, head: string | undefined, approved: string | undefined, attest: string | undefined): boolean {
  return (
    (head !== undefined && cur === head) ||
    (approved !== undefined && cur === approved) ||
    (attest !== undefined && cur === attest)
  )
}

// A spec is dirty when its current content matches NONE of:
//  • HEAD content        — committed → on the git record (clears regardless of stale baselines)
//  • the approved hash    — user explicitly approved this content in Canary
//  • the attestation base — lastGreen ?? runStart ?? HEAD (what the test should be)
// A spec with no baseline at all (untracked, never run, never approved) is treated
// as clean — there is nothing yet to diverge from; the next run captures run-start.
//
// Within a dirty file, `affectedTests` narrows to the test(s) whose own body hash
// diverges the same way (same three-tier baseline, at test granularity). If none
// of the individual tests diverge — the edit touched something outside any test
// body, e.g. an import or a shared helper — attribution falls back to every test
// in the file, since the change can't be pinned to one and still needs flagging.
export async function computeDirty(featureDir: string, baseline: DirtyBaseline): Promise<DirtyResult> {
  const specs = listFeatureSpecs(featureDir)
  const sources = readSpecSources(featureDir)
  const current = hashSources(sources)
  const currentTests = hashFeatureSpecTests(featureDir)
  const heads = await headSpecHashes(featureDir, specs.map((s) => s.rel))
  const greenTests = baseline.lastGreenTestHashes ?? {}
  const runStartTests = baseline.runStartTestHashes ?? {}
  const approvedTests = baseline.approvedTestHashes ?? {}
  const dirtySpecs: DirtySpec[] = []
  for (const spec of specs) {
    const cur = current[spec.rel]
    if (!cur) continue
    const head = heads.file[spec.rel]
    const approved = baseline.approvedHashes[spec.rel]
    const attest = baseline.lastGreenHashes[spec.rel] ?? baseline.runStartHashes[spec.rel] ?? head
    if (attest === undefined && approved === undefined && head === undefined) continue
    if (isCleanAgainst(cur, head, approved, attest)) continue

    const perTestDirty = spec.tests.filter((name) => {
      const key = testHashKey(spec.rel, name)
      const testCur = currentTests[key]
      if (testCur === undefined) return true // parse mismatch — nothing to attribute to, flag defensively
      const testHead = heads.tests[key]
      const testApproved = approvedTests[key]
      const testAttest = greenTests[key] ?? runStartTests[key] ?? testHead
      // The file already has SOME baseline (checked above) but this test doesn't —
      // it's new since the last attestation, so it's exactly what changed.
      if (testAttest === undefined && testApproved === undefined && testHead === undefined) return true
      return !isCleanAgainst(testCur, testHead, testApproved, testAttest)
    })
    const strength = specStrength(spec.rel, sources[spec.rel], baseline.runStartSourceDir, heads.sources[spec.rel])
    dirtySpecs.push({
      file: spec.rel,
      affectedTests: perTestDirty.length > 0 ? perTestDirty : spec.tests,
      ...(strength ? { strength } : {}),
    })
  }
  return { status: dirtySpecs.length ? 'dirty' : 'clean', dirtySpecs }
}

// Promote run-start hashes to the green baseline for specs that were NOT modified
// during the run (`verdict === runStart`). A spec tampered with mid-run is left
// out, so a tampered-but-passing spec can never bless its own change. Only ever
// called for a passing run; failed/aborted runs never touch the green baseline.
export function promoteGreen(
  runStartHashes: SpecHashes,
  verdictHashes: SpecHashes,
  prevGreen: SpecHashes,
): SpecHashes {
  const next: SpecHashes = { ...prevGreen }
  for (const [rel, startHash] of Object.entries(runStartHashes)) {
    if (verdictHashes[rel] === startHash) next[rel] = startHash
  }
  return next
}
