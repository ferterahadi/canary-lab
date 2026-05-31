import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FeatureConfig, RepoPrerequisite } from '../../../shared/launcher/types'

export interface GitStatus {
  isGitRepo: boolean
  currentBranch: string | null
  detached: boolean
  dirty: boolean
  dirtyFiles: string[]
  localBranches: string[]
  remoteBranches: string[]
}

export interface RepoBranchSnapshot {
  name: string
  path: string
  branch: string | null
  expectedBranch?: string
  detached: boolean
  dirty: boolean
}

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd }, (error, stdout, stderr) => {
      const code = typeof (error as { code?: unknown } | null)?.code === 'number'
        ? (error as { code: number }).code
        : error
          ? 1
          : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
    child.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }))
  })
}

export function resolveRepoPath(localPath: string): string {
  if (localPath === '~') return os.homedir()
  if (localPath.startsWith('~/')) return path.join(os.homedir(), localPath.slice(2))
  return localPath
}

export function parsePorcelainStatus(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
}

export function parseRefList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function safeBranchName(branch: string): boolean {
  return branch.length > 0
    && !branch.startsWith('-')
    && !branch.includes('\0')
    && !branch.includes('\n')
    && !branch.includes('\r')
}

export async function getGitStatus(repoPath: string): Promise<GitStatus> {
  const target = resolveRepoPath(repoPath)
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return emptyGitStatus()
  }

  const inside = await runGit(target, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return emptyGitStatus()
  }

  const [branch, status, locals, remotes] = await Promise.all([
    runGit(target, ['branch', '--show-current']),
    runGit(target, ['status', '--porcelain']),
    runGit(target, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    runGit(target, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
  ])

  const currentBranch = branch.stdout.trim() || null
  const dirtyFiles = parsePorcelainStatus(status.stdout)
  return {
    isGitRepo: true,
    currentBranch,
    detached: currentBranch === null,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    localBranches: parseRefList(locals.stdout),
    remoteBranches: parseRefList(remotes.stdout).filter((ref) => !ref.endsWith('/HEAD')),
  }
}

export async function checkoutBranch(repoPath: string, branch: string): Promise<GitStatus> {
  const target = resolveRepoPath(repoPath)
  if (!safeBranchName(branch)) {
    throw Object.assign(new Error('branch must be a non-empty branch name'), { statusCode: 400 })
  }

  const status = await getGitStatus(target)
  if (!status.isGitRepo) {
    throw Object.assign(new Error('path is not a git repository'), { statusCode: 400 })
  }
  if (status.dirty) {
    throw Object.assign(new Error('repo has uncommitted changes'), { statusCode: 409 })
  }
  if (status.currentBranch === branch) return status

  const result = await runGit(target, ['checkout', branch])
  if (result.code !== 0) {
    throw Object.assign(
      new Error((result.stderr || result.stdout).trim() || 'git checkout failed'),
      { statusCode: 500 },
    )
  }
  return getGitStatus(target)
}

export async function collectRepoBranchSnapshots(feature: FeatureConfig): Promise<RepoBranchSnapshot[]> {
  const out: RepoBranchSnapshot[] = []
  for (const repo of feature.repos ?? []) {
    const localPath = repo.localPath
    if (typeof localPath !== 'string') continue
    const repoPath = resolveRepoPath(localPath)
    const status = await getGitStatus(repoPath)
    if (!status.isGitRepo) continue
    out.push({
      name: repo.name,
      path: repoPath,
      branch: status.currentBranch,
      expectedBranch: repo.branch,
      detached: status.detached,
      dirty: status.dirty,
    })
  }
  return out
}

export async function validateConfiguredRepoBranches(feature: FeatureConfig): Promise<void> {
  const failures: string[] = []
  for (const repo of feature.repos ?? []) {
    const expected = repo.branch
    if (!expected) continue
    const localPath = repo.localPath
    if (typeof localPath !== 'string') continue
    const repoPath = resolveRepoPath(localPath)
    const status = await getGitStatus(repoPath)
    if (!status.isGitRepo) {
      failures.push(`${repo.name}: ${repoPath} is not a git repository`)
      continue
    }
    if (status.detached) {
      failures.push(`${repo.name}: expected ${expected}, but checkout is detached`)
      continue
    }
    if (status.currentBranch !== expected) {
      failures.push(`${repo.name}: expected ${expected}, current ${status.currentBranch}`)
    }
  }
  if (failures.length > 0) {
    throw Object.assign(
      new Error(`Repo branch check failed:\n${failures.join('\n')}`),
      { statusCode: 409 },
    )
  }
}

function emptyGitStatus(): GitStatus {
  return {
    isGitRepo: false,
    currentBranch: null,
    detached: false,
    dirty: false,
    dirtyFiles: [],
    localBranches: [],
    remoteBranches: [],
  }
}

// Resolve the absolute path to the git working-tree root for any directory
// inside a git repo. Returns null when the target isn't a git working tree
// (or doesn't exist). Useful when the orchestrator wants to diff a subtree
// (e.g., `feature.featureDir`) that lives inside a larger workspace repo —
// `git diff --name-only` always emits paths relative to the working-tree
// root, so callers need that root to convert back to absolute paths.
export async function getGitRoot(targetPath: string): Promise<string | null> {
  const target = resolveRepoPath(targetPath)
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return null
  const result = await runGit(target, ['rev-parse', '--show-toplevel'])
  if (result.code !== 0) return null
  const root = result.stdout.trim()
  return root.length > 0 ? root : null
}

// Snapshot the working tree (tracked files only) and return a ref the caller
// can later `git diff` against. Used by the heal loop to isolate the agent's
// edit window from pre-existing dirty state: snapshot before the agent edits,
// diff after the signal arrives, and the result is exactly what changed during
// the agent's turn — pre-existing WIP doesn't leak in.
//
// `git stash create` builds a dangling tree+commit object without touching the
// stash list, index, or working tree. The returned SHA is reference-only; git
// GCs it once unreachable, so there's nothing to clean up. When the tree was
// clean at snapshot time, stash create prints nothing — we fall back to HEAD,
// which gives equivalent diff semantics for a clean baseline.
export async function snapshotWorkingTree(repoPath: string): Promise<string | null> {
  const target = resolveRepoPath(repoPath)
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return null
  const inside = await runGit(target, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null
  const stash = await runGit(target, ['stash', 'create'])
  if (stash.code !== 0) return null
  const sha = stash.stdout.trim()
  return sha.length > 0 ? sha : 'HEAD'
}

// Optional pathspecs accepted by both diff helpers. Each entry is either
// repo-relative or absolute (auto-converted relative to `repoPath`), and may
// use git's `:(exclude)<path>` magic prefix to exclude a subtree. When the
// `pathspecs` array is set and non-empty, it scopes the diff to those paths;
// when unset/empty, the diff covers the entire working tree (legacy behavior).
//
// Used by the heal loop to diff the feature directory (a subtree of the
// workspace repo) while excluding service-repo subtrees that are diffed
// separately on their own snapshot — prevents double-counting.
export type DiffPathspec = string

function buildPathspecArgs(repoPath: string, pathspecs?: readonly DiffPathspec[]): string[] {
  if (!pathspecs || pathspecs.length === 0) return []
  const args: string[] = ['--']
  for (const raw of pathspecs) {
    args.push(repoRelativePathspec(repoPath, raw))
  }
  return args
}

// Preserve git's `:(exclude)<path>` (or `:!<path>`) magic prefix while
// converting the trailing path portion to a repo-relative path when it was
// supplied as an absolute path. Callers can mix relative and absolute freely.
function repoRelativePathspec(repoPath: string, raw: DiffPathspec): string {
  const magicMatch = raw.match(/^(:\([^)]+\)|:!)(.*)$/)
  const prefix = magicMatch?.[1] ?? ''
  const body = magicMatch?.[2] ?? raw
  if (body.length === 0) return raw
  const rel = path.isAbsolute(body) ? path.relative(repoPath, body) : body
  return prefix + rel
}

export async function diffNamesSinceSnapshot(
  repoPath: string,
  ref: string,
  pathspecs?: readonly DiffPathspec[],
): Promise<string[]> {
  const target = resolveRepoPath(repoPath)
  const result = await runGit(target, ['diff', '--name-only', ref, ...buildPathspecArgs(target, pathspecs)])
  if (result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

// Full unified-diff content (not just names) against a snapshot ref. Sibling
// to `diffNamesSinceSnapshot` — same defensive shape: empty string when git
// fails or there is nothing to diff. Callers must size-bound the result before
// persisting it; this function intentionally does no truncation.
export async function diffContentSinceSnapshot(
  repoPath: string,
  ref: string,
  pathspecs?: readonly DiffPathspec[],
): Promise<string> {
  const target = resolveRepoPath(repoPath)
  const result = await runGit(target, ['diff', ref, ...buildPathspecArgs(target, pathspecs)])
  if (result.code !== 0) return ''
  return result.stdout
}

export function findRepo(feature: FeatureConfig, name: string): RepoPrerequisite | null {
  return (feature.repos ?? []).find((repo) => repo.name === name) ?? null
}
