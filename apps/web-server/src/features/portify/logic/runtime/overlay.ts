import fs from 'fs'
import path from 'path'
import { runGit } from '../../../orchestration/logic/git-repo'
import type { HealAgent } from '../../../orchestration/logic/runtime/auto-heal'

// The ephemeral port overlay: a captured set of unified diffs (one per product
// repo) that make a feature's services read canary-lab-injected ports. Unlike
// the old commit/merge flow, the overlay is NEVER landed in the target repo's
// history — it lives in the feature directory and is `git apply`-ed into a
// per-run worktree before boot, then reverse-applied (`git apply -R`) at
// teardown. The target repo stays pristine.
//
// On-disk layout under `<featureDir>/portify/`:
//   meta.json            — OverlayMeta (base SHAs, captured-at, touched-file
//                          hashes per repo, for staleness detection)
//   <repoName>.patch     — the unified diff for that repo (includes added files)

export const OVERLAY_VERSION = 1
export const OVERLAY_DIRNAME = 'portify'
export const OVERLAY_META_FILE = 'meta.json'

/** A file the overlay's patch modifies, with its blob hash at capture time. */
export interface OverlayTouchedFile {
  /** Repo-relative path. */
  path: string
  /** `git rev-parse <baseSha>:<path>` blob hash when the overlay was captured. */
  sha: string
}

export interface OverlayRepo {
  name: string
  /** HEAD the patch was captured against. */
  baseSha: string
  /** Patch filename, relative to the overlay dir. */
  patch: string
  /** Files that existed at capture and the patch modifies (drives staleness). */
  touchedFiles: OverlayTouchedFile[]
}

export interface OverlayMeta {
  version: number
  featureName: string
  agent: HealAgent
  /** ISO timestamp the overlay was captured. */
  capturedAt: string
  repos: OverlayRepo[]
}

/** A repo's diff + the facts needed to write its overlay entry. */
export interface OverlayRepoInput {
  name: string
  baseSha: string
  /** Unified diff content (as produced by `captureDiff`). */
  patch: string
  touchedFiles: OverlayTouchedFile[]
}

export interface WriteOverlayInput {
  featureName: string
  agent: HealAgent
  capturedAt: string
  repos: OverlayRepoInput[]
}

/** The overlay read back off disk: meta + each repo's patch content. */
export interface LoadedOverlay {
  meta: OverlayMeta
  /** Repo name → unified diff content. */
  patches: Record<string, string>
}

export interface StalenessResult {
  stale: boolean
  /** Repo-relative paths whose blob hash drifted (or that vanished) since capture. */
  changedFiles: { repo: string; path: string }[]
}

export function overlayDir(featureDir: string): string {
  return path.join(featureDir, OVERLAY_DIRNAME)
}

function metaPath(featureDir: string): string {
  return path.join(overlayDir(featureDir), OVERLAY_META_FILE)
}

/** Filesystem-safe patch filename for a repo. */
export function patchFileName(repoName: string): string {
  const slug = repoName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
  return `${slug}.patch`
}

/** A verified overlay exists for this feature (meta present with ≥1 repo). */
export function overlayExists(featureDir: string): boolean {
  const meta = readMeta(featureDir)
  return Boolean(meta && meta.repos.length > 0)
}

function readMeta(featureDir: string): OverlayMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath(featureDir), 'utf-8')) as OverlayMeta
    if (!parsed || !Array.isArray(parsed.repos)) return null
    return parsed
  } catch {
    return null
  }
}

function atomicWrite(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
}

/**
 * Persist the overlay: one `.patch` per repo plus `meta.json`. Repos with an
 * empty patch are still recorded (their app already honored the injected port —
 * only out-of-worktree config changed), so staleness + apply stay per-repo.
 * Overwrites any prior overlay for this feature.
 */
export function writeOverlay(featureDir: string, input: WriteOverlayInput): OverlayMeta {
  const dir = overlayDir(featureDir)
  // Clear stale patch files from a prior overlay so a now-empty repo doesn't
  // leave a dangling patch behind.
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.patch')) fs.rmSync(path.join(dir, f), { force: true })
    }
  } catch { /* dir may not exist yet */ }

  const repos: OverlayRepo[] = input.repos.map((r) => {
    const patch = patchFileName(r.name)
    atomicWrite(path.join(dir, patch), r.patch)
    return { name: r.name, baseSha: r.baseSha, patch, touchedFiles: r.touchedFiles }
  })
  const meta: OverlayMeta = {
    version: OVERLAY_VERSION,
    featureName: input.featureName,
    agent: input.agent,
    capturedAt: input.capturedAt,
    repos,
  }
  atomicWrite(metaPath(featureDir), JSON.stringify(meta, null, 2) + '\n')
  return meta
}

/** Read the overlay back: meta + each repo's patch content. Null if absent. */
export function readOverlay(featureDir: string): LoadedOverlay | null {
  const meta = readMeta(featureDir)
  if (!meta || meta.repos.length === 0) return null
  const dir = overlayDir(featureDir)
  const patches: Record<string, string> = {}
  for (const repo of meta.repos) {
    try {
      patches[repo.name] = fs.readFileSync(path.join(dir, repo.patch), 'utf-8')
    } catch {
      // A missing patch file is a corrupt overlay — surface as no overlay.
      return null
    }
  }
  return { meta, patches }
}

/** Remove the entire overlay directory for a feature. Best-effort. */
export function removeOverlay(featureDir: string): void {
  try { fs.rmSync(overlayDir(featureDir), { recursive: true, force: true }) } catch { /* best-effort */ }
}

/**
 * Blob hash of `<rev>:<path>` in `repoRoot`, or null when the path doesn't
 * exist at that rev. Used both to record touched-file hashes at capture and to
 * re-check them for staleness.
 */
export async function blobShaAt(repoRoot: string, rev: string, relPath: string): Promise<string | null> {
  const res = await runGit(repoRoot, ['rev-parse', `${rev}:${relPath}`])
  if (res.code !== 0) return null
  return res.stdout.trim()
}

/** Build touched-file records for a repo from a list of changed paths. */
export async function captureTouchedFiles(
  repoRoot: string,
  baseSha: string,
  files: string[],
): Promise<OverlayTouchedFile[]> {
  const out: OverlayTouchedFile[] = []
  for (const p of files) {
    const sha = await blobShaAt(repoRoot, baseSha, p)
    // Only files that existed at base drive staleness; added files are created
    // by the patch and have no base blob to drift.
    if (sha) out.push({ path: p, sha })
  }
  return out
}

/**
 * Compare each recorded touched-file blob hash against the repo's CURRENT HEAD.
 * A drifted or vanished file means the captured patch may no longer apply —
 * the caller must refuse to boot un-portified and prompt a re-run of Portify.
 *
 * `repoRoots` maps repo name → git root. Repos absent from the map are skipped
 * (caller couldn't resolve them; apply will fail loudly instead).
 */
export async function checkStaleness(
  featureDir: string,
  repoRoots: Record<string, string>,
): Promise<StalenessResult> {
  const meta = readMeta(featureDir)
  if (!meta) return { stale: false, changedFiles: [] }
  const changedFiles: { repo: string; path: string }[] = []
  for (const repo of meta.repos) {
    const root = repoRoots[repo.name]
    if (!root) continue
    for (const tf of repo.touchedFiles) {
      const current = await blobShaAt(root, 'HEAD', tf.path)
      if (current !== tf.sha) changedFiles.push({ repo: repo.name, path: tf.path })
    }
  }
  return { stale: changedFiles.length > 0, changedFiles }
}
